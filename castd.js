#!/usr/bin/env node
'use strict';

// Casto cast daemon — manage multiple simultaneous streams across multiple
// TVs from one process, driven by a small localhost control API. Each DLNA
// renderer is independent, so different content can play on each TV at once
// (DLNA has no cross-room sync, so they are not frame-locked).
//
//   node castd.js [--port <n>] [--host <lan-ip>]
//
// API (all return JSON):
//   GET  /devices                       discover renderers
//   GET  /sessions                      list active streams
//   POST /cast?target=<name>&src=<path|url>   start a stream on a TV
//   POST /control?session=<id>&action=play|pause|stop|forward|back
//
// Example:
//   curl "http://127.0.0.1:7700/cast?target=Living%20Room&src=/movies/a.mp4"
//   curl "http://127.0.0.1:7700/cast?target=Bedroom&src=/movies/b.mp4"

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const DLNA_FEATURES =
  'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
const CONTENT_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.3gp': 'video/3gpp',
};
const VIDEO_EXTS = Object.keys(CONTENT_TYPES);

function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'eth0', 'wlan0', ...Object.keys(ifaces)]) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}
const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const isRemote = (s) => /^https?:\/\//i.test(s);

// --- Discovery -------------------------------------------------------------

function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msearch = (st) =>
      Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' + `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\nMX: 2\r\n' + `ST: ${st}\r\n\r\n`
      );
    sock.on('message', (msg) => {
      const t = msg.toString();
      if (!/AVTransport|MediaRenderer/i.test(t)) return;
      const m = /^LOCATION:\s*(.+)$/im.exec(t);
      if (m) found.set(m[1].trim(), true);
    });
    sock.on('error', () => {});
    sock.bind(() => {
      const blast = () => {
        for (const st of ['urn:schemas-upnp-org:device:MediaRenderer:1', AVT]) {
          const p = msearch(st);
          sock.send(p, 0, p.length, SSDP_PORT, SSDP_ADDR);
        }
      };
      blast();
      setTimeout(blast, 800);
    });
    setTimeout(() => {
      try { sock.close(); } catch (_) {}
      resolve([...found.keys()]);
    }, timeoutMs);
  });
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

function parseDevice(xml, location) {
  if (!/urn:schemas-upnp-org:service:AVTransport/.test(xml)) return null;
  const name = (/<friendlyName>([^<]*)<\/friendlyName>/i.exec(xml) || [])[1] || 'Unknown';
  const base = (/<URLBase>([^<]*)<\/URLBase>/i.exec(xml) || [])[1] || location;
  for (const svc of xml.split(/<service>/i)) {
    if (/AVTransport/i.test(svc)) {
      const cu = /<controlURL>([^<]*)<\/controlURL>/i.exec(svc);
      if (cu) return { name: name.trim(), controlURL: new URL(cu[1].trim(), base).href };
    }
  }
  return null;
}

async function findRenderers() {
  const locations = await discover();
  const out = [];
  const seen = new Set();
  for (const loc of locations) {
    try {
      const dev = parseDevice(await httpGet(loc), loc);
      if (dev && !seen.has(dev.controlURL)) { seen.add(dev.controlURL); out.push(dev); }
    } catch (_) {}
  }
  return out;
}

// --- SOAP / transport ------------------------------------------------------

function soap(controlURL, action, body) {
  const env =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${AVT}">` + body + `</u:${action}></s:Body></s:Envelope>`;
  const u = new URL(controlURL);
  const opts = {
    method: 'POST', hostname: u.hostname, port: u.port || 80,
    path: u.pathname + u.search,
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(env),
      SOAPAction: `"${AVT}#${action}"`, Connection: 'close',
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () =>
        res.statusCode >= 400 ? reject(new Error(`${action} HTTP ${res.statusCode}`)) : resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('SOAP timeout')));
    req.end(env);
  });
}

