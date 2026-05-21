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
const { URL } = require('url');

// Optional: set TMDB_API_KEY to auto-fetch posters for files without sidecar art.
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

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
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const IMAGE_EXTS = Object.keys(IMAGE_TYPES);
const POSTER_NAMES = ['poster', 'folder', 'cover', 'thumb'];

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

// --- Index a folder into a browsable tree ----------------------------------

function buildTree(root) {
  const objects = new Map();
  let nextId = 1;

  function posterFor(filePath, isDir) {
    const dir = isDir ? filePath : path.dirname(filePath);
    if (!isDir) {
      const base = path.basename(filePath, path.extname(filePath));
      for (const ext of IMAGE_EXTS) {
        const p = path.join(dir, base + ext);
        if (fs.existsSync(p)) return p;
      }
    }
    for (const name of POSTER_NAMES)
      for (const ext of IMAGE_EXTS) {
        const p = path.join(dir, name + ext);
        if (fs.existsSync(p)) return p;
      }
    return null;
  }

  function scan(dirPath, parentId, title) {
    const id = parentId === '-1' ? '0' : String(nextId++);
    const node = { id, parentId, container: true, title, art: posterFor(dirPath, true), children: [] };
    objects.set(id, node);
    let entries = [];
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return node; }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => e.isFile() && VIDEO_EXTS.includes(path.extname(e.name).toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      const child = scan(path.join(dirPath, d.name), id, d.name);
      if (child.children.length > 0) node.children.push(child.id);
      else objects.delete(child.id);
    }
    for (const f of files) {
      const filePath = path.join(dirPath, f.name);
      const ext = path.extname(f.name).toLowerCase();
      const cid = String(nextId++);
      objects.set(cid, {
        id: cid, parentId: id, container: false, title: path.basename(f.name, ext),
        file: filePath, contentType: CONTENT_TYPES[ext] || 'video/mp4',
        size: fs.statSync(filePath).size, art: posterFor(filePath, false),
      });
      node.children.push(cid);
    }
    return node;
  }
  scan(root, '-1', path.basename(root) || 'Library');
  return objects;
}

// --- TMDb poster lookup (optional) -----------------------------------------

const posterCache = new Map(); // node.id -> url | null

