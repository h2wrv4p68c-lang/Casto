#!/usr/bin/env node
'use strict';

// Casto Podcasts — core. The podcast engine + a self-contained browser widget,
// factored out so two front-ends can share it without duplication:
//   • podcasts.js          — the standalone podcast app
//   • library.js (the hub) — the "Podcasts" content-type, mounted in the grid
//
// Server side exports a route handler (handlePodcastRoutes) you mount under any
// prefix, plus the parse/search/download primitives. Browser side exports
// podcastCSS / podcastDockHTML / podcastClientJS, which together define a
// window.CastoPod.mount(rootEl, {apiPrefix}) widget that owns its own views,
// player dock, and state. No external dependencies on either side.

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const fsp = fs.promises;

// --- Persistence (shared store under ~/.casto) ------------------------------
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.casto');
const DL_DIR = path.join(DATA_DIR, 'podcast-downloads');
const STORE = path.join(DATA_DIR, 'podcasts.json');

function ensureDirs() {
  for (const d of [DATA_DIR, DL_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return { subs: s.subs || [], progress: s.progress || {}, downloads: s.downloads || {} };
  } catch (_) {
    return { subs: [], progress: {}, downloads: {} };
  }
}

let store = loadStore();
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { fsp.writeFile(STORE, JSON.stringify(store), 'utf8').catch(() => {}); }, 400);
}

// --- Networking -------------------------------------------------------------
const UA = 'CastoPodcasts/0.1 (+https://github.com/casto)';

function fetchBuffer(target, { headers = {}, maxRedirects = 6, limit = 25 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (urlStr, left) => {
      let u;
      try { u = new URL(urlStr); } catch (e) { return reject(e); }
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers } }, (res) => {
        const { statusCode = 0, headers: h } = res;
        if (statusCode >= 300 && statusCode < 400 && h.location && left > 0) {
          res.resume();
          return go(new URL(h.location, u).toString(), left - 1);
        }
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          len += c.length;
          if (len > limit) { req.destroy(); return reject(new Error('response too large')); }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: statusCode, headers: h, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    };
    go(target, maxRedirects);
  });
}

