#!/usr/bin/env node
'use strict';

// Casto Library — a lightweight, Plex-style personal media library. Point it
// at a folder; it serves a poster-grid web UI you browse in any browser (or
// inside Casto Browser), plays files inline, and casts any item to a DLNA TV.
//
//   node library.js <media-folder> [--port <n>] [--host <lan-ip>]
//
// Open the printed URL. No account, no database, no transcoding — just your
// files, with posters, and a Cast button.

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { URL } = require('url');
const podcasts = require('./podcast-core'); // Podcasts content-type for the hub

// Keep the Mac awake while serving so streams don't pause on sleep. caffeinate
// -w <pid> exits automatically when this process does.
function preventSleep() {
  if (process.platform !== 'darwin') return;
  try {
    require('child_process')
      .spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true })
      .unref();
  } catch (_) {}
}

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DLNA_FEATURES =
  'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
const CONTENT_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.3gp': 'video/3gpp',
};
const VIDEO_EXTS = Object.keys(CONTENT_TYPES);
const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.wma': 'audio/x-ms-wma',
};
const AUDIO_EXTS = Object.keys(AUDIO_TYPES);
const MEDIA_TYPES = { ...CONTENT_TYPES, ...AUDIO_TYPES };
const MEDIA_EXTS = Object.keys(MEDIA_TYPES);
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const IMAGE_EXTS = Object.keys(IMAGE_TYPES);
const POSTER_NAMES = ['poster', 'folder', 'cover', 'thumb'];

// Content-type ("kind") classification for the unified hub. Audio → music.
// Video → tv if it looks episodic (SxxExx / "Season N" / 1x02 / "Episode N"),
// else movie. It's a heuristic — no metadata provider — but a good-enough split
// for filter chips. Podcasts are a separate, feed-sourced kind (not files).
const TV_PATTERN = /\bS\d{1,2}\s?E\d{1,2}\b|\b\d{1,2}x\d{2}\b|\bseason\s*\d+\b|\bepisode\s*\d+\b/i;

// Pull {season, episode} out of a name. Handles SxxExx (and ranges like
// S01E02E03 → first), 1x02, "Season 1 … Episode 2", and a bare "Episode 2"
// (season 0). Returns null when nothing episodic is found.
function episodeInfo(name) {
  let m = name.match(/\bS(\d{1,3})\s?E(\d{1,3})(?:\s?E\d{1,3})?\b/i);
  if (m) return { season: +m[1], episode: +m[2] };
  m = name.match(/\b(\d{1,2})x(\d{2,3})\b/);
  if (m) return { season: +m[1], episode: +m[2] };
  m = name.match(/season\s*(\d{1,3})[^]*?episode\s*(\d{1,3})/i);
  if (m) return { season: +m[1], episode: +m[2] };
  m = name.match(/\bep(?:isode)?\.?\s?(\d{1,3})\b/i);
  if (m) return { season: 0, episode: +m[1] };
  return null;
}

function mediaKind(ext, relPath) {
  if (AUDIO_EXTS.includes(ext)) return 'music';
  return (episodeInfo(relPath) || TV_PATTERN.test(relPath)) ? 'tv' : 'movie';
}