function cleanTitle(t) {
  return t
    .replace(/[._]+/g, ' ')
    .replace(/[\[(].*?[\])]/g, '')
    .replace(/\b(1080p|720p|2160p|4k|bluray|brrip|webrip|web-dl|hdrip|dvdrip|x264|x265|h264|h265|hevc|aac|ac3|dts|remux|proper|extended)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function tmdbPoster(title) {
  if (!TMDB_API_KEY) return null;
  const q = cleanTitle(title);
  if (!q) return null;
  try {
    const data = await httpsGetJSON(
      `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}`);
    const hit = (data.results || []).find((r) => r.poster_path);
    return hit ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null;
  } catch (_) {
    return null;
  }
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
  .toggle{margin-left:auto;font-size:13px;color:var(--sub);cursor:pointer;display:flex;align-items:center;gap:6px}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:20px;padding:24px}
  .card{background:var(--card);border-radius:10px;overflow:hidden;cursor:pointer;box-shadow:0 2px 8px rgba(60,40,15,.18);transition:transform .12s}
  .card:hover{transform:translateY(-3px)}
  .card.over{outline:3px dashed var(--accent);outline-offset:-3px}
  .thumb{position:relative;aspect-ratio:2/3;background:#d8c191;display:flex;align-items:center;justify-content:center;font-size:46px;color:#a07e4e;overflow:hidden}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .folder .thumb{aspect-ratio:2/3;font-size:54px}
  .findbtn{position:absolute;top:6px;right:6px;border:0;background:rgba(47,65,86,.85);color:#fff;border-radius:6px;padding:3px 7px;font-size:12px;cursor:pointer;display:none}
  .card:hover .findbtn{display:block}
  .label{padding:10px 12px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer}
  button.ghost{background:transparent;color:#f5e9cf;border:1px solid #f5e9cf}
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
  /* player overlay */
  #overlay{position:fixed;inset:0;background:rgba(20,12,4,.92);display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;z-index:10}
  #overlay video{max-width:90vw;max-height:72vh;background:#000;border-radius:8px}
  #overlay .row{display:flex;gap:10px;align-items:center}
  #ptitle{color:#f5e9cf;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px}
</style></head><body>
<header>
  <h1>Casto</h1>
  <div id="crumbs"></div>
  <label class="toggle"><input type="checkbox" id="onlineToggle"> Online posters<span id="keyNote"></span></label>
</header>
<div id="grid"></div>

<aside id="finder">
  <div class="frow"><div id="finderTitle"></div><button class="ghost" id="finderClose" style="color:var(--accent);border-color:var(--accent)">Close</button></div>
  <div class="frow">
    <button id="googleImg">Google Images ↗</button>
    <button id="bingImg">Bing Images ↗</button>
  </div>
  <div class="hint">Opens an image search in a new window. Drag a poster from there onto the box below (or drop one from your desktop).</div>
  <div id="dropzone">Drag a poster image here</div>
</aside>

<div id="overlay">
  <div id="ptitle"></div>
  <video id="player" controls></video>
  <div class="row">
    <select id="devices"><option value="">Cast to TV…</option></select>
    <button id="castBtn">Cast</button>
    <button class="ghost" id="closeBtn">Close</button>
  </div>
  <div id="caststatus" style="color:#f5e9cf;font-size:13px;min-height:18px"></div>
</div>

<script>
let current = '0';
let finderItem = null;
function esc(s){return String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));}

async function browse(id){
  current = id;
  const data = await (await fetch('/api/browse?id='+encodeURIComponent(id))).json();
  document.getElementById('crumbs').innerHTML =
    data.breadcrumb.map(c => '<a onclick="browse(\\''+c.id+'\\')">'+esc(c.title)+'</a>').join(' › ');
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  for(const it of data.items){
    const card = document.createElement('div');
    card.className = 'card' + (it.type==='folder'?' folder':'');
    const thumb = document.createElement('div');
    thumb.className='thumb';
    const fallback = it.type==='folder' ? '📁' : '🎬';
    if(it.poster){
      const img=document.createElement('img'); img.src=it.poster; img.loading='lazy';
      img.onerror=()=>{ img.remove(); if(!thumb.textContent) thumb.textContent=fallback; };
      thumb.appendChild(img);
    } else { thumb.textContent = fallback; }
    if(it.type==='video'){
      const find=document.createElement('button');
      find.className='findbtn'; find.textContent='🔍 poster'; find.title='Find a poster';
      find.onclick=(e)=>{ e.stopPropagation(); openFinder(it); };
      thumb.appendChild(find);
      card.ondragover=(e)=>{ e.preventDefault(); card.classList.add('over'); };
      card.ondragleave=()=> card.classList.remove('over');
      card.ondrop=(e)=>{ card.classList.remove('over'); handleDrop(e, it.id); };
    }
    const label = document.createElement('div');
    label.className='label'; label.textContent = it.title;
    card.appendChild(thumb); card.appendChild(label);
    card.onclick = () => it.type==='folder' ? browse(it.id) : play(it);
    grid.appendChild(card);
  }
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

// --- Online-posters setting ------------------------------------------------
async function loadSettings(){
  const d = await (await fetch('/api/settings')).json();
  document.getElementById('onlineToggle').checked = d.internetPosters;
  document.getElementById('keyNote').textContent = d.hasKey ? '' : ' (needs TMDB_API_KEY)';
}
document.getElementById('onlineToggle').onchange = async (e)=>{
  await fetch('/api/settings?internet='+(e.target.checked), {method:'POST'});
  browse(current);
};

// --- Inline player + cast --------------------------------------------------
let playingId = null;
function play(it){
  playingId = it.id;
  document.getElementById('ptitle').textContent = it.title;
  const v = document.getElementById('player');
  v.src = '/media/'+it.id; v.play().catch(()=>{});
  document.getElementById('caststatus').textContent='';
  document.getElementById('overlay').style.display='flex';
  loadDevices();
}
async function loadDevices(){
  const sel = document.getElementById('devices');
  sel.innerHTML = '<option value="">Finding TVs…</option>';
  const d = await (await fetch('/api/devices')).json();
  sel.innerHTML = '<option value="">Cast to TV…</option>' +
    d.devices.map(x=>'<option value="'+esc(x.name)+'">'+esc(x.name)+'</option>').join('');
}
document.getElementById('castBtn').onclick = async () => {
  const target = document.getElementById('devices').value;
  const st = document.getElementById('caststatus');
  if(!target){ st.textContent='Pick a TV first.'; return; }
  st.textContent='Casting…';
  const d = await (await fetch('/api/cast?id='+encodeURIComponent(playingId)+'&target='+encodeURIComponent(target),{method:'POST'})).json();
  st.textContent = d.ok ? ('Casting to '+target) : ('Failed: '+(d.error||'unknown'));
};
document.getElementById('closeBtn').onclick = () => {
  const v=document.getElementById('player'); v.pause(); v.src='';
  document.getElementById('overlay').style.display='none';
};

loadSettings();
browse('0');
</script>
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
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error('✗ Not a folder: ' + root); process.exit(1); }
  const host = get('--host', localIPv4()) || '127.0.0.1';
  const port = parseInt(get('--port', '8010'), 10);

  console.log('⊙ Indexing…');
  const objects = buildTree(root);
  const name = objects.get('0').title;
  const count = [...objects.values()].filter((n) => !n.container).length;
  if (count === 0) { console.error('✗ No video files under ' + root); process.exit(1); }

  // Persisted settings (currently just the online-poster toggle).
  const CONFIG = path.join(root, '.casto-library.json');
  const settings = { internetPosters: true };
  try { Object.assign(settings, JSON.parse(fs.readFileSync(CONFIG, 'utf8'))); } catch (_) {}
  const saveSettings = () => { try { fs.writeFileSync(CONFIG, JSON.stringify(settings)); } catch (_) {} };

  let rendererCache = { at: 0, list: [] };
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

      if (p === '/api/browse') {
        const node = objects.get(u.searchParams.get('id') || '0');
        if (!node) return json(res, 404, { ok: false });
        const items = (node.children || []).map((cid) => {
          const c = objects.get(cid);
          // Videos always get an /art URL (local file, TMDb, or 404 → UI fallback).
          const poster = c.art || !c.container ? `/art/${c.id}` : null;
          return { id: c.id, title: c.title, type: c.container ? 'folder' : 'video', poster };
        });
        return json(res, 200, { ok: true, folder: { id: node.id, title: node.title }, breadcrumb: breadcrumb(objects, node.id), items });
      }

      if (p === '/api/devices') {
        const list = await renderers();
        return json(res, 200, { ok: true, devices: list.map((d) => ({ name: d.name })) });
      }

      if (p === '/api/settings') {
        if (req.method === 'POST' && u.searchParams.has('internet')) {
          settings.internetPosters = u.searchParams.get('internet') === 'true';
          saveSettings();
        }
        return json(res, 200, { ok: true, internetPosters: settings.internetPosters, hasKey: !!TMDB_API_KEY });
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
        posterCache.delete(node.id);
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
        return json(res, 200, { ok: true, device: dev.name });
      }

      if (p.startsWith('/media/')) {
        const node = objects.get(p.slice('/media/'.length));
        if (!node || node.container) { res.writeHead(404); return res.end('Not found'); }
        return serveFile(req, res, node.file, node.contentType);
      }
      if (p.startsWith('/art/')) {
        const node = objects.get(p.slice('/art/'.length));
        if (!node) { res.writeHead(404); return res.end('Not found'); }
        if (node.art) {
          return serveFile(req, res, node.art, IMAGE_TYPES[path.extname(node.art).toLowerCase()] || 'image/jpeg');
        }
        // No sidecar art: try TMDb (cached), redirect to its poster image.
        if (!settings.internetPosters || !TMDB_API_KEY || node.container) { res.writeHead(404); return res.end('Not found'); }
        let url = posterCache.get(node.id);
        if (url === undefined) { url = await tmdbPoster(node.title); posterCache.set(node.id, url); }
        if (url) { res.writeHead(302, { Location: url }); return res.end(); }
        res.writeHead(404); res.end('Not found');
        return;
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`▶ "${name}" — ${count} videos`);
    console.log(`  posters: sidecar art${TMDB_API_KEY ? ' + TMDb lookup' : ' (set TMDB_API_KEY for auto-posters)'}`);
    console.log(`  open  http://localhost:${port}`);
    console.log(`  (on your network: http://${host}:${port})`);
  });
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