const transport = {
  play: (c) => soap(c, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>'),
  pause: (c) => soap(c, 'Pause', '<InstanceID>0</InstanceID>'),
  stop: (c) => soap(c, 'Stop', '<InstanceID>0</InstanceID>'),
};
const hms = (s) => { s = Math.max(0, Math.floor(s)); const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0;
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
async function transportState(controlURL) {
  const r = await soap(controlURL, 'GetTransportInfo', '<InstanceID>0</InstanceID>');
  return (/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i.exec(r) || [])[1] || '';
}
async function seekRelative(controlURL, delta) {
  const info = await soap(controlURL, 'GetPositionInfo', '<InstanceID>0</InstanceID>');
  const t = (/<RelTime>([^<]*)<\/RelTime>/i.exec(info) || [])[1] || '0:00:00';
  const m = /(\d+):(\d+):(\d+)/.exec(t) || [0, 0, 0, 0];
  const cur = +m[1] * 3600 + +m[2] * 60 + +m[3];
  await soap(controlURL, 'Seek',
    `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${hms(cur + delta)}</Target>`);
}

function didl(title, url, contentType) {
  const inner =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:${contentType}:${DLNA_FEATURES}">${xmlEscape(url)}</res>` +
    '</item></DIDL-Lite>';
  return inner;
}
async function castTo(controlURL, url, title, contentType) {
  await soap(controlURL, 'SetAVTransportURI',
    '<InstanceID>0</InstanceID>' +
    `<CurrentURI>${xmlEscape(url)}</CurrentURI>` +
    `<CurrentURIMetaData>${xmlEscape(didl(title, url, contentType))}</CurrentURIMetaData>`);
  await transport.play(controlURL);
}

// --- Shared media server ---------------------------------------------------

// One server for all sessions; local files are registered and served by id.
function createMediaServer(host) {
  const files = new Map(); // id -> { path, contentType, size }
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url.split('?')[0].replace(/^\/media\//, ''));
    const f = files.get(id);
    if (!f) { res.writeHead(404); return res.end('Not found'); }
    const headers = {
      'Content-Type': f.contentType, 'Accept-Ranges': 'bytes',
      'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': DLNA_FEATURES,
    };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? +m[1] : 0;
      let end = m && m[2] ? +m[2] : f.size - 1;
      if (start >= f.size) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
      if (end >= f.size) end = f.size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${f.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(f.path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': f.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(f.path).pipe(res);
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => {
      const base = `http://${host}:${server.address().port}`;
      resolve({
        register(filePath) {
          const id = crypto.randomBytes(6).toString('hex');
          files.set(id, {
            path: filePath, size: fs.statSync(filePath).size,
            contentType: CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'video/mp4',
          });
          return { url: `${base}/media/${id}`, contentType: files.get(id).contentType };
        },
      });
    });
  });
}

// --- Daemon ----------------------------------------------------------------

const TOKEN_FILE = path.join(os.homedir(), '.casto', 'token');
function loadToken() {
  if (process.env.CASTO_TOKEN) return process.env.CASTO_TOKEN;
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch (_) { return null; }
}
const isLoopback = (addr) =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; };
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(
      'Casto cast daemon\n' +
      '  node castd.js [--port <n>] [--host <lan-ip>] [--bind <addr>]\n' +
      '               [--library <folder>] [--autoplay]\n' +
      '  node castd.js --set-token <password>   set your own LAN password\n' +
      '  node castd.js --gen-token              generate a random one\n\n' +
      'Local (loopback) requests need no password. Remote requests require it\n' +
      'in an X-Casto-Token header; start with --bind 0.0.0.0 to allow them.');
    return;
  }
  // Set/persist the LAN password (shared secret) for remote control. Set once.
  const setIdx = argv.indexOf('--set-token');
  if (setIdx >= 0 || argv.includes('--gen-token')) {
    const chosen = setIdx >= 0 ? argv[setIdx + 1] : null;
    if (setIdx >= 0 && (!chosen || chosen.startsWith('--'))) {
      console.error('✗ usage: --set-token <password>');
      process.exit(1);
    }
    const t = chosen || crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
    console.log(`LAN password saved to ${TOKEN_FILE}.`);
    if (!chosen) console.log(`Password: ${t}`);
    console.log('Copy it to the controlling machine (CASTO_TOKEN env or its own ~/.casto/token).');
    return;
  }
  const host = get('--host', localIPv4());
  if (!host) { console.error('✗ Could not determine LAN IP; pass --host.'); process.exit(1); }
  const apiPort = parseInt(get('--port', '7700'), 10);
  const bind = get('--bind', '127.0.0.1');
  const token = loadToken();
  const autoplayDefault = argv.includes('--autoplay');

  // Optional media library: index a folder so the CLI can list/cast by name.
  const libraryDir = get('--library', null);
  const library = []; // { id, title, file }
  if (libraryDir) {
    const root = path.resolve(libraryDir);
    let id = 1;
    (function walk(dir) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (VIDEO_EXTS.includes(path.extname(e.name).toLowerCase()))
          library.push({ id: String(id++), title: path.basename(e.name, path.extname(e.name)), file: fp });
      }
    })(root);
  }
  const libById = new Map(library.map((m) => [m.id, m]));
  const libByName = (name) =>
    library.find((m) => m.title.toLowerCase().includes(String(name).toLowerCase()));

  const media = await createMediaServer(host);
  const sessions = new Map();        // sessionId -> { device, controlURL, src, url }
  const queues = new Map();          // tvName -> [ { src, title } ]
  const autoplayOn = new Map();      // tvName -> bool
  const currentByDevice = new Map(); // tvName -> { controlURL }
  const lastState = new Map();       // tvName -> last TransportState seen
  const queueFor = (tv) => { if (!queues.has(tv)) queues.set(tv, []); return queues.get(tv); };

  // Turn a src (library id, library name, local path, or URL) into a playable
  // URL + metadata. Local files are registered on the shared media server.
  const resolveSource = (raw) => {
    let src = raw;
    const lib = libById.get(raw) || libByName(raw);
    if (lib) src = lib.file;
    if (isRemote(src)) {
      return {
        url: src, src,
        contentType: CONTENT_TYPES[path.extname(new URL(src).pathname).toLowerCase()] || 'video/mp4',
        title: lib ? lib.title : (path.basename(new URL(src).pathname) || 'Stream'),
      };
    }
    const p = path.resolve(src);
    if (!fs.existsSync(p)) throw new Error('file not found: ' + src);
    const reg = media.register(p);
    return { url: reg.url, src: p, contentType: reg.contentType, title: lib ? lib.title : path.basename(p) };
  };

  // Play the next queued item on a TV (used by /queue/next and autoplay).
  const playNext = async (tv) => {
    const q = queueFor(tv);
    const cur = currentByDevice.get(tv);
    if (!q.length || !cur) return null;
    const item = q.shift();
    const r = resolveSource(item.src);
    await castTo(cur.controlURL, r.url, r.title, r.contentType);
    lastState.set(tv, 'PLAYING');
    const session = crypto.randomBytes(4).toString('hex');
    sessions.set(session, { device: tv, controlURL: cur.controlURL, src: r.src, url: r.url });
    return { session, title: r.title };
  };

  let cache = { at: 0, list: [] };
  const renderers = async () => {
    if (Date.now() - cache.at < 60000 && cache.list.length) return cache.list;
    cache = { at: Date.now(), list: await findRenderers() };
    return cache.list;
  };
  const pick = (list, target) =>
    !target ? list[0] : list.find((r) => r.name.toLowerCase().includes(target.toLowerCase()));

  const json = (res, code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };

  const api = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${host}`);
    const q = Object.fromEntries(u.searchParams);
    // Loopback is trusted; off-machine requests must carry the shared token.
    if (!isLoopback(req.socket.remoteAddress || '')) {
      if (!token || req.headers['x-casto-token'] !== token) {
        return json(res, 401, { ok: false, error: 'unauthorized (remote control needs a valid X-Casto-Token)' });
      }
    }
    try {
      if (u.pathname === '/devices') {
        const list = await renderers();
        return json(res, 200, { ok: true, devices: list.map((d) => ({ name: d.name })) });
      }
      if (u.pathname === '/sessions') {
        return json(res, 200, { ok: true, sessions: [...sessions.entries()].map(([id, s]) =>
          ({ session: id, device: s.device, src: s.src })) });
      }
      if (u.pathname === '/library') {
        return json(res, 200, { ok: true, movies: library.map((m) => ({ id: m.id, title: m.title })) });
      }
      if (u.pathname === '/cast') {
        const dev = pick(await renderers(), q.target);
        if (!dev) return json(res, 404, { ok: false, error: 'no matching device' });
        const raw = q.src || q.id || q.name;
        if (!raw) return json(res, 400, { ok: false, error: 'missing src/id/name' });
        const r = resolveSource(raw);
        await castTo(dev.controlURL, r.url, r.title, r.contentType);
        const key = q.target || dev.name; // track under the name the caller used
        const session = crypto.randomBytes(4).toString('hex');
        sessions.set(session, { device: dev.name, controlURL: dev.controlURL, src: r.src, url: r.url });
        currentByDevice.set(key, { controlURL: dev.controlURL });
        lastState.set(key, 'PLAYING');
        if (!autoplayOn.has(key)) autoplayOn.set(key, autoplayDefault);
        return json(res, 200, { ok: true, session, device: dev.name, title: r.title, url: r.url });
      }
      if (u.pathname === '/queue') {
        const tv = q.tv;
        if (tv) return json(res, 200, { ok: true, tv, autoplay: !!autoplayOn.get(tv), queue: queueFor(tv) });
        return json(res, 200, { ok: true, queues: [...queues.entries()].map(([t, items]) =>
          ({ tv: t, autoplay: !!autoplayOn.get(t), count: items.length })) });
      }
      if (u.pathname === '/queue/add') {
        const tv = q.tv;
        if (!tv) return json(res, 400, { ok: false, error: 'missing tv' });
        const raw = q.src || q.id || q.name;
        if (!raw) return json(res, 400, { ok: false, error: 'missing src/id/name' });
        const lib = libById.get(raw) || libByName(raw);
        queueFor(tv).push({ src: raw, title: lib ? lib.title : raw });
        return json(res, 200, { ok: true, tv, queued: queueFor(tv).length });
      }
      if (u.pathname === '/queue/clear') {
        if (!q.tv) return json(res, 400, { ok: false, error: 'missing tv' });
        queues.set(q.tv, []);
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/queue/next') {
        if (!q.tv) return json(res, 400, { ok: false, error: 'missing tv' });
        // Auto-resolve the matching TV if we haven't cast to it yet.
        if (!currentByDevice.get(q.tv)) {
          const dev = pick(await renderers(), q.tv);
          if (!dev) return json(res, 404, { ok: false, error: 'no matching TV' });
          currentByDevice.set(q.tv, { controlURL: dev.controlURL });
        }
        const r = await playNext(q.tv);
        if (!r) return json(res, 404, { ok: false, error: 'nothing queued for that TV' });
        return json(res, 200, { ok: true, ...r });
      }
      if (u.pathname === '/autoplay') {
        if (!q.tv) return json(res, 400, { ok: false, error: 'missing tv' });
        autoplayOn.set(q.tv, q.on === 'true');
        return json(res, 200, { ok: true, tv: q.tv, autoplay: !!autoplayOn.get(q.tv) });
      }
      if (u.pathname === '/control') {
        const s = sessions.get(q.session);
        if (!s) return json(res, 404, { ok: false, error: 'unknown session' });
        const a = q.action;
        if (a === 'play') await transport.play(s.controlURL);
        else if (a === 'pause') await transport.pause(s.controlURL);
        else if (a === 'stop') { await transport.stop(s.controlURL); sessions.delete(q.session); }
        else if (a === 'forward') await seekRelative(s.controlURL, 30);
        else if (a === 'back') await seekRelative(s.controlURL, -30);
        else return json(res, 400, { ok: false, error: 'unknown action' });
        return json(res, 200, { ok: true });
      }
      json(res, 404, { ok: false, error: 'unknown endpoint' });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // Autoplay: when a TV with autoplay finishes a track, play the next queued.
  setInterval(async () => {
    for (const [tv, items] of queues) {
      if (!autoplayOn.get(tv) || items.length === 0) continue;
      const cur = currentByDevice.get(tv);
      if (!cur) continue;
      try {
        const st = await transportState(cur.controlURL);
        const prev = lastState.get(tv);
        lastState.set(tv, st);
        if ((st === 'STOPPED' || st === 'NO_MEDIA_PRESENT') && prev === 'PLAYING') {
          await playNext(tv);
        }
      } catch (_) {}
    }
  }, 5000);

  api.listen(apiPort, bind, () => {
    console.log(`▶ Casto cast daemon`);
    console.log(`  control API → http://${bind}:${apiPort}`);
    console.log(`  media host  → ${host}`);
    console.log(`  library     → ${library.length ? library.length + ' movies' : 'none (pass --library <folder>)'}`);
    console.log(`  autoplay    → ${autoplayDefault ? 'on by default' : 'off (per-TV via /autoplay)'}`);
    if (bind === '127.0.0.1') {
      console.log(`  reach       → local only (run --bind 0.0.0.0 to allow a remote master)`);
    } else {
      console.log(`  reach       → remote allowed; ${token ? 'token auth ON' : '⚠ NO TOKEN — remote calls will be rejected (run --gen-token)'}`);
    }
  });
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
