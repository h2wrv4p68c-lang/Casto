#!/usr/bin/env node
'use strict';

// Casto — lightweight DLNA caster. Streams a local video file to a DLNA
// MediaRenderer (e.g. an LG WebOS TV) from your Mac. Zero dependencies.
//
//   node casto.js <video-file> [--device <name-substring>] [--host <lan-ip>]
//
// Controls once playing:  [space] play/pause   s stop   q quit

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const dgram = require('dgram');
const readline = require('readline');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const DLNA_FEATURES =
  'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
};

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { file: null, device: null, host: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device') out.device = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!a.startsWith('-') && !out.file) out.file = a;
  }
  return out;
}

function localIPv4() {
  const ifaces = os.networkInterfaces();
  // Prefer common Wi-Fi/Ethernet interfaces, then any non-internal IPv4.
  const order = ['en0', 'en1', 'eth0', 'wlan0'];
  for (const name of order) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// --- Discovery -------------------------------------------------------------

function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map(); // location -> true
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const msearch = (target) =>
      Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          `ST: ${target}\r\n\r\n`
      );

    sock.on('message', (msg) => {
      const text = msg.toString();
      if (!/AVTransport|MediaRenderer/i.test(text)) return;
      const m = /^LOCATION:\s*(.+)$/im.exec(text);
      if (m) found.set(m[1].trim(), true);
    });

    sock.on('error', () => {});

    sock.bind(() => {
      try {
        sock.setBroadcast(true);
      } catch (_) {}
      const targets = [
        'urn:schemas-upnp-org:device:MediaRenderer:1',
        AVT,
      ];
      const blast = () => {
        for (const t of targets) {
          const pkt = msearch(t);
          sock.send(pkt, 0, pkt.length, SSDP_PORT, SSDP_ADDR);
        }
      };
      blast();
      setTimeout(blast, 800); // resend; UDP discovery is lossy
    });

    setTimeout(() => {
      try {
        sock.close();
      } catch (_) {}
      resolve([...found.keys()]);
    }, timeoutMs);
  });
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

// Parse a device description, returning { name, controlURL } if it exposes
// an AVTransport service, else null.
function parseDevice(xml, location) {
  if (!new RegExp('urn:schemas-upnp-org:service:AVTransport').test(xml)) {
    return null;
  }
  const nameMatch = /<friendlyName>([^<]*)<\/friendlyName>/i.exec(xml);
  const name = nameMatch ? nameMatch[1].trim() : 'Unknown device';

  const baseMatch = /<URLBase>([^<]*)<\/URLBase>/i.exec(xml);
  const base = baseMatch ? baseMatch[1].trim() : location;

  // Find the <service> block for AVTransport and pull its <controlURL>.
  const services = xml.split(/<service>/i);
  for (const svc of services) {
    if (/AVTransport/i.test(svc)) {
      const cu = /<controlURL>([^<]*)<\/controlURL>/i.exec(svc);
      if (cu) {
        const controlURL = new URL(cu[1].trim(), base).href;
        return { name, controlURL };
      }
    }
  }
  return null;
}

async function findRenderers() {
  const locations = await discover();
  const renderers = [];
  for (const loc of locations) {
    try {
      const xml = await httpGet(loc);
      const dev = parseDevice(xml, loc);
      if (dev) renderers.push(dev);
    } catch (_) {
      /* unreachable description; skip */
    }
  }
  // De-dupe by controlURL.
  const seen = new Set();
  return renderers.filter((r) =>
    seen.has(r.controlURL) ? false : seen.add(r.controlURL)
  );
}

// --- SOAP control ----------------------------------------------------------

function soap(controlURL, action, bodyInner) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${AVT}">` +
    bodyInner +
    `</u:${action}></s:Body></s:Envelope>`;

  const u = new URL(controlURL);
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || 80,
    path: u.pathname + u.search,
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(body),
      SOAPAction: `"${AVT}#${action}"`,
      Connection: 'close',
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${action} failed (HTTP ${res.statusCode}): ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('SOAP timeout')));
    req.write(body);
    req.end();
  });
}

