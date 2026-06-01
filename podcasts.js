#!/usr/bin/env node
'use strict';

// Casto Podcasts — a lightweight, standalone podcast app. Subscribe to shows by
// RSS feed (or find them by searching the public directory), then listen in the
// browser with resume-where-you-left-off, variable speed, and offline download.
//
//   node podcasts.js [--port <n>] [--host <lan-ip>]
//
// No account, no database, no tracking. Subscriptions, listening progress, and
// downloads live in ~/.casto. Open the printed URL in any browser.

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Persistence — everything lives under ~/.casto, never in the app folder, so it
// survives upgrades and a fresh checkout.
// ---------------------------------------------------------------------------
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.casto');
const DL_DIR = path.join(DATA_DIR, 'podcast-downloads');
const STORE = path.join(DATA_DIR, 'podcasts.json');

function ensureDirs() {
  for (const d of [DATA_DIR, DL_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
}

// Shape: { subs: [{feedUrl,title,image,author}], progress:{id:{pos,dur,at}},
//          downloads:{id:{file,url,title,feed,ext}} }
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
  // Debounced async write — progress pings come often while listening.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.writeFile(STORE, JSON.stringify(store), 'utf8').catch(() => {});
  }, 400);
}

// ---------------------------------------------------------------------------
// Networking — fetch with redirect-following, both buffered (feeds, search) and
// streamed (audio proxy with Range so seeking works). No external deps.
// ---------------------------------------------------------------------------
const UA = 'CastoPodcasts/0.1 (+https://github.com/casto)';

// Buffer a URL to memory, following redirects. Resolves {status, headers, body}.
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

// Stream a remote URL to the client, forwarding the Range header so the browser
// can seek. Follows redirects manually (podcast hosts redirect heavily).
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

// ---------------------------------------------------------------------------
// RSS parsing — dependency-free. Podcast feeds are messy but predictable; we
// pull the channel info and per-episode enclosures with tolerant regexes.
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

// First match of <tag ...>value</tag> within `xml`. Returns '' if absent.
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}
// Value of an attribute on the first matching self-closing/opening tag.
function tagAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

