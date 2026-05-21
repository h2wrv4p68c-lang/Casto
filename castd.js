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

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; };
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('Casto cast daemon\n  node castd.js [--port <n>] [--host <lan-ip>]');
    return;
  }
  const host = get('--host', localIPv4());
  if (!host) { console.error('✗ Could not determine LAN IP; pass --host.'); process.exit(1); }
  const apiPort = parseInt(get('--port', '7700'), 10);

  const media = await createMediaServer(host);
  const sessions = new Map(); // sessionId -> { device, controlURL, src, url }
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
    try {
      if (u.pathname === '/devices') {
        const list = await renderers();
        return json(res, 200, { ok: true, devices: list.map((d) => ({ name: d.name })) });
      }
      if (u.pathname === '/sessions') {
        return json(res, 200, { ok: true, sessions: [...sessions.entries()].map(([id, s]) =>
          ({ session: id, device: s.device, src: s.src })) });
      }
      if (u.pathname === '/cast') {
        const dev = pick(await renderers(), q.target);
        if (!dev) return json(res, 404, { ok: false, error: 'no matching device' });
        if (!q.src) return json(res, 400, { ok: false, error: 'missing src' });
        let url, contentType, title;
        if (isRemote(q.src)) {
          url = q.src;
          contentType = CONTENT_TYPES[path.extname(new URL(q.src).pathname).toLowerCase()] || 'video/mp4';
          title = path.basename(new URL(q.src).pathname) || 'Stream';
        } else {
          const p = path.resolve(q.src);
          if (!fs.existsSync(p)) return json(res, 404, { ok: false, error: 'file not found' });
          const reg = media.register(p);
          url = reg.url; contentType = reg.contentType; title = path.basename(p);
        }
        await castTo(dev.controlURL, url, title, contentType);
        const session = crypto.randomBytes(4).toString('hex');
        sessions.set(session, { device: dev.name, controlURL: dev.controlURL, src: q.src, url });
        return json(res, 200, { ok: true, session, device: dev.name, url });
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

  api.listen(apiPort, '127.0.0.1', () => {
    console.log(`▶ Casto cast daemon`);
    console.log(`  control API → http://127.0.0.1:${apiPort}`);
    console.log(`  media host  → ${host}`);
    console.log(`  multiple TVs = multiple concurrent /cast sessions (not frame-synced)`);
  });
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