function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'eth0', 'wlan0', ...Object.keys(ifaces)]) {
    for (const a of ifaces[name] || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// --- Lazy, non-blocking indexing -------------------------------------------
// Folders are scanned one level at a time, on demand (browse) or by a
// background crawl. Scanning uses async readdir and resolves posters from the
// directory listing we already have (no per-file fs), so it never blocks the
// event loop — even on a huge external drive.

const fsp = fs.promises;

// Find a folder-level poster (poster/folder/cover/thumb.*) from a Set of the
// folder's own filenames — no filesystem hit.
function folderPoster(dir, names) {
  for (const nm of POSTER_NAMES)
    for (const ext of IMAGE_EXTS)
      if (names.has(nm + ext)) return path.join(dir, nm + ext);
  return null;
}

function makeRoot(root, config) {
  // art is filled when the root is first scanned (from its own listing).
  return { id: '0', parentId: '-1', container: true, title: config.titles[''] || path.basename(root) || 'Library', path: root, art: null, children: [], scanned: false };
}

// Scan one folder level into `ctx.map`. Async, and posters come from the
// already-read directory entries — so a folder of thousands of files costs a
// single readdir, not thousands of stat/exists calls.
async function scanDirInto(ctx, node, root, config) {
  if (node.scanned) return;
  node.scanned = true;
  node.children = [];
  let entries = [];
  try { entries = await fsp.readdir(node.path, { withFileTypes: true }); } catch (_) { return; }
  const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  if (!node.art) node.art = folderPoster(node.path, fileNames);

  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.isFile() && MEDIA_EXTS.includes(path.extname(e.name).toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));

  for (const d of dirs) {
    const dp = path.join(node.path, d.name);
    const rel = path.relative(root, dp);
    if (config.removed.includes(rel)) continue;
    const id = String(ctx.nextId++);
    ctx.map.set(id, { id, parentId: node.id, container: true, title: config.titles[rel] || d.name, path: dp, art: null, children: [], scanned: false });
    node.children.push(id);
  }
  for (const f of files) {
    const fp = path.join(node.path, f.name);
    const rel = path.relative(root, fp);
    if (config.removed.includes(rel)) continue;
    const ext = path.extname(f.name).toLowerCase();
    const base = path.basename(f.name, ext);
    let art = null;
    for (const ie of IMAGE_EXTS) if (fileNames.has(base + ie)) { art = path.join(node.path, base + ie); break; }
    if (!art) art = node.art; // fall back to the folder poster
    const id = String(ctx.nextId++);
    const kind = mediaKind(ext, rel);
    // Detect season/episode from the filename first, then the folder path.
    const epi = kind === 'tv' ? (episodeInfo(f.name) || episodeInfo(rel)) : null;
    ctx.map.set(id, { id, parentId: node.id, container: false, title: config.titles[rel] || base, file: fp, contentType: MEDIA_TYPES[ext] || 'video/mp4', kind, season: epi ? epi.season : undefined, episode: epi ? epi.episode : undefined, art });
    node.children.push(id);
  }
}

// Build the whole tree into a fresh map, yielding between folders.
async function buildAsync(root, config) {
  const ctx = { map: new Map(), nextId: 1 };
  const rootNode = makeRoot(root, config);
  ctx.map.set('0', rootNode);
  const queue = [rootNode];
  while (queue.length) {
    const node = queue.shift();
    await scanDirInto(ctx, node, root, config);
    for (const cid of node.children) { const c = ctx.map.get(cid); if (c && c.container) queue.push(c); }
    await new Promise((r) => setImmediate(r));
  }
  return ctx.map;
}

// --- Saving a poster (drag-and-drop / split-screen capture) ----------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { req.destroy(); reject(new Error('image too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  try { return JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}'); } catch (_) { return {}; }
}
function extForType(ct, src) {
  ct = (ct || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  const m = /\.(png|webp|jpe?g)(?:[?#]|$)/i.exec(src || '');
  return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.jpg';
}
// Download a dragged image URL (follows one redirect), capped at 10 MB.
function fetchImage(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Casto' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        res.resume();
        return resolve(fetchImage(new URL(res.headers.location, url).href, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('image HTTP ' + res.statusCode)); }
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 10 * 1024 * 1024) { res.destroy(); reject(new Error('image too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

// --- DLNA cast (for the "Cast to TV" button) -------------------------------

function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const m = (st) => Buffer.from('M-SEARCH * HTTP/1.1\r\n' + `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` + 'MAN: "ssdp:discover"\r\nMX: 2\r\n' + `ST: ${st}\r\n\r\n`);
    sock.on('message', (msg) => {
      const t = msg.toString();
      if (!/AVTransport|MediaRenderer/i.test(t)) return;
      const loc = /^LOCATION:\s*(.+)$/im.exec(t);
      if (loc) found.set(loc[1].trim(), true);
    });
    sock.on('error', () => {});
    sock.bind(() => {
      const blast = () => ['urn:schemas-upnp-org:device:MediaRenderer:1', AVT].forEach((st) => { const p = m(st); sock.send(p, 0, p.length, SSDP_PORT, SSDP_ADDR); });
      blast(); setTimeout(blast, 800);
    });
    setTimeout(() => { try { sock.close(); } catch (_) {} resolve([...found.keys()]); }, timeoutMs);
  });
}
function httpGet(u) {
  return new Promise((resolve, reject) => {
    const req = http.get(u, (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}
function parseDevice(xml, location) {
  if (!/urn:schemas-upnp-org:service:AVTransport/.test(xml)) return null;
  const name = (/<friendlyName>([^<]*)<\/friendlyName>/i.exec(xml) || [])[1] || 'Unknown';
  const base = (/<URLBase>([^<]*)<\/URLBase>/i.exec(xml) || [])[1] || location;
  for (const svc of xml.split(/<service>/i))
    if (/AVTransport/i.test(svc)) {
      const cu = /<controlURL>([^<]*)<\/controlURL>/i.exec(svc);
      if (cu) return { name: name.trim(), controlURL: new URL(cu[1].trim(), base).href };
    }
  return null;
}
async function findRenderers() {
  const out = [], seen = new Set();
  for (const loc of await discover()) {
    try { const d = parseDevice(await httpGet(loc), loc); if (d && !seen.has(d.controlURL)) { seen.add(d.controlURL); out.push(d); } } catch (_) {}
  }
  return out;
}
function soap(controlURL, action, body) {
  const env = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' + `<u:${action} xmlns:u="${AVT}">` + body + `</u:${action}></s:Body></s:Envelope>`;
  const u = new URL(controlURL);
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(env), SOAPAction: `"${AVT}#${action}"`, Connection: 'close' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`${action} ${res.statusCode}`)) : resolve(d))); });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('timeout'))); req.end(env);
  });
}
async function castTo(controlURL, url, title, contentType) {
  // Match the DIDL upnp:class to the media — audio-only renderers (soundbars,
  // AV receivers, networked speakers) reject a videoItem and need audioItem.
  const ct = String(contentType || '');
  const upnpClass = ct.startsWith('audio/') ? 'object.item.audioItem.musicTrack'
    : ct.startsWith('image/') ? 'object.item.imageItem.photo'
    : 'object.item.videoItem';
  const didl = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1">' + `<dc:title>${xmlEscape(title)}</dc:title><upnp:class>${upnpClass}</upnp:class>` + `<res protocolInfo="http-get:*:${contentType}:${DLNA_FEATURES}">${xmlEscape(url)}</res></item></DIDL-Lite>`;
  await soap(controlURL, 'SetAVTransportURI', `<InstanceID>0</InstanceID><CurrentURI>${xmlEscape(url)}</CurrentURI><CurrentURIMetaData>${xmlEscape(didl)}</CurrentURIMetaData>`);
  await soap(controlURL, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
}

const tx = {
  play: (c) => soap(c, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>'),
  pause: (c) => soap(c, 'Pause', '<InstanceID>0</InstanceID>'),
  stop: (c) => soap(c, 'Stop', '<InstanceID>0</InstanceID>'),
};
const hms = (s) => { s = Math.max(0, Math.floor(s)); const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0;
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
async function seekRel(controlURL, delta) {
  const info = await soap(controlURL, 'GetPositionInfo', '<InstanceID>0</InstanceID>');
  const t = (/<RelTime>([^<]*)<\/RelTime>/i.exec(info) || [])[1] || '0:00:00';
  const m = /(\d+):(\d+):(\d+)/.exec(t) || [0, 0, 0, 0];
  const cur = +m[1] * 3600 + +m[2] * 60 + +m[3];
  await soap(controlURL, 'Seek', `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${hms(cur + delta)}</Target>`);
}
// Current renderer transport state (PLAYING / PAUSED_PLAYBACK / STOPPED / …),
// used to detect when a cast track ends so we can auto-advance the queue.
async function transportState(controlURL) {
  const d = await soap(controlURL, 'GetTransportInfo', '<InstanceID>0</InstanceID>');
  return (/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i.exec(d) || [])[1] || '';
}

// --- File serving (Range) --------------------------------------------------

function serveFile(req, res, filePath, contentType) {
  let total;
  try { total = fs.statSync(filePath).size; } catch (_) { res.writeHead(404); return res.end('Not found'); }
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? +m[1] : 0;
    let end = m && m[2] ? +m[2] : total - 1;
    if (start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    if (end >= total) end = total - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': total });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }
}

// --- Web UI (New England wood theme) ---------------------------------------

function pageHTML(libraryName) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEscape(libraryName)} — Casto Library</title>
<style>
  :root{ --wood:#e9d6b0; --ink:#5b3a22; --sub:#6d5236; --accent:#2f4156; --card:#fbf1dd; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--wood);color:var(--ink);font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;align-items:center;gap:16px;padding:18px 24px;border-bottom:1px solid #c9ac74}
  header h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:34px;margin:0}
  #crumbs{font-size:13px;color:var(--sub);letter-spacing:.08em;text-transform:uppercase}
  #crumbs a{color:var(--accent);cursor:pointer;text-decoration:none}
  #q{font:inherit;padding:8px 12px;border-radius:20px;border:1px solid #c9ac74;background:var(--card);color:var(--ink);min-width:200px}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:20px;padding:24px}
  .card{background:var(--card);border-radius:10px;overflow:hidden;cursor:pointer;box-shadow:0 2px 8px rgba(60,40,15,.18);transition:transform .12s}
  .card:hover{transform:translateY(-3px)}
  .card.over{outline:3px dashed var(--accent);outline-offset:-3px}
  .thumb{position:relative;aspect-ratio:2/3;background:#d8c191;display:flex;align-items:center;justify-content:center;font-size:46px;color:#a07e4e;overflow:hidden}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .folder .thumb{aspect-ratio:2/3;font-size:54px}
  .findbtn{position:absolute;top:6px;right:6px;border:0;background:rgba(47,65,86,.85);color:#fff;border-radius:6px;padding:3px 7px;font-size:12px;cursor:pointer;display:none}
  .castbtn{right:auto;left:6px}
  .rmbtn{right:auto;left:6px}
  .renbtn{top:auto;bottom:6px;right:6px}
  .card:hover .findbtn{display:block}
  .card.off{opacity:.5;filter:grayscale(.5)}
  .badge{position:absolute;left:0;right:0;bottom:0;background:rgba(47,65,86,.92);color:#fff;font-size:12px;text-align:center;padding:4px}
  .label{padding:10px 12px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer}
  button.ghost{background:transparent;color:#f5e9cf;border:1px solid #f5e9cf}
  .chip{font:inherit;border:1px solid #f5e9cf;background:transparent;color:#f5e9cf;border-radius:20px;padding:7px 14px;cursor:pointer;margin:3px}
  .chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
  select{font:inherit;padding:8px;border-radius:8px}
  /* find-poster split panel */
  #finder{display:none;position:fixed;right:0;top:62px;bottom:0;width:42%;background:var(--card);border-left:2px solid var(--accent);flex-direction:column;padding:18px;gap:12px;z-index:5}
  body.split #grid{width:56%}
  .frow{display:flex;gap:10px;align-items:center}
  #finderTitle{font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;flex:1}
  #finderTitle b{color:var(--ink)}
  #dropzone{flex:1;border:3px dashed var(--accent);border-radius:12px;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--sub);padding:20px}
  #dropzone.over{background:#efe2c4}
  .hint{font-size:12px;color:var(--sub)}
  /* now-playing sessions manager */
  #nowp{position:fixed;inset:0;background:rgba(20,12,4,.6);display:none;align-items:center;justify-content:center;z-index:20}
  .npcard{background:var(--card);border-radius:12px;padding:18px 20px;min-width:440px;max-width:90vw;max-height:80vh;overflow:auto}
  .nprow{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #e0cfa6}
  .nprow button{padding:6px 10px}
  /* player overlay */
  #overlay{position:fixed;inset:0;background:rgba(20,12,4,.92);display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;z-index:10}
  #overlay video{max-width:90vw;max-height:72vh;background:#000;border-radius:8px}
  #overlay .row{display:flex;gap:10px;align-items:center}
  #ptitle{color:#f5e9cf;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px}
  /* content-type filter chips (the unified hub) */
  #types{display:flex;gap:6px;flex-wrap:wrap}
  #types .tchip{font:inherit;border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:20px;padding:7px 13px;cursor:pointer}
  #types .tchip.on{background:var(--accent);color:#fff}
  .card.music .thumb,.card.podcast .thumb{aspect-ratio:1/1}
  .label .se{display:inline-block;background:var(--accent);color:#fff;font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;margin-right:6px;vertical-align:1px}
  /* show detail / splash page (Plex/Jellyfin style) */
  #grid.show{display:block}
  .hero{display:flex;gap:22px;align-items:flex-start;margin-bottom:6px}
  .hero .poster{width:170px;height:255px;object-fit:cover;border-radius:12px;background:#d8c191;flex:none;display:flex;align-items:center;justify-content:center;font-size:60px;color:#a07e4e;box-shadow:0 3px 10px rgba(60,40,15,.22)}
  .hero h2{font-family:'Cormorant Garamond',Georgia,serif;font-size:38px;margin:0 0 6px;line-height:1.05}
  .hero .meta{color:var(--sub);font-size:14px;letter-spacing:.04em}
  .hero .seasons{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px}
  .schip{font:inherit;border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:20px;padding:7px 15px;cursor:pointer}
  .schip.on{background:var(--accent);color:#fff}
  .eplist{margin-top:18px;max-width:880px}
  .eprow{display:flex;align-items:center;flex-wrap:wrap;gap:14px;background:var(--card);border-radius:10px;padding:11px 15px;margin-top:9px;box-shadow:0 1px 4px rgba(60,40,15,.12)}
  .eprow.done .num{color:#2f6b3a}
  .eprow .erbar{flex-basis:100%;height:4px;background:#e0cfa6;border-radius:3px;overflow:hidden}
  .eprow .erbar>i{display:block;height:100%;background:var(--accent)}
  .heroplay{margin-top:16px;display:flex;gap:10px;align-items:center}
  .thumb .pbar{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(20,12,4,.35)}
  .thumb .pbar>i{display:block;height:100%;background:var(--accent)}
  /* Continue Watching row (home) */
  #continue{padding:0 24px}
  #continue h3{font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;margin:16px 0 4px}
  .crow{display:flex;gap:14px;overflow-x:auto;padding:6px 0 10px}
  .ccard{flex:0 0 168px;background:var(--card);border-radius:10px;overflow:hidden;cursor:pointer;box-shadow:0 2px 8px rgba(60,40,15,.18);transition:transform .12s}
  .ccard:hover{transform:translateY(-3px)}
  .ccard .ct{position:relative;aspect-ratio:16/9;background:#d8c191;display:flex;align-items:center;justify-content:center;font-size:30px;color:#a07e4e;overflow:hidden}
  .ccard .ct img{width:100%;height:100%;object-fit:cover}
  .ccard .ct .pbar{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(20,12,4,.35)}
  .ccard .ct .pbar>i{display:block;height:100%;background:var(--accent)}
  .ccard .cl{padding:8px 10px 0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ccard .cs{padding:1px 10px 9px;font-size:11px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .eprow .num{font-variant-numeric:tabular-nums;font-weight:700;color:var(--accent);min-width:38px;text-align:center;font-size:15px}
  .eprow .ttl{flex:1;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .eprow .seen{font-size:11px;color:var(--sub);border:1px solid var(--line,#c9ac74);border-radius:20px;padding:1px 8px}
  .eprow button{padding:7px 13px;font-size:13px;border-radius:8px}
  .eprow button.castb{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  #podRoot{padding:22px 24px;max-width:1100px;margin:0 auto}
  /* --- interface polish --- */
  button,.chip,.tchip,.schip,.card{transition:transform .12s, background .12s, color .12s, box-shadow .12s}
  button:active{transform:translateY(1px)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
  .card:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
  .label{line-height:1.25}
  /* loading + empty states */
  .msg{grid-column:1/-1;text-align:center;color:var(--sub);padding:60px 16px;font-size:15px}
  .msg .big{font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;color:var(--ink);display:block;margin-bottom:6px}
  .spin{display:inline-block;width:15px;height:15px;border:2px solid #c9ac74;border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px;margin-right:7px}
  @keyframes sp{to{transform:rotate(360deg)}}
  /* thin themed scrollbars on the horizontal strips */
  #types,.crow{scrollbar-width:thin;scrollbar-color:#c9ac74 transparent}
  #types::-webkit-scrollbar,.crow::-webkit-scrollbar{height:7px}
  #types::-webkit-scrollbar-thumb,.crow::-webkit-scrollbar-thumb{background:#c9ac74;border-radius:4px}
  /* touch devices have no hover: keep the Cast shortcut, drop admin buttons */
  @media (hover:none){
    .card .findbtn{display:none}
    .card .castbtn{display:block}
  }
  /* phone layout — the "pick here, fling to the TV" device */
  @media (max-width:640px){
    header{flex-wrap:wrap;gap:9px;padding:11px 14px}
    header h1{font-size:25px}
    #crumbs{order:6;flex-basis:100%}
    #types{order:5;flex-wrap:nowrap;overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch;padding-bottom:2px}
    #types .tchip{white-space:nowrap}
    #q{order:4;margin-left:auto;min-width:140px;flex:1}
    #grid{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:12px;padding:14px}
    #continue{padding:0 14px}
    .ccard{flex-basis:150px}
    .hero{flex-direction:column;gap:14px}
    .hero .poster{width:128px;height:192px}
    .hero h2{font-size:30px}
    .eprow{gap:10px}
    #overlay{padding:12px}
    #overlay video{max-height:50vh}
    #dock,#podDock{flex-wrap:wrap;gap:9px;padding:9px 12px}
    #dock .seek,#podDock .seek{order:5;flex-basis:100%}
  }
${podcasts.podcastCSS()}
</style></head><body>
<header>
  <h1>Casto</h1>
  <div id="crumbs"></div>
  <div id="types"></div>
  <input id="q" placeholder="Search library…" style="margin-left:auto">
  <select id="sort"><option value="name-asc">A → Z</option><option value="name-desc">Z → A</option></select>
  <button class="ghost" id="reindexBtn" style="color:var(--accent);border-color:var(--accent)" title="Rescan the drive for changes">↻ Rescan</button>
  <button class="ghost" id="npBtn" style="color:var(--accent);border-color:var(--accent)">▶ Now Playing</button>
</header>
<div id="continue"></div>
<div id="grid"></div>
<div id="podRoot" style="display:none"></div>

<aside id="finder">
  <div class="frow"><div id="finderTitle"></div><button class="ghost" id="finderClose" style="color:var(--accent);border-color:var(--accent)">Close</button></div>
  <div class="frow">
    <button id="googleImg">Google Images ↗</button>
    <button id="bingImg">Bing Images ↗</button>
  </div>
  <div class="hint">Opens an image search in a new window. Drag a poster from there onto the box below (or drop one from your desktop).</div>
  <div id="dropzone">Drag a poster image here</div>
</aside>

<div id="nowp">
  <div class="npcard">
    <div class="frow"><div id="finderTitle" style="flex:1"><b>Now Playing</b></div><button class="ghost" id="npClose" style="color:var(--accent);border-color:var(--accent)">Close</button></div>
    <div id="nplist"></div>
  </div>
</div>

<div id="overlay">
  <div id="ptitle"></div>
  <div id="upnext" style="color:#cdb98a;font-size:13px;min-height:16px"></div>
  <video id="player" controls style="object-fit:contain"></video>
  <div class="row">
    <button class="ghost" id="fsBtn">⛶ Fullscreen</button>
    <select id="fit"><option value="contain">Fit</option><option value="cover">Fill</option><option value="fill">Stretch</option></select>
    <button class="ghost" id="nextBtn" title="Play the next episode">Next ▸</button>
    <label style="color:#f5e9cf;font-size:13px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="autoplay" checked> Autoplay</label>
    <span style="flex:1"></span>
    <button class="ghost" id="closeBtn">Close</button>
  </div>
  <div class="row" style="flex-wrap:wrap;justify-content:center">
    <span style="color:#f5e9cf">Play on:</span>
    <span id="playon" style="display:flex;flex-wrap:wrap"></span>
    <button class="ghost" id="refreshTVs" title="Re-scan for TVs">⟳</button>
  </div>
  <div id="caststatus" style="color:#f5e9cf;font-size:13px;min-height:18px"></div>
</div>

<script>
let current = '0';
let finderItem = null;
function esc(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));}

let lastItems = [], lastCrumb = [], sortMode = 'name-asc', typeFilter = 'all';
let queue = null; // explicit ordered playlist (set when playing from a show page)
let autoplayOn = localStorage.getItem('casto.autoplay') !== '0'; // applies to local + cast
const KIND_ICON = { folder:'📁', movie:'🎬', tv:'📺', music:'🎵' };

function showLoading(text){
  const g=document.getElementById('grid'); g.className=''; g.innerHTML='<div class="msg"><span class="spin"></span>'+text+'</div>';
}
async function browse(id){
  current = id; queue = null;
  const q = document.getElementById('q'); if(q) q.value='';
  showLoading('Loading…');
  const data = await (await fetch('/api/browse?id='+encodeURIComponent(id))).json();
  // A folder is "show-like" if it holds episodes directly or has Season subs.
  const eps = data.items.filter(x => x.kind==='tv' && x.episode!=null);
  const seasonSubs = data.items.filter(x => x.type==='folder' && /^(season|series|specials|s\d)/i.test(x.title));
  if(id!=='0' && (eps.length || seasonSubs.length)) return renderShow(id, data.breadcrumb);
  renderItems(data.items, data.breadcrumb);
}
async function search(query){
  showLoading('Searching…');
  const data = await (await fetch('/api/search?q='+encodeURIComponent(query))).json();
  renderItems(data.items, null);
}
function sortItems(items){
  const dir = sortMode==='name-desc' ? -1 : 1;
  // Folders are navigation containers — always shown. Leaf items filter by the
  // selected content-type (Movies / TV / Music); "all" shows everything.
  const folders = items.filter(x=>x.type==='folder').sort((a,b)=>a.title.localeCompare(b.title)*dir);
  const vids = items.filter(x=>x.type!=='folder' && (typeFilter==='all' || x.kind===typeFilter)).sort((a,b)=>{
    // Episodes order numerically by season then episode; everything else A→Z.
    if(a.episode!=null && b.episode!=null) return (((a.season||0)-(b.season||0)) || (a.episode-b.episode))*dir;
    return a.title.localeCompare(b.title)*dir;
  });
  return [...folders, ...vids];
}
// "S1·E2" tag + a title with that token stripped (display only) to avoid
// "S1·E2 — Show S01E02" redundancy.
function seTag(it){ if(it.episode==null) return ''; return (it.season ? 'S'+it.season+'·' : '') + 'E'+it.episode; }
function cleanTitle(it){
  if(it.episode==null) return it.title;
  return it.title.replace(/\bS\d{1,2}\s?E\d{1,3}\b/i,'').replace(/\b\d{1,2}x\d{2,3}\b/,'')
    .replace(/^[\s\-_.]+|[\s\-_.]+$/g,'').replace(/\s{2,}/g,' ').trim() || it.title;
}
// --- Show detail / splash page (pick season + episode, then play or cast) ---
async function renderShow(id, breadcrumb){
  let r; try{ r = await (await fetch('/api/show?id='+encodeURIComponent(id))).json(); }catch(_){ r={}; }
  if(!r.ok || !r.show || !r.show.total){
    // Not actually a show — fall back to the normal grid.
    const data = await (await fetch('/api/browse?id='+encodeURIComponent(id))).json();
    return renderItems(data.items, data.breadcrumb);
  }
  const show = r.show;
  lastCrumb = breadcrumb || r.breadcrumb;
  document.getElementById('crumbs').innerHTML = (lastCrumb||[]).map(c => '<a onclick="browse(\\''+c.id+'\\')">'+esc(c.title)+'</a>').join(' › ');
  const grid = document.getElementById('grid');
  grid.className = 'show';
  const seasonLabel = (s) => s===0 ? 'Specials' : 'Season '+s;
  grid.innerHTML =
    '<div class="hero">' +
      '<div class="poster" id="showPoster">📺</div>' +
      '<div><h2>'+esc(show.title)+'</h2>' +
      '<div class="meta">'+show.seasons.length+' season'+(show.seasons.length>1?'s':'')+' · '+show.total+' episodes</div>' +
      '<div class="heroplay" id="heroPlayWrap"></div>' +
      '<div class="seasons" id="seasonTabs"></div></div>' +
    '</div><div class="eplist" id="eplist"></div>';
  if(show.art){
    const p=document.getElementById('showPoster'); const img=new Image();
    img.src=show.art; img.style.cssText='width:100%;height:100%;object-fit:cover;border-radius:12px';
    img.onload=()=>{ p.textContent=''; p.appendChild(img); };
  }
  const tabs=document.getElementById('seasonTabs');
  const selectSeason=(s,btn)=>{ tabs.querySelectorAll('.schip').forEach(x=>x.classList.remove('on')); btn.classList.add('on'); renderSeason(s); };
  const tabBtns=[];
  show.seasons.forEach((s,i)=>{
    const b=document.createElement('button');
    b.className='schip'+(i===0?' on':''); b.textContent=seasonLabel(s.season);
    b.onclick=()=>selectSeason(s,b);
    tabs.appendChild(b); tabBtns.push(b);
  });
  // Hero "Play"/"Resume": jump to the in-progress episode, else first unwatched.
  const target=pickResume(show);
  const hp=document.getElementById('heroPlayWrap');
  if(target){
    const pr=target.ep.progress, resume=pr && !pr.done && pr.pos>30;
    const b=document.createElement('button'); b.textContent=resume?'▶ Resume':'▶ Play';
    const lbl=document.createElement('span'); lbl.className='meta';
    lbl.textContent=(target.s.season===0?'Specials':'S'+target.s.season)+' · E'+target.ep.episode+(resume?' (resume)':'');
    b.onclick=()=>{ const i=show.seasons.indexOf(target.s); if(i>=0) selectSeason(target.s, tabBtns[i]); queue=target.s.episodes.slice(); open(target.ep,true); };
    hp.appendChild(b); hp.appendChild(lbl);
  }
  renderSeason(show.seasons[0]);
}
function pickResume(show){
  let inProg=null, unwatched=null, first=null;
  for(const s of show.seasons) for(const ep of s.episodes){
    if(!first) first={ep,s};
    const pr=ep.progress;
    if(pr && !pr.done && pr.pos>30 && !inProg) inProg={ep,s};
    if((!pr || !pr.done) && !unwatched) unwatched={ep,s};
  }
  return inProg || unwatched || first;
}
function renderSeason(s){
  const list=document.getElementById('eplist'); list.innerHTML='';
  for(const ep of s.episodes){
    const pr=ep.progress, done=pr&&pr.done, inProg=pr&&!pr.done&&pr.pos>30;
    const row=document.createElement('div'); row.className='eprow'+(done?' done':'');
    const num=document.createElement('div'); num.className='num'; num.textContent = ep.episode!=null ? ('E'+ep.episode) : '–';
    const ttl=document.createElement('div'); ttl.className='ttl'; ttl.textContent = cleanTitle(ep) || ep.title;
    row.appendChild(num); row.appendChild(ttl);
    if(done){ const sp=document.createElement('span'); sp.className='seen'; sp.textContent='✓ Watched'; row.appendChild(sp); }
    const playB=document.createElement('button'); playB.textContent = done?'↺ Replay':(inProg?'▶ Resume':'▶ Play');
    playB.onclick=()=>{ queue = s.episodes.slice(); open(ep, true); };
    const castB=document.createElement('button'); castB.className='castb'; castB.textContent='📺 Cast';
    castB.onclick=()=>{ queue = s.episodes.slice(); open(ep, false); };
    row.appendChild(playB); row.appendChild(castB);
    if(inProg){ const bar=document.createElement('div'); bar.className='erbar'; bar.innerHTML='<i style="width:'+Math.min(100,100*pr.pos/pr.dur)+'%"></i>'; row.appendChild(bar); }
    list.appendChild(row);
  }
}

function renderItems(items, breadcrumb){
  lastItems = items; lastCrumb = breadcrumb;
  document.getElementById('grid').className = '';
  document.getElementById('crumbs').innerHTML = breadcrumb
    ? breadcrumb.map(c => '<a onclick="browse(\\''+c.id+'\\')">'+esc(c.title)+'</a>').join(' › ')
    : '<a onclick="browse(\\'0\\')">Library</a> › search results';
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const ordered = sortItems(items);
  if(!ordered.length){
    const searching = breadcrumb===null && document.getElementById('q').value.trim();
    const kindWord = typeFilter==='all' ? 'media' : (typeFilter==='tv'?'TV episodes':typeFilter+'s');
    grid.innerHTML = searching
      ? '<div class="msg"><span class="big">No matches</span>Try a different search.</div>'
      : '<div class="msg"><span class="big">Nothing here</span>'+(typeFilter==='all'?'This folder is empty.':'No '+kindWord+' in this view.')+'</div>';
    renderContinue(); return;
  }
  for(const it of ordered) grid.appendChild(makeCard(it));
  renderContinue();
}
// Home "Continue Watching" strip — in-progress items across the library.
async function renderContinue(){
  const wrap=document.getElementById('continue');
  const searching=(document.getElementById('q').value||'').trim();
  if(current!=='0' || typeFilter==='podcasts' || searching){ wrap.innerHTML=''; return; }
  let r; try{ r=await (await fetch('/api/continue')).json(); }catch(_){ wrap.innerHTML=''; return; }
  const items=(r.items||[]).filter(x=>typeFilter==='all'||x.kind===typeFilter);
  if(!items.length){ wrap.innerHTML=''; return; }
  wrap.innerHTML='<h3>Continue Watching</h3>';
  const row=document.createElement('div'); row.className='crow';
  for(const it of items){
    const c=document.createElement('div'); c.className='ccard';
    const ct=document.createElement('div'); ct.className='ct';
    const img=new Image(); img.src=it.poster;
    img.onerror=()=>{ img.remove(); if(!ct.querySelector('.ph')){ const ph=document.createElement('span'); ph.className='ph'; ph.textContent=KIND_ICON[it.kind]||'🎬'; ct.appendChild(ph); } };
    ct.appendChild(img);
    const pr=it.progress;
    if(pr&&pr.dur){ const b=document.createElement('div'); b.className='pbar'; b.innerHTML='<i style="width:'+Math.min(100,100*pr.pos/pr.dur)+'%"></i>'; ct.appendChild(b); }
    const cl=document.createElement('div'); cl.className='cl'; cl.textContent=(seTag(it)?seTag(it)+' ':'')+(cleanTitle(it)||it.title);
    const cs=document.createElement('div'); cs.className='cs'; cs.textContent=it.show||'';
    c.appendChild(ct); c.appendChild(cl); c.appendChild(cs);
    c.onclick=()=>{ queue=null; open(it,true); };
    row.appendChild(c);
  }
  wrap.appendChild(row);
}
function makeCard(it){
  const card = document.createElement('div');
  card.className = 'card' + (it.type==='folder'?' folder':'') + (it.kind && it.kind!=='folder' ? ' '+it.kind : '');
  const thumb = document.createElement('div');
  thumb.className='thumb';
  const fallback = it.type==='folder' ? '📁' : (KIND_ICON[it.kind] || '🎬');
  if(it.poster){
    const img=document.createElement('img'); img.src=it.poster; img.loading='lazy';
    img.onerror=()=>{ img.remove(); if(!thumb.textContent) thumb.textContent=fallback; };
    thumb.appendChild(img);
  } else { thumb.textContent = fallback; }
  if(it.available===false){
    card.classList.add('off');
    const badge=document.createElement('div'); badge.className='badge'; badge.textContent='⏏ reconnect drive';
    thumb.appendChild(badge);
  }
  // Continue-watching bar (in-progress, not finished).
  const pr=it.progress;
  if(pr && pr.dur && !pr.done && pr.pos>30){
    const bar=document.createElement('div'); bar.className='pbar';
    bar.innerHTML='<i style="width:'+Math.min(100,100*pr.pos/pr.dur)+'%"></i>';
    thumb.appendChild(bar);
  }
  if(it.type==='video'){
    const cast=document.createElement('button');
    cast.className='findbtn castbtn'; cast.textContent='📺 cast'; cast.title='Cast to a TV (no local playback)';
    cast.onclick=(e)=>{ e.stopPropagation(); open(it, false); };
    thumb.appendChild(cast);
    const find=document.createElement('button');
    find.className='findbtn'; find.textContent='🔍 poster'; find.title='Find a poster';
    find.onclick=(e)=>{ e.stopPropagation(); openFinder(it); };
    thumb.appendChild(find);
    card.ondragover=(e)=>{ e.preventDefault(); card.classList.add('over'); };
    card.ondragleave=()=> card.classList.remove('over');
    card.ondrop=(e)=>{ card.classList.remove('over'); handleDrop(e, it.id); };
  } else {
    const rm=document.createElement('button');
    rm.className='findbtn rmbtn'; rm.textContent='✕'; rm.title='Remove from library (keeps files)';
    rm.onclick=(e)=>{ e.stopPropagation(); removeFolder(it); };
    thumb.appendChild(rm);
  }
  const ren=document.createElement('button');
  ren.className='findbtn renbtn'; ren.textContent='✎'; ren.title='Rename';
  ren.onclick=(e)=>{ e.stopPropagation(); rename(it); };
  thumb.appendChild(ren);
  const label = document.createElement('div');
  label.className='label';
  const tag = seTag(it);
  if(tag){ label.innerHTML = '<span class="se">'+tag+'</span>'+esc(cleanTitle(it)); }
  else { label.textContent = it.title; }
  card.appendChild(thumb); card.appendChild(label);
  const activate = () => { if(it.available===false) return; it.type==='folder' ? browse(it.id) : play(it); };
  card.onclick = activate;
  // Keyboard / TV-remote focusable.
  card.tabIndex = 0;
  card.setAttribute('role','button');
  card.setAttribute('aria-label', it.title);
  card.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); activate(); } };
  return card;
}
async function removeFolder(it){
  if(!confirm('Remove “'+it.title+'” from the library?\\nThis only drops it from Casto — your files are NOT deleted.')) return;
  await fetch('/api/remove?id='+encodeURIComponent(it.id),{method:'POST'});
  browse(current);
}

// --- Set a poster by drag-and-drop -----------------------------------------
function handleDrop(e, id){
  e.preventDefault();
  const dt = e.dataTransfer;
  const f = dt.files && [...dt.files].find(x => x.type.startsWith('image/'));
  if(f){ uploadPoster(id, f); return; }
  const url = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim().split('\\n')[0];
  if(/^https?:\\/\\//i.test(url)) savePosterFromURL(id, url);
}
async function uploadPoster(id, file){
  await fetch('/api/poster?id='+encodeURIComponent(id), {method:'POST', headers:{'Content-Type':file.type}, body:file});
  afterPoster(id);
}
async function savePosterFromURL(id, url){
  await fetch('/api/poster?id='+encodeURIComponent(id)+'&src='+encodeURIComponent(url), {method:'POST'});
  afterPoster(id);
}
function afterPoster(id){
  browse(current);
  if(finderItem && finderItem.id===id) closeFinder();
}

async function rename(it){
  const t = prompt('Rename', it.title);
  if(t===null) return;
  const title = t.trim(); if(!title) return;
  await fetch('/api/rename?id='+encodeURIComponent(it.id)+'&title='+encodeURIComponent(title),{method:'POST'});
  browse(current);
}

// --- Find-poster split panel -----------------------------------------------
function openFinder(it){
  finderItem = it;
  document.getElementById('finderTitle').innerHTML = 'Poster for <b>'+esc(it.title)+'</b>';
  document.body.classList.add('split');
  document.getElementById('finder').style.display='flex';
  const q = encodeURIComponent(it.title.replace(/[._]+/g,' ') + ' movie poster');
  document.getElementById('googleImg').onclick=()=>window.open('https://www.google.com/search?tbm=isch&q='+q,'casto_imgsearch');
  document.getElementById('bingImg').onclick=()=>window.open('https://www.bing.com/images/search?q='+q,'casto_imgsearch');
}
function closeFinder(){
  finderItem=null;
  document.body.classList.remove('split');
  document.getElementById('finder').style.display='none';
}
document.getElementById('finderClose').onclick=closeFinder;
(function(){
  const dz=document.getElementById('dropzone');
  dz.ondragover=(e)=>{ e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave=()=> dz.classList.remove('over');
  dz.ondrop=(e)=>{ dz.classList.remove('over'); if(finderItem) handleDrop(e, finderItem.id); };
})();

// --- Inline player + cast (independent — casting is not a mirror) -----------
let playingId = null;
let playlist = [], playIndex = -1; // the ordered episodes/items for autoplay
let curItem = null, lastSave = 0;  // continue-watching state
function play(it){ open(it, true); }
function open(it, watchLocal){
  playingId = it.id; curItem = it;
  // Playlist for "Next"/autoplay: an explicit queue from a show-page season if
  // we have one, else the current grid (already season/episode ordered).
  playlist = queue ? queue.slice() : sortItems(lastItems).filter(x => x.type !== 'folder');
  playIndex = playlist.findIndex(x => x.id === it.id);
  document.getElementById('ptitle').textContent = it.title;
  const v = document.getElementById('player');
  v.src = '/media/'+it.id;
  if(watchLocal){ v.play().catch(()=>{}); } else { v.pause(); }
  document.getElementById('caststatus').textContent = '';
  document.getElementById('overlay').style.display='flex';
  updateUpNext();
  renderPlayOn(watchLocal);
}
function nextItem(){ return playIndex >= 0 ? playlist[playIndex+1] : null; }
function updateUpNext(){
  const n = nextItem();
  const tag = n ? (seTag(n) ? seTag(n)+' — ' : '') : '';
  document.getElementById('upnext').textContent = n ? ('Up next: ' + tag + cleanTitle(n)) : '';
  document.getElementById('nextBtn').style.display = n ? '' : 'none';
}
function playNext(){ const n = nextItem(); if(n){ playIndex++; open(n, true); } }
document.getElementById('nextBtn').onclick = playNext;
(function(){
  const v = document.getElementById('player');
  // Resume where we left off (in-progress, not finished).
  v.addEventListener('loadedmetadata', () => {
    const pr = curItem && curItem.progress;
    if(pr && !pr.done && pr.pos>30 && pr.pos < v.duration-20) v.currentTime = pr.pos;
  });
  v.addEventListener('timeupdate', () => {
    if(!v.duration) return;
    if(Date.now()-lastSave > 5000){ lastSave = Date.now(); saveVideoProgress(); }
  });
  v.addEventListener('pause', saveVideoProgress);
  v.addEventListener('ended', () => {
    saveVideoProgress();
    if(document.getElementById('autoplay').checked) playNext();
  });
  window.addEventListener('beforeunload', saveVideoProgress);
})();
function saveVideoProgress(){
  const v = document.getElementById('player');
  if(!curItem || !v.duration || v.currentTime<1) return;
  // Keep curItem.progress in sync so a same-session reopen resumes correctly.
  curItem.progress = { pos:v.currentTime, dur:v.duration, done: v.currentTime>=v.duration-20 };
  fetch('/api/progress?id='+encodeURIComponent(curItem.id)+'&pos='+Math.floor(v.currentTime)+'&dur='+Math.floor(v.duration), {method:'POST', keepalive:true}).catch(()=>{});
}
document.getElementById('fsBtn').onclick = () => {
  const v=document.getElementById('player');
  if(document.fullscreenElement) document.exitFullscreen();
  else if(v.requestFullscreen) v.requestFullscreen();
};
document.getElementById('fit').onchange = (e) => {
  document.getElementById('player').style.objectFit = e.target.value;
};

// One toggle chip per destination: "Here" (local) plus each detected TV.
// Lit = playing there now. Independent — light as many as you like.
function chip(label, on){
  const b=document.createElement('button');
  b.className='chip'+(on?' on':''); b.textContent=label;
  return b;
}
async function renderPlayOn(localOn){
  const wrap=document.getElementById('playon'); wrap.innerHTML='';
  const here=chip('▶ Here', localOn);
  here.onclick=()=>{
    const v=document.getElementById('player');
    if(here.classList.contains('on')){ v.pause(); here.classList.remove('on'); }
    else { v.play().catch(()=>{}); here.classList.add('on'); }
  };
  wrap.appendChild(here);
  const status=document.getElementById('caststatus');
  status.textContent='Finding TVs…';
  let d; try{ d=await (await fetch('/api/devices')).json(); }catch(_){ d={devices:[]}; }
  status.textContent = d.devices.length ? '' : 'No TVs found — check they’re on the same network.';
  for(const tv of d.devices){
    const c=chip('📺 '+tv.name, false);
    c.onclick=()=>toggleTV(c, tv.name);
    wrap.appendChild(c);
  }
}
async function toggleTV(btn, name){
  const st=document.getElementById('caststatus');
  if(btn.classList.contains('on')){
    btn.classList.remove('on'); st.textContent='Stopping '+name+'…';
    const d=await (await fetch('/api/stop?target='+encodeURIComponent(name),{method:'POST'})).json();
    st.textContent = d.ok ? ('Stopped '+name) : ('Failed: '+(d.error||''));
  } else {
    btn.classList.add('on'); st.textContent='Casting to '+name+'…';
    // Send the ordered queue + index so the TV can auto-advance ("Autoplay").
    const d=await (await fetch('/api/cast?id='+encodeURIComponent(playingId)+'&target='+encodeURIComponent(name),
      {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ queue: playlist.map(x=>x.id), index: playIndex, autoplay: autoplayOn })})).json();
    if(d.ok){ st.textContent='Playing on '+name+(autoplayOn && playlist.length>1?' · Autoplay on':''); } else { btn.classList.remove('on'); st.textContent='Failed: '+(d.error||''); }
  }
}
document.getElementById('refreshTVs').onclick = () =>
  renderPlayOn(!document.getElementById('player').paused);
document.getElementById('closeBtn').onclick = () => {
  const v=document.getElementById('player'); saveVideoProgress(); v.pause(); v.src='';
  document.getElementById('overlay').style.display='none';
  browse(current); // refresh so continue-watching bars/ticks reflect this session
};

// --- Search + sort ---------------------------------------------------------
let qTimer=null;
document.getElementById('q').oninput=(e)=>{
  const v=e.target.value.trim();
  clearTimeout(qTimer);
  qTimer=setTimeout(()=> v ? search(v) : browse(current), 200);
};
document.getElementById('sort').onchange=(e)=>{ sortMode=e.target.value; renderItems(lastItems, lastCrumb); };
document.getElementById('reindexBtn').onclick=async()=>{
  const b=document.getElementById('reindexBtn'); b.textContent='↻ Rescanning…';
  await fetch('/api/reindex',{method:'POST'});
  setTimeout(()=>{ b.textContent='↻ Rescan'; browse(current); }, 1500);
};

// --- Now Playing (sessions manager) ----------------------------------------
let npTimer=null;
document.getElementById('npBtn').onclick=()=>{ document.getElementById('nowp').style.display='flex'; refreshNP(); clearInterval(npTimer); npTimer=setInterval(refreshNP,3000); };
document.getElementById('npClose').onclick=()=>{ document.getElementById('nowp').style.display='none'; clearInterval(npTimer); };
async function refreshNP(){
  let d; try{ d=await (await fetch('/api/sessions')).json(); }catch(_){ return; }
  const list=document.getElementById('nplist'); list.innerHTML='';
  if(!d.sessions || !d.sessions.length){ list.textContent='Nothing casting right now.'; return; }
  for(const s of d.sessions){
    const row=document.createElement('div'); row.className='nprow';
    const label=document.createElement('div'); label.style.flex='1';
    label.innerHTML='<b>'+esc(s.tv)+'</b><br><span style="color:var(--sub);font-size:13px">'+esc(s.title)+'</span>';
    row.appendChild(label);
    const ctrls=[['⏪','back','Rewind 30s'],['▶','play','Play'],['⏸','pause','Pause'],['⏩','forward','Forward 30s']];
    if(s.hasNext) ctrls.push(['⏭','next','Next']);
    ctrls.push(['⏹','stop','Stop']);
    for(const [txt,act,tip] of ctrls){
      const b=document.createElement('button'); b.textContent=txt; b.title=tip;
      b.onclick=async()=>{ await fetch('/api/control?target='+encodeURIComponent(s.tv)+'&action='+act,{method:'POST'}); if(act==='stop'||act==='next') refreshNP(); };
      row.appendChild(b);
    }
    // Autoplay switch for this cast session.
    const ap=document.createElement('button'); ap.className='chip'+(s.autoplay?' on':''); ap.textContent='⟳ Autoplay';
    ap.title='Auto-advance to the next item when this one ends';
    ap.onclick=async()=>{ await fetch('/api/control?target='+encodeURIComponent(s.tv)+'&action=autoplay&on='+(s.autoplay?'0':'1'),{method:'POST'}); refreshNP(); };
    row.appendChild(ap);
    list.appendChild(row);
  }
}

// Autoplay preference (governs local autoplay + cast auto-advance), persisted.
(function(){
  const cb=document.getElementById('autoplay');
  if(cb){ cb.checked=autoplayOn; cb.onchange=()=>{ autoplayOn=cb.checked; localStorage.setItem('casto.autoplay', autoplayOn?'1':'0'); }; }
})();

// --- Keyboard shortcuts ----------------------------------------------------
document.addEventListener('keydown',(e)=>{
  const tag=(e.target.tagName||'').toUpperCase();
  if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'){ if(e.key==='Escape') e.target.blur(); return; }
  const ov=document.getElementById('overlay');
  if(ov.style.display==='flex'){
    const v=document.getElementById('player');
    if(e.key==='Escape') document.getElementById('closeBtn').click();
    else if(e.key===' '){ e.preventDefault(); v.paused?v.play().catch(()=>{}):v.pause(); }
    else if(e.key==='ArrowRight') v.currentTime=Math.min(v.duration||1e9, v.currentTime+10);
    else if(e.key==='ArrowLeft') v.currentTime=Math.max(0, v.currentTime-10);
    else if(e.key.toLowerCase()==='n') playNext();
    else if(e.key.toLowerCase()==='f') document.getElementById('fsBtn').click();
    return;
  }
  if(e.key==='Escape'){
    if(document.body.classList.contains('split')) return closeFinder();
    const np=document.getElementById('nowp'); if(np.style.display==='flex') np.style.display='none';
  }
});

// --- Content-type filter chips (the unified hub) ---------------------------
// Movies / TV / Music filter the local file grid by kind; Podcasts swaps the
// grid for the shared podcast widget (RSS subscribe, directory search, player).
const TYPES = [['all','All'],['movie','🎬 Movies'],['tv','📺 TV'],['music','🎵 Music'],['podcasts','🎙 Podcasts']];
let podMounted = false;
function setType(kind){
  typeFilter = kind;
  document.querySelectorAll('#types .tchip').forEach(b=>b.classList.toggle('on', b.dataset.kind===kind));
  const podView = kind==='podcasts';
  // Library-only controls are meaningless in the podcast view (but keep Now
  // Playing — it manages cast sessions, including flung podcasts).
  for(const id of ['q','sort','reindexBtn']){ const el=document.getElementById(id); if(el) el.style.display = podView?'none':''; }
  document.getElementById('grid').style.display = podView?'none':'';
  document.getElementById('podRoot').style.display = podView?'block':'none';
  document.getElementById('crumbs').style.display = podView?'none':'';
  if(podView){
    if(!podMounted){ CastoPod.mount(document.getElementById('podRoot'), { apiPrefix:'/api/pod', castPrefix:'/api/pod' }); podMounted=true; }
  } else {
    renderItems(lastItems, lastCrumb); // re-apply the kind filter to the grid
  }
}
(function(){
  const wrap=document.getElementById('types');
  for(const [kind,label] of TYPES){
    const b=document.createElement('button');
    b.className='tchip'+(kind==='all'?' on':''); b.dataset.kind=kind; b.textContent=label;
    b.onclick=()=>setType(kind);
    wrap.appendChild(b);
  }
})();

browse('0');
</script>
${podcasts.podcastDockHTML()}
<script>${podcasts.podcastClientJS()}</script>
</body></html>`;
}

// --- Server ----------------------------------------------------------------

function breadcrumb(objects, id) {
  const chain = [];
  let cur = objects.get(id);
  while (cur) { chain.unshift({ id: cur.id, title: cur.title }); cur = cur.parentId === '-1' ? null : objects.get(cur.parentId); }
  return chain;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const dir = argv.find((a) => !a.startsWith('-'));
  if (!dir || argv.includes('-h') || argv.includes('--help')) {
    console.log('Casto Library — a Plex-style personal media library\n  node library.js <media-folder> [--port <n>] [--host <lan-ip>]');
    process.exit(dir ? 0 : 1);
  }
  const root = path.resolve(dir);
  const host = get('--host', localIPv4()) || '127.0.0.1';
  const port = parseInt(get('--port', '8010'), 10);
  preventSleep();
  podcasts.ensureDirs(); // podcast subscriptions/downloads live under ~/.casto

  // State (title overrides, removed folders) AND the index cache live in HOME,
  // keyed by the library path — NOT on the drive. So an unplugged drive (or a
  // trip to a friend's house) doesn't lose the library or force a reindex.
  const STATE_DIR = path.join(os.homedir(), '.casto');
  const stateFile = path.join(STATE_DIR, 'lib-' + crypto.createHash('md5').update(root).digest('hex') + '.json');
  const config = { titles: {}, removed: [], index: null };
  try { Object.assign(config, JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch (_) {}
  config.titles = config.titles || {};
  config.removed = config.removed || [];
  config.progress = config.progress || {}; // rel-path -> { pos, dur, done, at }

  const objects = new Map();
  const liveCtx = { map: objects, nextId: 1 };
  const relOf = (node) => path.relative(root, node.path || node.file);
  const removeSubtree = (node) => {
    for (const cid of node.children || []) { const c = objects.get(cid); if (c) removeSubtree(c); }
    objects.delete(node.id);
  };
  const detach = (node) => {
    const parent = objects.get(node.parentId);
    if (parent && parent.children) parent.children = parent.children.filter((x) => x !== node.id);
  };
  const findByRel = (rel) => [...objects.values()].find((n) => n.id !== '0' && relOf(n) === rel);
  const progOf = (node) => (node && !node.container) ? (config.progress[relOf(node)] || null) : null;
  const maxId = () => [...objects.keys()].reduce((m, k) => Math.max(m, +k || 0), 0);
  const serialize = () => [...objects.values()].map((n) =>
    ({ id: n.id, parentId: n.parentId, container: n.container, title: n.title, path: n.path, file: n.file, contentType: n.contentType, kind: n.kind, season: n.season, episode: n.episode, size: n.size, art: n.art, children: n.children, scanned: n.scanned }));
  let saveTimer = null;
  const saveConfig = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      config.index = serialize();
      fsp.mkdir(STATE_DIR, { recursive: true })
        .then(() => fsp.writeFile(stateFile, JSON.stringify(config)))
        .catch(() => {});
    }, 500);
  };
  // A disconnect drops the whole mount, so one check on the root suffices —
  // far cheaper than an fs hit per folder on a big library.
  const markAvailability = () => {
    const up = fs.existsSync(root);
    for (const n of objects.values()) if (n.container) n.unavailable = !up;
  };
  // Lazy: scan a folder the first time it's browsed (instant, one level).
  const ensureScanned = async (node) => {
    if (node && node.container && !node.scanned && fs.existsSync(node.path)) {
      await scanDirInto(liveCtx, node, root, config);
    }
  };

  // Full refresh: rebuild off disk in the background (non-blocking), then swap
  // it in. Used at startup (when the drive is present), on reconnect, and on
  // the user-triggered rescan.
  let refreshing = false;
  const refresh = async () => {
    if (refreshing || !fs.existsSync(root)) return;
    refreshing = true;
    try {
      const fresh = await buildAsync(root, config);
      objects.clear();
      for (const [k, v] of fresh) objects.set(k, v);
      liveCtx.nextId = maxId() + 1;
      markAvailability();
      saveConfig();
    } finally { refreshing = false; }
  };

  console.log('⊙ Loading library…');
  if (config.index && config.index.length) {
    for (const n of config.index) objects.set(n.id, { ...n });
    for (const rel of config.removed) { const n = findByRel(rel); if (n) { detach(n); removeSubtree(n); } }
    liveCtx.nextId = maxId() + 1;
    markAvailability();
  } else if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    objects.set('0', makeRoot(root, config)); // lazy: children scan on first browse
    liveCtx.nextId = 1;
  } else {
    console.error('✗ Drive not connected and no cached index for ' + root);
    process.exit(1);
  }
  if (fs.existsSync(root)) refresh(); // fill / refresh in the background

  const name = (objects.get('0') || {}).title || path.basename(root) || 'Library';
  const count = () => [...objects.values()].filter((n) => !n.container).length;

  // Periodic availability + auto-refresh the moment the drive reconnects.
  let rootAvail = fs.existsSync(root);
  setInterval(() => {
    const now = fs.existsSync(root);
    if (now && !rootAvail) { refresh().then(() => console.log('↻ drive reconnected — index refreshed')); }
    else markAvailability();
    rootAvail = now;
  }, 10000);

  let rendererCache = { at: 0, list: [] };
  const castByDevice = new Map(); // tvName -> { controlURL, title, queue, idx, autoplay, timer, started, polling, errs }

  // Auto-advance ("Autoplay"): poll the renderer; when the current track ends
  // (STOPPED after we saw it PLAYING) and autoplay is on, fling the next item
  // in the queue. A user Stop deletes the session, so a STOPPED on a live
  // session means a natural end — that's our "ended" signal.
  const stopCastPoll = (name) => { const s = castByDevice.get(name); if (s && s.timer) { clearInterval(s.timer); s.timer = null; } };
  const hasNext = (s) => s && s.queue && s.idx < s.queue.length - 1;
  async function pollCast(name) {
    const s = castByDevice.get(name);
    if (!s || s.polling) return;
    s.polling = true;
    try {
      const state = await transportState(s.controlURL);
      s.errs = 0;
      if (state === 'PLAYING') { s.started = true; return; }
      if (state === 'STOPPED' && s.started) {
        s.started = false;
        if (s.autoplay && hasNext(s)) {
          s.idx++; const it = s.queue[s.idx];
          try { await castTo(s.controlURL, it.url, it.title, it.contentType); s.title = it.title; } catch (_) {}
        } else { stopCastPoll(name); } // end of queue, or autoplay off
      }
    } catch (_) {
      if (((castByDevice.get(name) || {}).errs = ((castByDevice.get(name) || {}).errs || 0) + 1) > 6) stopCastPoll(name);
    } finally { const s2 = castByDevice.get(name); if (s2) s2.polling = false; }
  }
  const startCastPoll = (name) => { const s = castByDevice.get(name); if (!s) return; stopCastPoll(name); s.started = false; s.errs = 0; s.timer = setInterval(() => pollCast(name), 5000); };
  // Build a castable queue from media node ids (skips folders/missing).
  const queueFromIds = (ids) => (ids || []).map((id) => {
    const n = objects.get(id);
    if (!n || n.container) return null;
    return { id, url: `http://${host}:${port}/media/${id}`, title: n.title, contentType: n.contentType };
  }).filter(Boolean);
  const renderers = async () => {
    if (Date.now() - rendererCache.at < 60000 && rendererCache.list.length) return rendererCache.list;
    rendererCache = { at: Date.now(), list: await findRenderers() };
    return rendererCache.list;
  };
  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${host}:${port}`);
    const p = u.pathname;
    try {
      if (p === '/') { const html = pageHTML(name); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }

      // Podcasts content-type: the shared podcast engine, mounted under /api/pod
      if (p === '/api/pod/devices') {
        const list = await renderers();
        return json(res, 200, { ok: true, devices: list.map((d) => ({ name: d.name })) });
      }
      if (p === '/api/pod/cast' && req.method === 'POST') {
        const id = u.searchParams.get('id') || '';
        const audioUrl = u.searchParams.get('url') || '';
        const title = u.searchParams.get('title') || 'Podcast';
        const target = u.searchParams.get('target');
        const dev = (await renderers()).find((d) => d.name.toLowerCase().includes((target || '').toLowerCase()));
        if (!dev) return json(res, 404, { ok: false, error: 'no matching device' });
        // Cast our own proxied URL: the renderer then gets plain HTTP with Range
        // from us, even when the episode lives on an HTTPS CDN behind redirects.
        const url = `http://${host}:${port}/api/pod/audio?id=${encodeURIComponent(id)}` + (audioUrl ? `&url=${encodeURIComponent(audioUrl)}` : '');
        await castTo(dev.controlURL, url, title, 'audio/mpeg');
        castByDevice.set(dev.name, { controlURL: dev.controlURL, title });
        return json(res, 200, { ok: true, device: dev.name });
      }
      if (p.startsWith('/api/pod/')) {
        if (await podcasts.handlePodcastRoutes(req, res, u, json, '/api/pod')) return;
      }

      if (p === '/api/browse') {
        const node = objects.get(u.searchParams.get('id') || '0');
        if (!node) return json(res, 404, { ok: false });
        await ensureScanned(node); // lazy: scan this folder on first visit
        const items = (node.children || []).map((cid) => {
          const c = objects.get(cid);
          // Videos always get an /art URL (sidecar art, or 404 → UI fallback).
          const poster = c.art || !c.container ? `/art/${c.id}` : null;
          const available = c.container ? !c.unavailable : !node.unavailable;
          return { id: c.id, title: c.title, type: c.container ? 'folder' : 'video', kind: c.container ? 'folder' : (c.kind || 'movie'), season: c.season, episode: c.episode, progress: progOf(c), poster, available };
        });
        return json(res, 200, { ok: true, folder: { id: node.id, title: node.title }, breadcrumb: breadcrumb(objects, node.id), items });
      }

      // Aggregate a folder into a Plex/Jellyfin-style show: episodes grouped by
      // season, whether they sit directly in the folder or inside Season/* subs.
      if (p === '/api/show') {
        const node = objects.get(u.searchParams.get('id') || '');
        if (!node || !node.container) return json(res, 404, { ok: false });
        await ensureScanned(node);
        const seasons = new Map(); // season# -> [episodes]
        const addEp = (c, fallbackSeason) => {
          if (!c || c.container || c.kind !== 'tv') return;
          const s = c.season != null ? c.season : (fallbackSeason != null ? fallbackSeason : 1);
          if (!seasons.has(s)) seasons.set(s, []);
          seasons.get(s).push({ id: c.id, title: c.title, season: c.season, episode: c.episode, progress: progOf(c), poster: `/art/${c.id}` });
        };
        for (const cid of node.children || []) {
          const c = objects.get(cid);
          if (!c) continue;
          if (c.container) {
            await ensureScanned(c); // a Season subfolder — pull its episodes up
            const sm = /\bseason\s*(\d+)\b/i.exec(c.title) || /\bs(\d+)\b/i.exec(c.title);
            const fb = /special/i.test(c.title) ? 0 : (sm ? +sm[1] : null);
            for (const gid of c.children || []) addEp(objects.get(gid), fb);
          } else addEp(c);
        }
        const out = [...seasons.entries()].sort((a, b) => a[0] - b[0])
          .map(([season, eps]) => ({ season, episodes: eps.sort((x, y) => (x.episode || 0) - (y.episode || 0)) }));
        const total = out.reduce((n, s) => n + s.episodes.length, 0);
        return json(res, 200, { ok: true, show: { id: node.id, title: node.title, art: node.art ? `/art/${node.id}` : null, seasons: out, total }, breadcrumb: breadcrumb(objects, node.id) });
      }

      // Continue-watching: remember playback position per file (by rel path, so
      // it survives reindex). Cleared to "done" near the end.
      if (p === '/api/progress' && req.method === 'GET') {
        return json(res, 200, { ok: true, progress: config.progress });
      }
      if (p === '/api/progress' && req.method === 'POST') {
        const node = objects.get(u.searchParams.get('id') || '');
        if (!node || node.container) return json(res, 400, { ok: false });
        const pos = parseFloat(u.searchParams.get('pos') || '0');
        const dur = parseFloat(u.searchParams.get('dur') || '0');
        if (pos >= 0) {
          const done = dur > 0 && pos >= dur - 20;
          config.progress[relOf(node)] = { pos: done ? dur : pos, dur, done, at: Date.now() };
          saveConfig();
        }
        return json(res, 200, { ok: true });
      }

      // In-progress items across the whole library, most-recent first.
      if (p === '/api/continue') {
        const out = [];
        for (const [rel, pr] of Object.entries(config.progress)) {
          if (pr.done || !(pr.pos > 30)) continue;
          const node = findByRel(rel);
          if (!node || node.container) continue;
          const parent = objects.get(node.parentId);
          let show = parent && parent.id !== '0' ? parent.title : '';
          // For episodes, prefer the series name over a "Season N" subfolder.
          if (node.kind === 'tv' && parent && /^(season|series|specials|s\d)/i.test(parent.title)) {
            const gp = objects.get(parent.parentId);
            if (gp && gp.id !== '0') show = gp.title;
          }
          out.push({ id: node.id, title: node.title, kind: node.kind || 'movie', season: node.season, episode: node.episode, progress: pr, poster: `/art/${node.id}`, at: pr.at || 0, show });
        }
        out.sort((a, b) => b.at - a.at);
        return json(res, 200, { ok: true, items: out.slice(0, 12) });
      }

      if (p === '/api/reindex' && req.method === 'POST') {
        refresh(); // fire-and-forget; non-blocking
        return json(res, 200, { ok: true, refreshing: true });
      }

      if (p === '/api/search') {
        const query = (u.searchParams.get('q') || '').toLowerCase().trim();
        const items = [];
        if (query) {
          for (const n of objects.values()) {
            if (n.container || n.id === '0') continue;
            if (n.title.toLowerCase().includes(query)) {
              const parent = objects.get(n.parentId);
              items.push({ id: n.id, title: n.title, type: 'video', kind: n.kind || 'movie', season: n.season, episode: n.episode, progress: progOf(n), poster: `/art/${n.id}`, available: parent ? !parent.unavailable : true });
            }
          }
        }
        return json(res, 200, { ok: true, items });
      }

      if (p === '/api/devices') {
        const list = await renderers();
        return json(res, 200, { ok: true, devices: list.map((d) => ({ name: d.name })) });
      }

      if (p === '/api/poster' && req.method === 'POST') {
        const node = objects.get(u.searchParams.get('id') || '');
        if (!node || node.container) return json(res, 404, { ok: false, error: 'item not found' });
        const src = u.searchParams.get('src');
        let buf, ext;
        if (src) {
          const got = await fetchImage(src);
          buf = got.buffer; ext = extForType(got.contentType, src);
        } else {
          buf = await readBody(req, 12 * 1024 * 1024);
          ext = extForType(req.headers['content-type'], '');
        }
        if (!buf || !buf.length) return json(res, 400, { ok: false, error: 'no image data' });
        const dir = path.dirname(node.file);
        const dest = path.join(dir, path.basename(node.file, path.extname(node.file)) + ext);
        fs.writeFileSync(dest, buf);
        node.art = dest;
        return json(res, 200, { ok: true, poster: `/art/${node.id}` });
      }

      if (p === '/api/cast' && req.method === 'POST') {
        const node = objects.get(u.searchParams.get('id') || '');
        if (!node || node.container) return json(res, 404, { ok: false, error: 'item not found' });
        const target = u.searchParams.get('target');
        const dev = (await renderers()).find((d) => d.name.toLowerCase().includes((target || '').toLowerCase()));
        if (!dev) return json(res, 404, { ok: false, error: 'no matching TV' });
        // Optional body: an ordered queue + index for auto-advance ("Autoplay").
        const body = await readJSON(req);
        const queue = queueFromIds(body.queue);
        let idx = queue.findIndex((q) => q.id === node.id);
        if (idx < 0) idx = typeof body.index === 'number' ? body.index : 0;
        const url = `http://${host}:${port}/media/${node.id}`;
        await castTo(dev.controlURL, url, node.title, node.contentType);
        stopCastPoll(dev.name);
        castByDevice.set(dev.name, { controlURL: dev.controlURL, title: node.title, queue: queue.length ? queue : [{ id: node.id, url, title: node.title, contentType: node.contentType }], idx: idx < 0 ? 0 : idx, autoplay: body.autoplay !== false });
        if (body.autoplay !== false) startCastPoll(dev.name); // poll for end-of-track
        return json(res, 200, { ok: true, device: dev.name });
      }

      if (p === '/api/sessions') {
        return json(res, 200, { ok: true, sessions: [...castByDevice.entries()].map(([tv, s]) => ({ tv, title: s.title, autoplay: !!s.autoplay, hasNext: hasNext(s) })) });
      }

      if (p === '/api/control' && req.method === 'POST') {
        const target = u.searchParams.get('target') || '';
        const s = castByDevice.get(target);
        if (!s) return json(res, 404, { ok: false, error: 'no active session for that TV' });
        const a = u.searchParams.get('action');
        if (a === 'play') await tx.play(s.controlURL);
        else if (a === 'pause') await tx.pause(s.controlURL);
        else if (a === 'forward') await seekRel(s.controlURL, 30);
        else if (a === 'back') await seekRel(s.controlURL, -30);
        else if (a === 'stop') { stopCastPoll(target); await tx.stop(s.controlURL); castByDevice.delete(target); }
        else if (a === 'next') {
          if (!hasNext(s)) return json(res, 400, { ok: false, error: 'no next item' });
          s.idx++; const it = s.queue[s.idx]; s.title = it.title; s.started = false;
          await castTo(s.controlURL, it.url, it.title, it.contentType);
          if (s.autoplay && !s.timer) startCastPoll(target);
        } else if (a === 'autoplay') {
          s.autoplay = u.searchParams.get('on') !== '0';
          if (s.autoplay) startCastPoll(target); else stopCastPoll(target);
        } else return json(res, 400, { ok: false, error: 'unknown action' });
        return json(res, 200, { ok: true });
      }

      if (p === '/api/rename' && req.method === 'POST') {
        const node = objects.get(u.searchParams.get('id') || '');
        const title = (u.searchParams.get('title') || '').trim();
        if (!node) return json(res, 404, { ok: false, error: 'item not found' });
        if (!title) return json(res, 400, { ok: false, error: 'empty title' });
        node.title = title;
        config.titles[relOf(node)] = title;
        saveConfig();
        return json(res, 200, { ok: true, title });
      }

      // Deliberate removal: purge from the index and remember it (persisted),
      // so it stays gone across restarts. Does NOT delete any files.
      if (p === '/api/remove' && req.method === 'POST') {
        const node = objects.get(u.searchParams.get('id') || '');
        if (!node || node.id === '0') return json(res, 400, { ok: false, error: 'cannot remove' });
        const rel = relOf(node);
        detach(node);
        removeSubtree(node);
        if (!config.removed.includes(rel)) config.removed.push(rel);
        for (const k of Object.keys(config.titles)) {
          if (k === rel || k.startsWith(rel + path.sep)) delete config.titles[k];
        }
        saveConfig();
        return json(res, 200, { ok: true });
      }

      if (p === '/api/stop' && req.method === 'POST') {
        const target = u.searchParams.get('target') || '';
        const active = castByDevice.get(target);
        let controlURL = active && active.controlURL;
        if (!controlURL) {
          const dev = (await renderers()).find((d) => d.name.toLowerCase().includes(target.toLowerCase()));
          controlURL = dev && dev.controlURL;
        }
        if (!controlURL) return json(res, 404, { ok: false, error: 'no matching TV' });
        stopCastPoll(target);
        await soap(controlURL, 'Stop', '<InstanceID>0</InstanceID>');
        castByDevice.delete(target);
        return json(res, 200, { ok: true });
      }

      if (p.startsWith('/media/')) {
        const node = objects.get(p.slice('/media/'.length));
        if (!node || node.container) { res.writeHead(404); return res.end('Not found'); }
        return serveFile(req, res, node.file, node.contentType);
      }
      if (p.startsWith('/art/')) {
        const node = objects.get(p.slice('/art/'.length));
        if (!node || !node.art) { res.writeHead(404); return res.end('Not found'); }
        return serveFile(req, res, node.art, IMAGE_TYPES[path.extname(node.art).toLowerCase()] || 'image/jpeg');
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`▶ "${name}" — ${count()} videos indexed so far (lazy + background)`);
    console.log(`  posters: sidecar art + drag-and-drop (🔍 to find one)`);
    console.log(`  open  http://localhost:${port}`);
    console.log(`  (on your network: http://${host}:${port})`);
  });
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