// itunes:duration may be seconds (3600) or HH:MM:SS / MM:SS.
function parseDuration(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map((n) => parseInt(n, 10) || 0);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// A stable per-episode id: prefer <guid>, fall back to the audio URL.
function episodeId(guid, audioUrl) {
  return (guid || audioUrl || '').trim() || Math.random().toString(36).slice(2);
}

function parseFeed(xml, feedUrl) {
  const channelMatch = xml.match(/<channel[\s\S]*?>([\s\S]*?)<\/channel>/i);
  const channel = channelMatch ? channelMatch[1] : xml;
  // Channel header is everything before the first <item>.
  const head = channel.split(/<item[\s>]/i)[0];

  const title = tagText(head, 'title') || feedUrl;
  const author = tagText(head, 'itunes:author') || tagText(head, 'managingEditor') || '';
  const description = tagText(head, 'description') || tagText(head, 'itunes:summary') || '';
  const image =
    tagAttr(head, 'itunes:image', 'href') ||
    tagText(head, 'url') || // <image><url>…</url></image>
    '';

  const episodes = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(channel)) && episodes.length < 400) {
    const item = m[1];
    const audioUrl = tagAttr(item, 'enclosure', 'url') || tagAttr(item, 'media:content', 'url');
    if (!audioUrl) continue;
    const guid = tagText(item, 'guid');
    const epImage = tagAttr(item, 'itunes:image', 'href') || image;
    episodes.push({
      id: episodeId(guid, audioUrl),
      title: tagText(item, 'title') || 'Untitled episode',
      audioUrl,
      audioType: tagAttr(item, 'enclosure', 'type') || 'audio/mpeg',
      date: tagText(item, 'pubDate') || '',
      duration: parseDuration(tagText(item, 'itunes:duration')),
      image: epImage,
      description: stripHtml(tagText(item, 'description') || tagText(item, 'itunes:summary') || ''),
    });
  }
  return { feedUrl, title, author, description: stripHtml(description), image, episodes };
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Short-lived in-memory cache of parsed feeds (feeds are refetched on demand
// but we don't want to re-hit the network on every UI interaction).
const feedCache = new Map(); // feedUrl -> { at, feed }
async function getFeed(feedUrl, { force = false } = {}) {
  const hit = feedCache.get(feedUrl);
  if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.feed;
  const { body } = await fetchBuffer(feedUrl);
  const feed = parseFeed(body.toString('utf8'), feedUrl);
  feedCache.set(feedUrl, { at: Date.now(), feed });
  return feed;
}

// ---------------------------------------------------------------------------
// Directory search — Apple's public iTunes Search API. No key required; we
// proxy it so the browser doesn't hit CORS and we normalize the shape.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Local file serving with Range (for offline downloads played back here).
// ---------------------------------------------------------------------------
function serveLocalFile(req, res, filePath, type) {
  let total;
  try { total = fs.statSync(filePath).size; } catch (_) { res.writeHead(404); return res.end('Not found'); }
  const range = req.headers.range;
  const headers = { 'Content-Type': type || 'audio/mpeg', 'Accept-Ranges': 'bytes' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : total - 1;
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

// In-progress downloads, so the UI can show a spinner and we don't start twice.
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

// ---------------------------------------------------------------------------
// HTTP server + routes
// ---------------------------------------------------------------------------
function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'eth0', 'wlan0', ...Object.keys(ifaces)]) {
    for (const a of ifaces[name] || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
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

function start({ port, host }) {
  ensureDirs();
  const json = (res, code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${host}:${port}`);
    const p = u.pathname;
    try {
      if (p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageHTML());
      }

      // --- Subscriptions ---------------------------------------------------
      if (p === '/api/subs') {
        return json(res, 200, { ok: true, subs: store.subs });
      }

      if (p === '/api/subscribe' && req.method === 'POST') {
        const feedUrl = (u.searchParams.get('url') || '').trim();
        if (!/^https?:\/\//i.test(feedUrl)) return json(res, 400, { ok: false, error: 'Enter a valid http(s) feed URL' });
        if (store.subs.some((s) => s.feedUrl === feedUrl)) return json(res, 200, { ok: true, already: true });
        let feed;
        try { feed = await getFeed(feedUrl, { force: true }); }
        catch (e) { return json(res, 502, { ok: false, error: 'Could not load that feed: ' + e.message }); }
        store.subs.push({ feedUrl, title: feed.title, image: feed.image, author: feed.author });
        saveStore();
        return json(res, 200, { ok: true, sub: store.subs[store.subs.length - 1] });
      }

      if (p === '/api/unsubscribe' && req.method === 'POST') {
        const feedUrl = (u.searchParams.get('url') || '').trim();
        store.subs = store.subs.filter((s) => s.feedUrl !== feedUrl);
        saveStore();
        return json(res, 200, { ok: true });
      }

      // --- Feed contents (episodes) ---------------------------------------
      if (p === '/api/feed') {
        const feedUrl = (u.searchParams.get('url') || '').trim();
        if (!feedUrl) return json(res, 400, { ok: false, error: 'missing url' });
        let feed;
        try { feed = await getFeed(feedUrl, { force: u.searchParams.get('refresh') === '1' }); }
        catch (e) { return json(res, 502, { ok: false, error: e.message }); }
        // Attach per-episode progress + download status for the UI.
        const episodes = feed.episodes.map((e) => ({
          ...e, feed: feedUrl,
          progress: store.progress[e.id] || null,
          downloaded: !!store.downloads[e.id],
          downloading: downloading.has(e.id),
        }));
        return json(res, 200, { ok: true, feed: { ...feed, episodes } });
      }

      // --- Directory search ------------------------------------------------
      if (p === '/api/search') {
        const q = (u.searchParams.get('q') || '').trim();
        if (!q) return json(res, 200, { ok: true, results: [] });
        try { return json(res, 200, { ok: true, results: await searchDirectory(q) }); }
        catch (e) { return json(res, 502, { ok: false, error: e.message }); }
      }

      // --- Listening progress ---------------------------------------------
      if (p === '/api/progress' && req.method === 'POST') {
        const body = await readBody(req);
        const id = (body.id || '').trim();
        if (!id) return json(res, 400, { ok: false });
        if (body.pos != null && body.pos >= 0) {
          store.progress[id] = { pos: body.pos, dur: body.dur || 0, at: Date.now() };
          // Auto-clear when essentially finished, so it doesn't show "resume".
          if (body.dur && body.pos >= body.dur - 15) delete store.progress[id];
          saveStore();
        }
        return json(res, 200, { ok: true });
      }
      if (p === '/api/progress' && req.method === 'GET') {
        return json(res, 200, { ok: true, progress: store.progress });
      }

      // --- Offline downloads ----------------------------------------------
      if (p === '/api/download' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.id || !body.audioUrl) return json(res, 400, { ok: false, error: 'missing episode' });
        downloadEpisode(body).catch(() => {}); // fire-and-forget; UI polls status
        return json(res, 200, { ok: true, downloading: true });
      }
      if (p === '/api/download/remove' && req.method === 'POST') {
        const body = await readBody(req);
        const d = store.downloads[body.id];
        if (d) { try { fs.unlinkSync(d.file); } catch (_) {} delete store.downloads[body.id]; saveStore(); }
        return json(res, 200, { ok: true });
      }
      if (p === '/api/downloads') {
        const list = Object.entries(store.downloads).map(([id, d]) => ({ id, title: d.title }));
        return json(res, 200, { ok: true, downloads: list, downloading: [...downloading] });
      }

      // --- Audio: prefer a local download, else proxy the remote with Range
      if (p === '/api/audio') {
        const id = u.searchParams.get('id') || '';
        const d = store.downloads[id];
        if (d && fs.existsSync(d.file)) {
          const type = d.ext === '.m4a' ? 'audio/mp4' : d.ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
          return serveLocalFile(req, res, d.file, type);
        }
        const target = u.searchParams.get('url') || '';
        if (!/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('bad url'); }
        return proxyStream(req, res, target);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    const lan = host || localIPv4();
    console.log('Casto Podcasts is serving:');
    console.log(`  Local:   http://localhost:${port}`);
    if (lan) console.log(`  Network: http://${lan}:${port}`);
    console.log(`  Data:    ${STORE}`);
  });
}

// ---------------------------------------------------------------------------
// The web app — a single self-contained page. Light-wood Casto theme.
// ---------------------------------------------------------------------------
function pageHTML() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Casto Podcasts</title>
<style>
  :root{ --wood:#e9d6b0; --ink:#5b3a22; --sub:#6d5236; --accent:#2f4156; --card:#fbf1dd; --line:#c9ac74; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--wood);color:var(--ink);font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding-bottom:96px}
  header{display:flex;align-items:center;gap:14px;padding:16px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--wood);z-index:6}
  header h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:32px;margin:0;cursor:pointer}
  header .tag{font-size:12px;color:var(--sub);letter-spacing:.12em;text-transform:uppercase}
  .nav{display:flex;gap:6px;margin-left:auto}
  .nav button{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  .nav button.on{background:var(--accent);color:#fff}
  button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 15px;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  input[type=text]{font:inherit;padding:9px 13px;border-radius:20px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-width:240px}
  main{padding:22px 24px;max-width:1100px;margin:0 auto}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .muted{color:var(--sub);font-size:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:18px;margin-top:14px}
  .show{background:var(--card);border-radius:10px;overflow:hidden;cursor:pointer;box-shadow:0 2px 8px rgba(60,40,15,.18);transition:transform .12s}
  .show:hover{transform:translateY(-3px)}
  .show .art{aspect-ratio:1/1;background:#d8c191;display:flex;align-items:center;justify-content:center;font-size:40px;color:#a07e4e;overflow:hidden}
  .show .art img{width:100%;height:100%;object-fit:cover;display:block}
  .show .name{padding:9px 11px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .show .who{padding:0 11px 10px;font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .showhead{display:flex;gap:18px;align-items:flex-start;margin-bottom:8px}
  .showhead img{width:128px;height:128px;border-radius:10px;object-fit:cover;background:#d8c191;flex:none}
  .showhead h2{font-family:'Cormorant Garamond',Georgia,serif;font-size:30px;margin:0 0 4px}
  .desc{font-size:14px;color:var(--sub);max-height:5.4em;overflow:hidden;line-height:1.35;margin-top:6px}
  .ep{background:var(--card);border-radius:10px;padding:13px 15px;margin-top:11px;box-shadow:0 1px 4px rgba(60,40,15,.12)}
  .ep .et{font-weight:600;font-size:15px}
  .ep .em{font-size:12px;color:var(--sub);margin:3px 0 7px}
  .ep .ed{font-size:13px;color:var(--sub);line-height:1.4;max-height:3.9em;overflow:hidden}
  .ep .ea{display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap}
  .ep .ea button{padding:6px 12px;font-size:13px}
  .bar{height:5px;background:#e0cfa6;border-radius:3px;margin-top:8px;overflow:hidden}
  .bar > i{display:block;height:100%;background:var(--accent)}
  .pill{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--sub);border:1px solid var(--line);border-radius:20px;padding:2px 9px}
  .pill.dl{color:#2f6b3a;border-color:#9ec5a4}
  /* player dock */
  #dock{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:2px solid var(--accent);display:none;align-items:center;gap:14px;padding:10px 18px;z-index:30;box-shadow:0 -4px 14px rgba(60,40,15,.2)}
  #dock img{width:54px;height:54px;border-radius:8px;object-fit:cover;background:#d8c191;flex:none}
  #dock .meta{min-width:0}
  #dock .dt{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #dock .ds{font-size:12px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #dock .ctr{display:flex;align-items:center;gap:8px}
  #dock .ctr button{padding:7px 11px;border-radius:8px}
  #dock .seek{flex:1;display:flex;align-items:center;gap:9px;min-width:160px}
  #dock .seek input{flex:1}
  #dock .time{font-variant-numeric:tabular-nums;font-size:12px;color:var(--sub);min-width:42px;text-align:center}
  #speed{background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:8px;padding:6px 8px;font:inherit;cursor:pointer}
  .empty{text-align:center;color:var(--sub);padding:50px 0}
  .spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
  a{color:var(--accent)}
</style></head><body>
<header>
  <h1 id="home">Casto Podcasts</h1>
  <span class="tag">Listen</span>
  <div class="nav">
    <button data-view="subs" class="on">Subscriptions</button>
    <button data-view="search">Find shows</button>
    <button data-view="downloads">Downloads</button>
  </div>
</header>
<main id="main"></main>

<div id="dock">
  <img id="dArt" alt="">
  <div class="meta"><div class="dt" id="dTitle">—</div><div class="ds" id="dShow"></div></div>
  <div class="ctr">
    <button id="dBack" title="Back 15s">« 15</button>
    <button id="dPlay" title="Play/Pause">▶</button>
    <button id="dFwd" title="Forward 30s">30 »</button>
  </div>
  <div class="seek">
    <span class="time" id="dCur">0:00</span>
    <input type="range" id="dSeek" min="0" max="1000" value="0">
    <span class="time" id="dDur">0:00</span>
  </div>
  <select id="speed" title="Playback speed">
    <option value="0.8">0.8×</option><option value="1" selected>1×</option>
    <option value="1.25">1.25×</option><option value="1.5">1.5×</option>
    <option value="1.75">1.75×</option><option value="2">2×</option>
  </select>
  <button id="dClose" class="ghost" title="Close">✕</button>
  <audio id="audio"></audio>
</div>

<script>
const $ = (s) => document.querySelector(s);
const api = async (path, opts) => (await fetch(path, opts)).json();
const esc = (s) => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtTime = (s) => { s = Math.max(0, Math.floor(s||0)); const h = Math.floor(s/3600), m = Math.floor(s%3600/60), x = s%60; return (h?h+':':'')+(h?String(m).padStart(2,'0'):m)+':'+String(x).padStart(2,'0'); };
const fmtDur = (s) => s ? fmtTime(s) : '';
const fmtDate = (d) => { const t = Date.parse(d); return isNaN(t) ? '' : new Date(t).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); };

let view = 'subs';
let current = null;        // currently-playing episode
const main = $('#main');

// ---- Views ----------------------------------------------------------------
async function render() {
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'subs') return renderSubs();
  if (view === 'search') return renderSearch();
  if (view === 'downloads') return renderDownloads();
}

async function renderSubs() {
  main.innerHTML = '<div class="row"><input type="text" id="feedUrl" placeholder="Paste an RSS feed URL…"><button id="addFeed">Subscribe</button><span class="muted">or use “Find shows” to search the directory</span></div><div id="subgrid"></div>';
  $('#addFeed').onclick = addFeed;
  $('#feedUrl').addEventListener('keydown', e => { if (e.key === 'Enter') addFeed(); });
  const { subs } = await api('/api/subs');
  const g = $('#subgrid');
  if (!subs.length) { g.innerHTML = '<div class="empty">No subscriptions yet.<br>Paste a feed URL above, or search the directory under “Find shows”.</div>'; return; }
  g.className = 'grid';
  g.innerHTML = subs.map(s => showCard(s)).join('');
  g.querySelectorAll('.show').forEach(el => el.onclick = () => openShow(el.dataset.url));
}

function showCard(s) {
  const art = s.image ? '<img src="'+esc(s.image)+'" alt="" loading="lazy">' : '🎙';
  return '<div class="show" data-url="'+esc(s.feedUrl)+'"><div class="art">'+art+'</div><div class="name">'+esc(s.title)+'</div><div class="who">'+esc(s.author||'')+'</div></div>';
}

async function addFeed() {
  const url = $('#feedUrl').value.trim();
  if (!url) return;
  $('#addFeed').innerHTML = '<span class="spin"></span>';
  const r = await api('/api/subscribe?url=' + encodeURIComponent(url), { method: 'POST' });
  if (!r.ok) { alert(r.error || 'Could not subscribe'); $('#addFeed').textContent = 'Subscribe'; return; }
  if (r.sub) openShow(r.sub.feedUrl); else renderSubs();
}

async function renderSearch() {
  main.innerHTML = '<div class="row"><input type="text" id="q" placeholder="Search shows by name, topic, person…"><button id="goSearch">Search</button></div><div id="results"></div>';
  $('#goSearch').onclick = doSearch;
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#q').focus();
}
async function doSearch() {
  const q = $('#q').value.trim();
  if (!q) return;
  const box = $('#results');
  box.innerHTML = '<div class="empty"><span class="spin"></span> Searching…</div>';
  const r = await api('/api/search?q=' + encodeURIComponent(q));
  if (!r.ok || !r.results.length) { box.innerHTML = '<div class="empty">No shows found.</div>'; return; }
  box.className = 'grid';
  box.innerHTML = r.results.map(s => showCard(s) + '').join('');
  box.querySelectorAll('.show').forEach(el => el.onclick = () => openShow(el.dataset.url));
}

async function openShow(feedUrl) {
  view = 'show';
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('on'));
  main.innerHTML = '<div class="empty"><span class="spin"></span> Loading episodes…</div>';
  const r = await api('/api/feed?url=' + encodeURIComponent(feedUrl));
  if (!r.ok) { main.innerHTML = '<div class="empty">Could not load this feed.<br><span class="muted">'+esc(r.error||'')+'</span></div>'; return; }
  const f = r.feed;
  const subs = (await api('/api/subs')).subs;
  const subscribed = subs.some(s => s.feedUrl === feedUrl);
  main.innerHTML =
    '<div class="showhead">' +
      (f.image ? '<img src="'+esc(f.image)+'" alt="">' : '') +
      '<div><h2>'+esc(f.title)+'</h2><div class="muted">'+esc(f.author||'')+' · '+f.episodes.length+' episodes</div>' +
      '<div class="row" style="margin-top:8px">' +
        (subscribed
          ? '<button class="ghost" id="subToggle">✓ Subscribed — Unsubscribe</button>'
          : '<button id="subToggle">+ Subscribe</button>') +
        '<button class="ghost" id="refreshFeed">↻ Refresh</button>' +
      '</div>' +
      '<div class="desc">'+esc(f.description||'')+'</div></div>' +
    '</div>' +
    '<div id="eps">' + f.episodes.map(e => epRow(e, f)).join('') + '</div>';
  $('#subToggle').onclick = async () => {
    const ep = subscribed ? '/api/unsubscribe' : '/api/subscribe';
    await api(ep + '?url=' + encodeURIComponent(feedUrl), { method: 'POST' });
    openShow(feedUrl);
  };
  $('#refreshFeed').onclick = async () => { await api('/api/feed?refresh=1&url=' + encodeURIComponent(feedUrl)); openShow(feedUrl); };
  wireEps(f);
}

function epRow(e, f) {
  const pct = e.progress && e.progress.dur ? Math.min(100, 100 * e.progress.pos / e.progress.dur) : 0;
  const resume = e.progress && e.progress.pos > 10;
  const pills =
    (e.duration ? '<span class="pill">'+fmtDur(e.duration)+'</span>' : '') +
    (e.downloaded ? '<span class="pill dl">✓ Offline</span>' : '');
  return '<div class="ep" data-id="'+esc(e.id)+'">' +
    '<div class="et">'+esc(e.title)+'</div>' +
    '<div class="em">'+esc(fmtDate(e.date))+'</div>' +
    '<div class="ed">'+esc(e.description||'')+'</div>' +
    (pct ? '<div class="bar"><i style="width:'+pct+'%"></i></div>' : '') +
    '<div class="ea">' +
      '<button class="play">'+(resume ? '▶ Resume' : '▶ Play')+'</button>' +
      pills +
      (e.downloaded
        ? '<button class="ghost rmdl">Remove download</button>'
        : (e.downloading ? '<button class="ghost dlbtn" disabled><span class="spin"></span> Downloading…</button>'
                         : '<button class="ghost dlbtn">⤓ Download</button>')) +
    '</div></div>';
}

function wireEps(f) {
  document.querySelectorAll('#eps .ep').forEach(row => {
    const id = row.dataset.id;
    const e = f.episodes.find(x => x.id === id);
    row.querySelector('.play').onclick = () => playEpisode(e, f);
    const dl = row.querySelector('.dlbtn');
    if (dl) dl.onclick = async () => {
      dl.disabled = true; dl.innerHTML = '<span class="spin"></span> Downloading…';
      await api('/api/download', { method:'POST', body: JSON.stringify({ id: e.id, audioUrl: e.audioUrl, audioType: e.audioType, title: e.title, feed: f.feedUrl }) });
      pollDownload(e.id, () => openShow(f.feedUrl));
    };
    const rm = row.querySelector('.rmdl');
    if (rm) rm.onclick = async () => { await api('/api/download/remove', { method:'POST', body: JSON.stringify({ id: e.id }) }); openShow(f.feedUrl); };
  });
}

async function pollDownload(id, done) {
  const t = setInterval(async () => {
    const r = await api('/api/downloads');
    const isDl = r.downloading.includes(id);
    const ok = r.downloads.some(d => d.id === id);
    if (!isDl) { clearInterval(t); done && done(); }
    else if (ok) { clearInterval(t); done && done(); }
  }, 1500);
}

async function renderDownloads() {
  main.innerHTML = '<div class="empty"><span class="spin"></span> Loading…</div>';
  const r = await api('/api/downloads');
  if (!r.downloads.length) { main.innerHTML = '<div class="empty">No downloaded episodes yet.<br><span class="muted">Open a show and tap ⤓ Download to save one for offline.</span></div>'; return; }
  main.innerHTML = '<h2 style="font-family:Cormorant Garamond,Georgia,serif">Downloaded episodes</h2>' +
    r.downloads.map(d => '<div class="ep" data-id="'+esc(d.id)+'"><div class="et">'+esc(d.title)+'</div>' +
      '<div class="ea"><button class="play">▶ Play offline</button><span class="pill dl">✓ Offline</span><button class="ghost rmdl">Remove</button></div></div>').join('');
  document.querySelectorAll('#main .ep').forEach(row => {
    const id = row.dataset.id;
    const d = r.downloads.find(x => x.id === id);
    row.querySelector('.play').onclick = () => playEpisode({ id, title: d.title, audioUrl: '', image: '' }, { title: 'Downloaded' });
    row.querySelector('.rmdl').onclick = async () => { await api('/api/download/remove', { method:'POST', body: JSON.stringify({ id }) }); renderDownloads(); };
  });
}

// ---- Player ---------------------------------------------------------------
const audio = $('#audio');
const dock = $('#dock');
let saveTick = 0;

function playEpisode(e, f) {
  current = { ...e, show: f.title, showImg: f.image || e.image };
  dock.style.display = 'flex';
  $('#dArt').src = current.showImg || '';
  $('#dTitle').textContent = e.title;
  $('#dShow').textContent = f.title || '';
  const src = '/api/audio?id=' + encodeURIComponent(e.id) + (e.audioUrl ? '&url=' + encodeURIComponent(e.audioUrl) : '');
  audio.src = src;
  audio.playbackRate = parseFloat($('#speed').value);
  audio.play().catch(()=>{});
}

audio.addEventListener('loadedmetadata', () => {
  // Resume where we left off, if we have a remembered position.
  const pr = current && current.progress;
  if (pr && pr.pos > 10 && pr.pos < audio.duration - 5) audio.currentTime = pr.pos;
  $('#dDur').textContent = fmtTime(audio.duration);
});
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  $('#dCur').textContent = fmtTime(audio.currentTime);
  $('#dSeek').value = String(1000 * audio.currentTime / audio.duration);
  // Persist progress every ~5s of playback.
  if (Date.now() - saveTick > 5000) { saveTick = Date.now(); saveProgress(); }
});
audio.addEventListener('play', () => $('#dPlay').textContent = '⏸');
audio.addEventListener('pause', () => { $('#dPlay').textContent = '▶'; saveProgress(); });
audio.addEventListener('ended', () => { $('#dPlay').textContent = '▶'; saveProgress(); });

function saveProgress() {
  if (!current || !audio.duration) return;
  api('/api/progress', { method:'POST', body: JSON.stringify({ id: current.id, pos: audio.currentTime, dur: audio.duration }) });
}

$('#dPlay').onclick = () => audio.paused ? audio.play() : audio.pause();
$('#dBack').onclick = () => audio.currentTime = Math.max(0, audio.currentTime - 15);
$('#dFwd').onclick  = () => audio.currentTime = Math.min(audio.duration||1e9, audio.currentTime + 30);
$('#dSeek').oninput = () => { if (audio.duration) audio.currentTime = audio.duration * $('#dSeek').value / 1000; };
$('#speed').onchange = () => audio.playbackRate = parseFloat($('#speed').value);
$('#dClose').onclick = () => { saveProgress(); audio.pause(); audio.src=''; dock.style.display='none'; current=null; };
window.addEventListener('beforeunload', saveProgress);

// ---- Nav ------------------------------------------------------------------
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
$('#home').onclick = () => { view = 'subs'; render(); };
render();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  let port = 8788;
  let host = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = parseInt(args[++i], 10) || port;
    else if (args[i] === '--host') host = args[++i];
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log('Casto Podcasts — subscribe by RSS, search the directory, listen with resume/speed/offline.\n');
      console.log('  node podcasts.js [--port <n>] [--host <lan-ip>]');
      return;
    }
  }
  start({ port, host });
}

main();
