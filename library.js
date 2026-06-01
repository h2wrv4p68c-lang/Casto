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
function mediaKind(ext, relPath) {
  if (AUDIO_EXTS.includes(ext)) return 'music';
  return TV_PATTERN.test(relPath) ? 'tv' : 'movie';
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
    ctx.map.set(id, { id, parentId: node.id, container: false, title: config.titles[rel] || base, file: fp, contentType: MEDIA_TYPES[ext] || 'video/mp4', kind: mediaKind(ext, rel), art });
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
  const didl = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1">' + `<dc:title>${xmlEscape(title)}</dc:title><upnp:class>object.item.videoItem</upnp:class>` + `<res protocolInfo="http-get:*:${contentType}:${DLNA_FEATURES}">${xmlEscape(url)}</res></item></DIDL-Lite>`;
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
  #podRoot{padding:22px 24px;max-width:1100px;margin:0 auto}
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
  <video id="player" controls style="object-fit:contain"></video>
  <div class="row">
    <button class="ghost" id="fsBtn">⛶ Fullscreen</button>
    <select id="fit"><option value="contain">Fit</option><option value="cover">Fill</option><option value="fill">Stretch</option></select>
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
const KIND_ICON = { folder:'📁', movie:'🎬', tv:'📺', music:'🎵' };

async function browse(id){
  current = id;
  const q = document.getElementById('q'); if(q) q.value='';
  const data = await (await fetch('/api/browse?id='+encodeURIComponent(id))).json();
  renderItems(data.items, data.breadcrumb);
}
async function search(query){
  const data = await (await fetch('/api/search?q='+encodeURIComponent(query))).json();
  renderItems(data.items, null);
}
function sortItems(items){
  const dir = sortMode==='name-desc' ? -1 : 1;
  // Folders are navigation containers — always shown. Leaf items filter by the
  // selected content-type (Movies / TV / Music); "all" shows everything.
  const folders = items.filter(x=>x.type==='folder').sort((a,b)=>a.title.localeCompare(b.title)*dir);
  const vids = items.filter(x=>x.type!=='folder' && (typeFilter==='all' || x.kind===typeFilter)).sort((a,b)=>a.title.localeCompare(b.title)*dir);
  return [...folders, ...vids];
}
function renderItems(items, breadcrumb){
  lastItems = items; lastCrumb = breadcrumb;
  document.getElementById('crumbs').innerHTML = breadcrumb
    ? breadcrumb.map(c => '<a onclick="browse(\\''+c.id+'\\')">'+esc(c.title)+'</a>').join(' › ')
    : '<a onclick="browse(\\'0\\')">Library</a> › search results';
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  for(const it of sortItems(items)) grid.appendChild(makeCard(it));
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
  label.className='label'; label.textContent = it.title;
  card.appendChild(thumb); card.appendChild(label);
  card.onclick = () => {
    if(it.available===false){ return; }
    it.type==='folder' ? browse(it.id) : play(it);
  };
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
function play(it){ open(it, true); }
function open(it, watchLocal){
  playingId = it.id;
  document.getElementById('ptitle').textContent = it.title;
  const v = document.getElementById('player');
  v.src = '/media/'+it.id;
  if(watchLocal){ v.play().catch(()=>{}); } else { v.pause(); }
  document.getElementById('caststatus').textContent = '';
  document.getElementById('overlay').style.display='flex';
  renderPlayOn(watchLocal);
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
    const d=await (await fetch('/api/cast?id='+encodeURIComponent(playingId)+'&target='+encodeURIComponent(name),{method:'POST'})).json();
    if(d.ok){ st.textContent='Playing on '+name; } else { btn.classList.remove('on'); st.textContent='Failed: '+(d.error||''); }
  }
}
document.getElementById('refreshTVs').onclick = () =>
  renderPlayOn(!document.getElementById('player').paused);
document.getElementById('closeBtn').onclick = () => {
  const v=document.getElementById('player'); v.pause(); v.src='';
  document.getElementById('overlay').style.display='none';
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
    for(const [txt,act,tip] of [['⏪','back','Rewind 30s'],['▶','play','Play'],['⏸','pause','Pause'],['⏩','forward','Forward 30s'],['⏹','stop','Stop']]){
      const b=document.createElement('button'); b.textContent=txt; b.title=tip;
      b.onclick=async()=>{ await fetch('/api/control?target='+encodeURIComponent(s.tv)+'&action='+act,{method:'POST'}); if(act==='stop') refreshNP(); };
      row.appendChild(b);
    }
    list.appendChild(row);
  }
}

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
  const maxId = () => [...objects.keys()].reduce((m, k) => Math.max(m, +k || 0), 0);
  const serialize = () => [...objects.values()].map((n) =>
    ({ id: n.id, parentId: n.parentId, container: n.container, title: n.title, path: n.path, file: n.file, contentType: n.contentType, size: n.size, art: n.art, children: n.children, scanned: n.scanned }));
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
  const castByDevice = new Map(); // tvName -> controlURL (active casts)
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
          return { id: c.id, title: c.title, type: c.container ? 'folder' : 'video', kind: c.container ? 'folder' : (c.kind || 'movie'), poster, available };
        });
        return json(res, 200, { ok: true, folder: { id: node.id, title: node.title }, breadcrumb: breadcrumb(objects, node.id), items });
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
              items.push({ id: n.id, title: n.title, type: 'video', kind: n.kind || 'movie', poster: `/art/${n.id}`, available: parent ? !parent.unavailable : true });
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
        const url = `http://${host}:${port}/media/${node.id}`;
        await castTo(dev.controlURL, url, node.title, node.contentType);
        castByDevice.set(dev.name, { controlURL: dev.controlURL, title: node.title });
        return json(res, 200, { ok: true, device: dev.name });
      }

      if (p === '/api/sessions') {
        return json(res, 200, { ok: true, sessions: [...castByDevice.entries()].map(([tv, s]) => ({ tv, title: s.title })) });
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
        else if (a === 'stop') { await tx.stop(s.controlURL); castByDevice.delete(target); }
        else return json(res, 400, { ok: false, error: 'unknown action' });
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