function didlMetadata(title, url, contentType) {
  const protocolInfo = `http-get:*:${contentType}:${DLNA_FEATURES}`;
  const inner =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="${xmlEscape(protocolInfo)}">${xmlEscape(url)}</res>` +
    '</item></DIDL-Lite>';
  return inner;
}

async function cast(controlURL, url, title, contentType) {
  const metadata = didlMetadata(title, url, contentType);
  await soap(
    controlURL,
    'SetAVTransportURI',
    '<InstanceID>0</InstanceID>' +
      `<CurrentURI>${xmlEscape(url)}</CurrentURI>` +
      `<CurrentURIMetaData>${xmlEscape(metadata)}</CurrentURIMetaData>`
  );
  await soap(
    controlURL,
    'Play',
    '<InstanceID>0</InstanceID><Speed>1</Speed>'
  );
}

const transport = {
  play: (c) => soap(c, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>'),
  pause: (c) => soap(c, 'Pause', '<InstanceID>0</InstanceID>'),
  stop: (c) => soap(c, 'Stop', '<InstanceID>0</InstanceID>'),
};

// --- Local media server ----------------------------------------------------

function startServer(file, contentType, host) {
  const stat = fs.statSync(file);
  const total = stat.size;

  const server = http.createServer((req, res) => {
    const common = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': DLNA_FEATURES,
    };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      if (isNaN(end) || end >= total) end = total - 1;
      res.writeHead(206, {
        ...common,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...common, 'Content-Length': total });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    })
  );
}

// --- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.file) {
    console.log(
      'Casto — cast a local video to a DLNA TV\n\n' +
        '  node casto.js <video-file> [--device <name>] [--host <lan-ip>]\n\n' +
        'Controls while playing:  [space] play/pause   s stop   q quit'
    );
    process.exit(args.help ? 0 : 1);
  }

  const file = path.resolve(args.file);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    die(`File not found: ${file}`);
  }

  const ext = path.extname(file).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'video/mp4';
  const title = path.basename(file, ext);

  const host = args.host || localIPv4();
  if (!host) die('Could not determine your LAN IP. Pass one with --host.');

  console.log('⊙ Searching for DLNA devices…');
  let renderers = await findRenderers();
  if (args.device) {
    renderers = renderers.filter((r) =>
      r.name.toLowerCase().includes(args.device.toLowerCase())
    );
  }

  if (renderers.length === 0) {
    die(
      'No DLNA renderers found. Make sure the TV is on, on the same Wi-Fi, ' +
        'and that "DLNA / media sharing" is enabled in its network settings.'
    );
  }

  let target = renderers[0];
  if (renderers.length > 1) {
    console.log('\nFound multiple devices:');
    renderers.forEach((r, i) => console.log(`  [${i + 1}] ${r.name}`));
    const pick = await ask('Choose device number: ');
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= renderers.length) die('Invalid choice.');
    target = renderers[idx];
  }

  const { server, port } = await startServer(file, contentType, host);
  const url = `http://${host}:${port}/${encodeURIComponent(path.basename(file))}`;

  console.log(`▶ Casting "${title}" → ${target.name}`);
  console.log(`  serving ${url}`);

  try {
    await cast(target.controlURL, url, title, contentType);
  } catch (e) {
    server.close();
    die('Failed to start playback: ' + e.message);
  }

  console.log('\n  [space] play/pause   s stop   q quit\n');

  let paused = false;
  const shutdown = async (stopTv) => {
    try {
      if (stopTv) await transport.stop(target.controlURL);
    } catch (_) {}
    server.close();
    process.exit(0);
  };

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', async (str, key) => {
      try {
        if (key.name === 'space') {
          if (paused) {
            await transport.play(target.controlURL);
            console.log('  ▶ resumed');
          } else {
            await transport.pause(target.controlURL);
            console.log('  ❚❚ paused');
          }
          paused = !paused;
        } else if (str === 's') {
          await transport.stop(target.controlURL);
          console.log('  ■ stopped');
        } else if (str === 'q' || (key.ctrl && key.name === 'c')) {
          console.log('  bye');
          await shutdown(true);
        }
      } catch (e) {
        console.error('  ✗ ' + e.message);
      }
    });
  }

  process.on('SIGINT', () => shutdown(true));
}

main().catch((e) => die(e.message));