function proxyStream(clientReq, res, target) {
  const range = clientReq.headers.range;
  const reqHeaders = { 'User-Agent': UA, Accept: '*/*' };
  if (range) reqHeaders.Range = range;
  const go = (urlStr, left) => {
    let u;
    try { u = new URL(urlStr); } catch (_) { res.writeHead(400); return res.end('bad upstream url'); }
    const mod = u.protocol === 'https:' ? https : http;
    const upstream = mod.get(u, { headers: reqHeaders }, (up) => {
      const { statusCode = 502, headers: h } = up;
      if (statusCode >= 300 && statusCode < 400 && h.location && left > 0) {
        up.resume();
        return go(new URL(h.location, u).toString(), left - 1);
      }
      const out = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        if (h[k]) out[k] = h[k];
      }
      if (!out['content-type']) out['content-type'] = 'audio/mpeg';
      if (!out['accept-ranges']) out['accept-ranges'] = 'bytes';
      res.writeHead(statusCode, out);
      up.pipe(res);
      clientReq.on('close', () => up.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream error'); });
    upstream.setTimeout(30000, () => upstream.destroy());
  };
  go(target, 6);
}

// --- RSS parsing ------------------------------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}
function tagAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}
function parseDuration(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map((n) => parseInt(n, 10) || 0);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function stripHtml(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function episodeId(guid, audioUrl) { return (guid || audioUrl || '').trim() || Math.random().toString(36).slice(2); }

function parseFeed(xml, feedUrl) {
  const channelMatch = xml.match(/<channel[\s\S]*?>([\s\S]*?)<\/channel>/i);
  const channel = channelMatch ? channelMatch[1] : xml;
  const head = channel.split(/<item[\s>]/i)[0];
  const title = tagText(head, 'title') || feedUrl;
  const author = tagText(head, 'itunes:author') || tagText(head, 'managingEditor') || '';
  const description = tagText(head, 'description') || tagText(head, 'itunes:summary') || '';
  const image = tagAttr(head, 'itunes:image', 'href') || tagText(head, 'url') || '';
  const episodes = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(channel)) && episodes.length < 400) {
    const item = m[1];
    const audioUrl = tagAttr(item, 'enclosure', 'url') || tagAttr(item, 'media:content', 'url');
    if (!audioUrl) continue;
    const guid = tagText(item, 'guid');
    episodes.push({
      id: episodeId(guid, audioUrl),
      title: tagText(item, 'title') || 'Untitled episode',
      audioUrl,
      audioType: tagAttr(item, 'enclosure', 'type') || 'audio/mpeg',
      date: tagText(item, 'pubDate') || '',
      duration: parseDuration(tagText(item, 'itunes:duration')),
      image: tagAttr(item, 'itunes:image', 'href') || image,
      description: stripHtml(tagText(item, 'description') || tagText(item, 'itunes:summary') || ''),
    });
  }
  return { feedUrl, title, author, description: stripHtml(description), image, episodes };
}

const feedCache = new Map();
async function getFeed(feedUrl, { force = false } = {}) {
  const hit = feedCache.get(feedUrl);
  if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.feed;
  const { body } = await fetchBuffer(feedUrl);
  const feed = parseFeed(body.toString('utf8'), feedUrl);
  feedCache.set(feedUrl, { at: Date.now(), feed });
  return feed;
}

// --- Directory search (iTunes) ---------------------------------------------
async function searchDirectory(term) {
  const url = `https://itunes.apple.com/search?media=podcast&limit=25&term=${encodeURIComponent(term)}`;
  const { body } = await fetchBuffer(url, { headers: { Accept: 'application/json' } });
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch (_) { return []; }
  return (data.results || [])
    .filter((r) => r.feedUrl)
    .map((r) => ({
      title: r.collectionName || r.trackName || 'Untitled',
      author: r.artistName || '',
      feedUrl: r.feedUrl,
      image: r.artworkUrl600 || r.artworkUrl100 || '',
      count: r.trackCount || 0,
    }));
}

// --- Local file serving + downloads ----------------------------------------
function serveLocalFile(req, res, filePath, type) {
  let total;
  try { total = fs.statSync(filePath).size; } catch (_) { res.writeHead(404); return res.end('Not found'); }
  const range = req.headers.range;
  const headers = { 'Content-Type': type || 'audio/mpeg', 'Accept-Ranges': 'bytes' };
  if (range) {
    const mm = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = mm[1] ? parseInt(mm[1], 10) : 0;
    const end = mm[2] ? parseInt(mm[2], 10) : total - 1;
    if (start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': total });
    fs.createReadStream(filePath).pipe(res);
  }
}

function extFromType(type, url) {
  const t = (type || '').toLowerCase();
  if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return '.m4a';
  if (t.includes('ogg')) return '.ogg';
  if (t.includes('wav')) return '.wav';
  const ext = path.extname(new URL(url, 'http://x').pathname).toLowerCase();
  return /^\.(mp3|m4a|aac|ogg|wav|mp4)$/.test(ext) ? ext : '.mp3';
}

const downloading = new Set();
async function downloadEpisode(ep) {
  if (store.downloads[ep.id] || downloading.has(ep.id)) return;
  downloading.add(ep.id);
  try {
    const { body } = await fetchBuffer(ep.audioUrl, { limit: 600 * 1024 * 1024 });
    const ext = extFromType(ep.audioType, ep.audioUrl);
    const safe = Buffer.from(ep.id).toString('hex').slice(0, 40);
    const file = path.join(DL_DIR, safe + ext);
    await fsp.writeFile(file, body);
    store.downloads[ep.id] = { file, url: ep.audioUrl, title: ep.title, feed: ep.feed || '', ext };
    saveStore();
  } finally {
    downloading.delete(ep.id);
  }
}

function readBody(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => { len += c.length; if (len <= limit) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// --- Route handler ----------------------------------------------------------
// Mount under any prefix (e.g. '/api' standalone, '/api/pod' in the hub). The
// browser widget is told the same prefix. Returns true if it handled the route.
async function handlePodcastRoutes(req, res, u, json, prefix) {
  const p = u.pathname;
  const at = (s) => p === prefix + s;

  if (at('/subs')) { json(res, 200, { ok: true, subs: store.subs }); return true; }

  if (at('/subscribe') && req.method === 'POST') {
    const feedUrl = (u.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(feedUrl)) { json(res, 400, { ok: false, error: 'Enter a valid http(s) feed URL' }); return true; }
    if (store.subs.some((s) => s.feedUrl === feedUrl)) { json(res, 200, { ok: true, already: true }); return true; }
    let feed;
    try { feed = await getFeed(feedUrl, { force: true }); }
    catch (e) { json(res, 502, { ok: false, error: 'Could not load that feed: ' + e.message }); return true; }
    store.subs.push({ feedUrl, title: feed.title, image: feed.image, author: feed.author });
    saveStore();
    json(res, 200, { ok: true, sub: store.subs[store.subs.length - 1] });
    return true;
  }

  if (at('/unsubscribe') && req.method === 'POST') {
    const feedUrl = (u.searchParams.get('url') || '').trim();
    store.subs = store.subs.filter((s) => s.feedUrl !== feedUrl);
    saveStore();
    json(res, 200, { ok: true });
    return true;
  }

  if (at('/feed')) {
    const feedUrl = (u.searchParams.get('url') || '').trim();
    if (!feedUrl) { json(res, 400, { ok: false, error: 'missing url' }); return true; }
    let feed;
    try { feed = await getFeed(feedUrl, { force: u.searchParams.get('refresh') === '1' }); }
    catch (e) { json(res, 502, { ok: false, error: e.message }); return true; }
    const episodes = feed.episodes.map((e) => ({
      ...e, feed: feedUrl,
      progress: store.progress[e.id] || null,
      downloaded: !!store.downloads[e.id],
      downloading: downloading.has(e.id),
    }));
    json(res, 200, { ok: true, feed: { ...feed, episodes } });
    return true;
  }

  if (at('/search')) {
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) { json(res, 200, { ok: true, results: [] }); return true; }
    try { json(res, 200, { ok: true, results: await searchDirectory(q) }); }
    catch (e) { json(res, 502, { ok: false, error: e.message }); }
    return true;
  }

  if (at('/progress') && req.method === 'POST') {
    const body = await readBody(req);
    const id = (body.id || '').trim();
    if (!id) { json(res, 400, { ok: false }); return true; }
    if (body.pos != null && body.pos >= 0) {
      store.progress[id] = { pos: body.pos, dur: body.dur || 0, at: Date.now() };
      if (body.dur && body.pos >= body.dur - 15) delete store.progress[id];
      saveStore();
    }
    json(res, 200, { ok: true });
    return true;
  }
  if (at('/progress') && req.method === 'GET') { json(res, 200, { ok: true, progress: store.progress }); return true; }

  if (at('/download') && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.id || !body.audioUrl) { json(res, 400, { ok: false, error: 'missing episode' }); return true; }
    downloadEpisode(body).catch(() => {});
    json(res, 200, { ok: true, downloading: true });
    return true;
  }
  if (at('/download/remove') && req.method === 'POST') {
    const body = await readBody(req);
    const d = store.downloads[body.id];
    if (d) { try { fs.unlinkSync(d.file); } catch (_) {} delete store.downloads[body.id]; saveStore(); }
    json(res, 200, { ok: true });
    return true;
  }
  if (at('/downloads')) {
    const list = Object.entries(store.downloads).map(([id, d]) => ({ id, title: d.title }));
    json(res, 200, { ok: true, downloads: list, downloading: [...downloading] });
    return true;
  }

  if (at('/audio')) {
    const id = u.searchParams.get('id') || '';
    const d = store.downloads[id];
    if (d && fs.existsSync(d.file)) {
      const type = d.ext === '.m4a' ? 'audio/mp4' : d.ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
      serveLocalFile(req, res, d.file, type);
      return true;
    }
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) { res.writeHead(400); res.end('bad url'); return true; }
    proxyStream(req, res, target);
    return true;
  }

  return false;
}

// ===========================================================================
// Browser widget — CSS, dock markup, and the client script. The script defines
// window.CastoPod.mount(rootEl, {apiPrefix}); it renders its own nav + views
// into rootEl and a single player dock appended to <body>.
// ===========================================================================
function podcastCSS() {
  return `
  .pod-nav{display:flex;gap:6px;margin-bottom:16px}
  .pod-nav button{background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
  .pod-nav button.on{background:var(--accent);color:#fff}
  .pod .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .pod input[type=text]{font:inherit;padding:9px 13px;border-radius:20px;border:1px solid var(--line,#c9ac74);background:var(--card);color:var(--ink);min-width:240px}
  .pod .muted{color:var(--sub);font-size:14px}
  .pod-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:18px;margin-top:14px}
  .pod-show{background:var(--card);border-radius:10px;overflow:hidden;cursor:pointer;box-shadow:0 2px 8px rgba(60,40,15,.18);transition:transform .12s}
  .pod-show:hover{transform:translateY(-3px)}
  .pod-show .art{aspect-ratio:1/1;background:#d8c191;display:flex;align-items:center;justify-content:center;font-size:40px;color:#a07e4e;overflow:hidden}
  .pod-show .art img{width:100%;height:100%;object-fit:cover;display:block}
  .pod-show .name{padding:9px 11px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pod-show .who{padding:0 11px 10px;font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pod-head{display:flex;gap:18px;align-items:flex-start;margin-bottom:8px}
  .pod-head img{width:128px;height:128px;border-radius:10px;object-fit:cover;background:#d8c191;flex:none}
  .pod-head h2{font-family:'Cormorant Garamond',Georgia,serif;font-size:30px;margin:0 0 4px}
  .pod-desc{font-size:14px;color:var(--sub);max-height:5.4em;overflow:hidden;line-height:1.35;margin-top:6px}
  .pod-ep{background:var(--card);border-radius:10px;padding:13px 15px;margin-top:11px;box-shadow:0 1px 4px rgba(60,40,15,.12)}
  .pod-ep .et{font-weight:600;font-size:15px}
  .pod-ep .em{font-size:12px;color:var(--sub);margin:3px 0 7px}
  .pod-ep .ed{font-size:13px;color:var(--sub);line-height:1.4;max-height:3.9em;overflow:hidden}
  .pod-ep .ea{display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap}
  .pod-ep .ea button{padding:6px 12px;font-size:13px;border-radius:8px}
  .pod-bar{height:5px;background:#e0cfa6;border-radius:3px;margin-top:8px;overflow:hidden}
  .pod-bar > i{display:block;height:100%;background:var(--accent)}
  .pod-pill{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--sub);border:1px solid var(--line,#c9ac74);border-radius:20px;padding:2px 9px}
  .pod-pill.dl{color:#2f6b3a;border-color:#9ec5a4}
  .pod-empty{text-align:center;color:var(--sub);padding:50px 0}
  .pod-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line,#c9ac74);border-top-color:var(--accent);border-radius:50%;animation:podsp .8s linear infinite;vertical-align:-2px}
  @keyframes podsp{to{transform:rotate(360deg)}}
  #podDock{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:2px solid var(--accent);display:none;align-items:center;gap:14px;padding:10px 18px;z-index:40;box-shadow:0 -4px 14px rgba(60,40,15,.2)}
  #podDock img{width:54px;height:54px;border-radius:8px;object-fit:cover;background:#d8c191;flex:none}
  #podDock .meta{min-width:0}
  #podDock .dt{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #podDock .ds{font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #podDock .ctr{display:flex;align-items:center;gap:8px}
  #podDock .ctr button{padding:7px 11px;border-radius:8px}
  #podDock .seek{flex:1;display:flex;align-items:center;gap:9px;min-width:160px}
  #podDock .seek input{flex:1}
  #podDock .time{font-variant-numeric:tabular-nums;font-size:12px;color:var(--sub);min-width:42px;text-align:center}
  #podDock select{background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:8px;padding:6px 8px;font:inherit;cursor:pointer}
  #podDock button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:8px;cursor:pointer}
  #podDock button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  .pod-ep .ea button.cast{color:var(--accent)}
  #podCastMenu{position:fixed;background:var(--card);border:1px solid var(--accent);border-radius:10px;box-shadow:0 6px 20px rgba(60,40,15,.3);padding:6px;z-index:60;display:none;min-width:180px}
  #podCastMenu .ttl{font-size:12px;color:var(--sub);padding:4px 8px}
  #podCastMenu button{display:block;width:100%;text-align:left;background:transparent;color:var(--ink);border:0;border-radius:6px;padding:8px 10px;font:inherit;cursor:pointer}
  #podCastMenu button:hover{background:#efe2c4}
  #podToast{position:fixed;bottom:88px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:9px 16px;border-radius:20px;font-size:14px;z-index:70;display:none;box-shadow:0 4px 14px rgba(60,40,15,.3)}
  `;
}

function podcastDockHTML() {
  return `
<div id="podDock">
  <img id="pdArt" alt="">
  <div class="meta"><div class="dt" id="pdTitle">—</div><div class="ds" id="pdShow"></div></div>
  <div class="ctr">
    <button id="pdBack" title="Back 15s">« 15</button>
    <button id="pdPlay" title="Play/Pause">▶</button>
    <button id="pdFwd" title="Forward 30s">30 »</button>
  </div>
  <div class="seek">
    <span class="time" id="pdCur">0:00</span>
    <input type="range" id="pdSeek" min="0" max="1000" value="0">
    <span class="time" id="pdDur">0:00</span>
  </div>
  <select id="pdSpeed" title="Playback speed">
    <option value="0.8">0.8×</option><option value="1" selected>1×</option>
    <option value="1.25">1.25×</option><option value="1.5">1.5×</option>
    <option value="1.75">1.75×</option><option value="2">2×</option>
  </select>
  <button id="pdCast" class="ghost" title="Cast to a TV or speaker" style="display:none">📺 Cast</button>
  <button id="pdClose" class="ghost" title="Close">✕</button>
  <audio id="podAudio"></audio>
</div>
<div id="podCastMenu"></div>
<div id="podToast"></div>`;
}

function podcastClientJS() {
  return `
(function(){
  const esc = (s) => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtTime = (s) => { s = Math.max(0, Math.floor(s||0)); const h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = s%60; return (h?h+':':'')+(h?String(m).padStart(2,'0'):m)+':'+String(x).padStart(2,'0'); };
  const fmtDate = (d) => { const t = Date.parse(d); return isNaN(t) ? '' : new Date(t).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); };

  let API = '/api';
  let CAST = null; // cast route prefix; null in the standalone app (no casting)
  const api = async (path, opts) => (await fetch(API + path, opts)).json();

  let root = null, content = null, view = 'subs', current = null;

  // --- Flinging (cast to a TV / speaker) -----------------------------------
  function toast(msg){
    const t = document.getElementById('podToast'); if (!t) return;
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 2600);
  }
  function chooseDevice(devs, anchor){
    return new Promise((resolve) => {
      const menu = document.getElementById('podCastMenu');
      menu.innerHTML = '<div class="ttl">Cast to…</div>' + devs.map((d,i) => '<button data-i="'+i+'">📺 '+esc(d.name)+'</button>').join('');
      const r = anchor.getBoundingClientRect();
      menu.style.display = 'block';
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.max(8, r.top - menu.offsetHeight - 8) + 'px';
      const close = (val) => { menu.style.display = 'none'; document.removeEventListener('mousedown', onDoc, true); resolve(val); };
      const onDoc = (e) => { if (!menu.contains(e.target)) close(null); };
      menu.querySelectorAll('button').forEach(b => b.onclick = () => close(devs[+b.dataset.i].name));
      setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    });
  }
  async function castEpisode(ep, anchor){
    if (!CAST) return;
    let r; try { r = await (await fetch(CAST + '/devices')).json(); } catch(_) { r = {}; }
    const devs = r.devices || [];
    if (!devs.length){ toast('No TVs or speakers found on the network'); return; }
    const pick = devs.length === 1 ? devs[0].name : await chooseDevice(devs, anchor);
    if (!pick) return;
    const q = '?id=' + encodeURIComponent(ep.id) + (ep.audioUrl ? '&url=' + encodeURIComponent(ep.audioUrl) : '') +
              '&title=' + encodeURIComponent(ep.title || 'Podcast') + '&target=' + encodeURIComponent(pick);
    let res; try { res = await (await fetch(CAST + '/cast' + q, { method:'POST' })).json(); } catch(_) { res = {}; }
    if (res.ok){
      toast('Casting to ' + res.device + ' — control it from “Now Playing”');
      try { document.getElementById('podAudio').pause(); } catch(_) {} // avoid double audio
    } else toast(res.error || 'Cast failed');
  }

  function showCard(s){
    const art = s.image ? '<img src="'+esc(s.image)+'" alt="" loading="lazy">' : '🎙';
    return '<div class="pod-show" data-url="'+esc(s.feedUrl)+'"><div class="art">'+art+'</div><div class="name">'+esc(s.title)+'</div><div class="who">'+esc(s.author||'')+'</div></div>';
  }

  function setNav(){
    root.querySelectorAll('.pod-nav button').forEach(b => b.classList.toggle('on', b.dataset.pview === view));
  }

  async function render(){
    setNav();
    if (view === 'subs') return renderSubs();
    if (view === 'search') return renderSearch();
    if (view === 'downloads') return renderDownloads();
  }

  async function renderSubs(){
    content.innerHTML = '<div class="row"><input type="text" id="pFeedUrl" placeholder="Paste an RSS feed URL…"><button id="pAddFeed">Subscribe</button><span class="muted">or use “Find shows” to search the directory</span></div><div id="pSubgrid"></div>';
    content.querySelector('#pAddFeed').onclick = addFeed;
    content.querySelector('#pFeedUrl').addEventListener('keydown', e => { if (e.key === 'Enter') addFeed(); });
    const { subs } = await api('/subs');
    const g = content.querySelector('#pSubgrid');
    if (!subs.length){ g.innerHTML = '<div class="pod-empty">No subscriptions yet.<br>Paste a feed URL above, or search the directory under “Find shows”.</div>'; return; }
    g.className = 'pod-grid';
    g.innerHTML = subs.map(showCard).join('');
    g.querySelectorAll('.pod-show').forEach(el => el.onclick = () => openShow(el.dataset.url));
  }

  async function addFeed(){
    const inp = content.querySelector('#pFeedUrl'); const url = inp.value.trim(); if (!url) return;
    const btn = content.querySelector('#pAddFeed'); btn.innerHTML = '<span class="pod-spin"></span>';
    const r = await api('/subscribe?url=' + encodeURIComponent(url), { method:'POST' });
    if (!r.ok){ alert(r.error || 'Could not subscribe'); btn.textContent = 'Subscribe'; return; }
    if (r.sub) openShow(r.sub.feedUrl); else renderSubs();
  }

  async function renderSearch(){
    content.innerHTML = '<div class="row"><input type="text" id="pq" placeholder="Search shows by name, topic, person…"><button id="pGo">Search</button></div><div id="pResults"></div>';
    content.querySelector('#pGo').onclick = doSearch;
    const q = content.querySelector('#pq');
    q.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    q.focus();
  }
  async function doSearch(){
    const q = content.querySelector('#pq').value.trim(); if (!q) return;
    const box = content.querySelector('#pResults');
    box.innerHTML = '<div class="pod-empty"><span class="pod-spin"></span> Searching…</div>';
    const r = await api('/search?q=' + encodeURIComponent(q));
    if (!r.ok || !r.results.length){ box.className=''; box.innerHTML = '<div class="pod-empty">No shows found.</div>'; return; }
    box.className = 'pod-grid';
    box.innerHTML = r.results.map(showCard).join('');
    box.querySelectorAll('.pod-show').forEach(el => el.onclick = () => openShow(el.dataset.url));
  }

  async function openShow(feedUrl){
    setNav();
    content.innerHTML = '<div class="pod-empty"><span class="pod-spin"></span> Loading episodes…</div>';
    const r = await api('/feed?url=' + encodeURIComponent(feedUrl));
    if (!r.ok){ content.innerHTML = '<div class="pod-empty">Could not load this feed.<br><span class="muted">'+esc(r.error||'')+'</span></div>'; return; }
    const f = r.feed;
    const subs = (await api('/subs')).subs;
    const subscribed = subs.some(s => s.feedUrl === feedUrl);
    content.innerHTML =
      '<div class="pod-head">' +
        (f.image ? '<img src="'+esc(f.image)+'" alt="">' : '') +
        '<div><h2>'+esc(f.title)+'</h2><div class="muted">'+esc(f.author||'')+' · '+f.episodes.length+' episodes</div>' +
        '<div class="row" style="margin-top:8px">' +
          (subscribed ? '<button class="ghost" id="pSubToggle">✓ Subscribed — Unsubscribe</button>' : '<button id="pSubToggle">+ Subscribe</button>') +
          '<button class="ghost" id="pRefresh">↻ Refresh</button>' +
        '</div>' +
        '<div class="pod-desc">'+esc(f.description||'')+'</div></div>' +
      '</div>' +
      '<div id="pEps">' + f.episodes.map(e => epRow(e, f)).join('') + '</div>';
    content.querySelector('#pSubToggle').onclick = async () => {
      const ep = subscribed ? '/unsubscribe' : '/subscribe';
      await api(ep + '?url=' + encodeURIComponent(feedUrl), { method:'POST' });
      openShow(feedUrl);
    };
    content.querySelector('#pRefresh').onclick = async () => { await api('/feed?refresh=1&url=' + encodeURIComponent(feedUrl)); openShow(feedUrl); };
    wireEps(f);
  }

  function epRow(e){
    const pct = e.progress && e.progress.dur ? Math.min(100, 100 * e.progress.pos / e.progress.dur) : 0;
    const resume = e.progress && e.progress.pos > 10;
    const pills = (e.duration ? '<span class="pod-pill">'+fmtTime(e.duration)+'</span>' : '') + (e.downloaded ? '<span class="pod-pill dl">✓ Offline</span>' : '');
    return '<div class="pod-ep" data-id="'+esc(e.id)+'">' +
      '<div class="et">'+esc(e.title)+'</div>' +
      '<div class="em">'+esc(fmtDate(e.date))+'</div>' +
      '<div class="ed">'+esc(e.description||'')+'</div>' +
      (pct ? '<div class="pod-bar"><i style="width:'+pct+'%"></i></div>' : '') +
      '<div class="ea">' +
        '<button class="play">'+(resume ? '▶ Resume' : '▶ Play')+'</button>' +
        (CAST ? '<button class="ghost cast">📺 Cast</button>' : '') + pills +
        (e.downloaded ? '<button class="ghost rmdl">Remove download</button>' :
          (e.downloading ? '<button class="ghost dlbtn" disabled><span class="pod-spin"></span> Downloading…</button>' : '<button class="ghost dlbtn">⤓ Download</button>')) +
      '</div></div>';
  }

  function wireEps(f){
    content.querySelectorAll('#pEps .pod-ep').forEach(row => {
      const id = row.dataset.id;
      const e = f.episodes.find(x => x.id === id);
      row.querySelector('.play').onclick = () => playEpisode(e, f);
      const cb = row.querySelector('.cast');
      if (cb) cb.onclick = () => castEpisode({ id:e.id, audioUrl:e.audioUrl, title:e.title }, cb);
      const dl = row.querySelector('.dlbtn');
      if (dl) dl.onclick = async () => {
        dl.disabled = true; dl.innerHTML = '<span class="pod-spin"></span> Downloading…';
        await api('/download', { method:'POST', body: JSON.stringify({ id:e.id, audioUrl:e.audioUrl, audioType:e.audioType, title:e.title, feed:f.feedUrl }) });
        pollDownload(e.id, () => openShow(f.feedUrl));
      };
      const rm = row.querySelector('.rmdl');
      if (rm) rm.onclick = async () => { await api('/download/remove', { method:'POST', body: JSON.stringify({ id:e.id }) }); openShow(f.feedUrl); };
    });
  }

  async function pollDownload(id, done){
    const t = setInterval(async () => {
      const r = await api('/downloads');
      if (!r.downloading.includes(id) || r.downloads.some(d => d.id === id)) { clearInterval(t); done && done(); }
    }, 1500);
  }

  async function renderDownloads(){
    content.innerHTML = '<div class="pod-empty"><span class="pod-spin"></span> Loading…</div>';
    const r = await api('/downloads');
    if (!r.downloads.length){ content.innerHTML = '<div class="pod-empty">No downloaded episodes yet.<br><span class="muted">Open a show and tap ⤓ Download to save one for offline.</span></div>'; return; }
    content.innerHTML = '<h2 style="font-family:Cormorant Garamond,Georgia,serif">Downloaded episodes</h2>' +
      r.downloads.map(d => '<div class="pod-ep" data-id="'+esc(d.id)+'"><div class="et">'+esc(d.title)+'</div>' +
        '<div class="ea"><button class="play">▶ Play offline</button>' + (CAST ? '<button class="ghost cast">📺 Cast</button>' : '') +
        '<span class="pod-pill dl">✓ Offline</span><button class="ghost rmdl">Remove</button></div></div>').join('');
    content.querySelectorAll('.pod-ep').forEach(row => {
      const id = row.dataset.id;
      const d = r.downloads.find(x => x.id === id);
      row.querySelector('.play').onclick = () => playEpisode({ id, title:d.title, audioUrl:'', image:'' }, { title:'Downloaded' });
      const cb = row.querySelector('.cast');
      if (cb) cb.onclick = () => castEpisode({ id, audioUrl:'', title:d.title }, cb);
      row.querySelector('.rmdl').onclick = async () => { await api('/download/remove', { method:'POST', body: JSON.stringify({ id }) }); renderDownloads(); };
    });
  }

  // --- Player dock ---------------------------------------------------------
  let audio, dock, saveTick = 0, wired = false;
  function ensureDock(){
    audio = document.getElementById('podAudio');
    dock = document.getElementById('podDock');
    if (wired) return;
    wired = true;
    const $ = (id) => document.getElementById(id);
    audio.addEventListener('loadedmetadata', () => {
      const pr = current && current.progress;
      if (pr && pr.pos > 10 && pr.pos < audio.duration - 5) audio.currentTime = pr.pos;
      $('pdDur').textContent = fmtTime(audio.duration);
    });
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      $('pdCur').textContent = fmtTime(audio.currentTime);
      $('pdSeek').value = String(1000 * audio.currentTime / audio.duration);
      if (Date.now() - saveTick > 5000){ saveTick = Date.now(); saveProgress(); }
    });
    audio.addEventListener('play', () => $('pdPlay').textContent = '⏸');
    audio.addEventListener('pause', () => { $('pdPlay').textContent = '▶'; saveProgress(); });
    audio.addEventListener('ended', () => { $('pdPlay').textContent = '▶'; saveProgress(); });
    $('pdPlay').onclick = () => audio.paused ? audio.play() : audio.pause();
    $('pdBack').onclick = () => audio.currentTime = Math.max(0, audio.currentTime - 15);
    $('pdFwd').onclick  = () => audio.currentTime = Math.min(audio.duration||1e9, audio.currentTime + 30);
    $('pdSeek').oninput = () => { if (audio.duration) audio.currentTime = audio.duration * $('pdSeek').value / 1000; };
    $('pdSpeed').onchange = () => audio.playbackRate = parseFloat($('pdSpeed').value);
    $('pdCast').onclick = () => { if (current) castEpisode(current, $('pdCast')); };
    $('pdClose').onclick = () => { saveProgress(); audio.pause(); audio.src=''; dock.style.display='none'; current=null; };
    window.addEventListener('beforeunload', saveProgress);
  }
  function saveProgress(){
    if (!current || !audio.duration) return;
    api('/progress', { method:'POST', body: JSON.stringify({ id: current.id, pos: audio.currentTime, dur: audio.duration }) });
  }
  function playEpisode(e, f){
    ensureDock();
    current = { ...e, show: f.title, showImg: f.image || e.image };
    dock.style.display = 'flex';
    document.getElementById('pdArt').src = current.showImg || '';
    document.getElementById('pdTitle').textContent = e.title;
    document.getElementById('pdShow').textContent = f.title || '';
    const src = API + '/audio?id=' + encodeURIComponent(e.id) + (e.audioUrl ? '&url=' + encodeURIComponent(e.audioUrl) : '');
    audio.src = src;
    audio.playbackRate = parseFloat(document.getElementById('pdSpeed').value);
    audio.play().catch(()=>{});
  }

  // --- Public mount --------------------------------------------------------
  function mount(rootEl, opts){
    opts = opts || {};
    API = opts.apiPrefix || '/api';
    CAST = opts.castPrefix || null;
    root = rootEl;
    view = 'subs';
    root.classList.add('pod');
    root.innerHTML =
      '<div class="pod-nav">' +
        '<button data-pview="subs" class="on">Subscriptions</button>' +
        '<button data-pview="search">Find shows</button>' +
        '<button data-pview="downloads">Downloads</button>' +
      '</div><div class="pod-content"></div>';
    content = root.querySelector('.pod-content');
    root.querySelectorAll('.pod-nav button').forEach(b => b.onclick = () => { view = b.dataset.pview; render(); });
    ensureDock();
    const castBtn = document.getElementById('pdCast'); if (castBtn) castBtn.style.display = CAST ? '' : 'none';
    render();
  }

  window.CastoPod = { mount };
})();`;
}

module.exports = {
  ensureDirs, handlePodcastRoutes, readBody,
  fetchBuffer, proxyStream, getFeed, searchDirectory, downloadEpisode,
  podcastCSS, podcastDockHTML, podcastClientJS,
  STORE, DL_DIR,
};
