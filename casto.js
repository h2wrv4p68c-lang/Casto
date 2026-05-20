#!/usr/bin/env node
'use strict';

// Casto — lightweight DLNA caster. Streams a local video file to a DLNA
// MediaRenderer (e.g. an LG WebOS TV) from your Mac. Zero dependencies.
//
//   node casto.js <video-file|folder> [options]
//
// Options:
//   --device <name>   only match renderers whose name contains <name>
//   --host <lan-ip>   force the LAN IP advertised to the TV
//   --sub <file>      use this subtitle file (overrides auto-detect)
//   --no-subs         disable subtitles even if a sidecar file exists
//   --browse <dir>    pick a video from <dir> interactively
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

const VIDEO_EXTS = Object.keys(CONTENT_TYPES);

// Subtitle sidecar formats. SRT is the most widely supported on LG WebOS.
const SUBTITLE_TYPES = {
  '.srt': 'text/srt',
  '.vtt': 'text/vtt',
  '.smi': 'smi/caption',
  '.ssa': 'text/x-ssa',
  '.ass': 'text/x-ssa',
  '.sub': 'text/plain',
};

const SUBTITLE_EXTS = Object.keys(SUBTITLE_TYPES);

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    file: null,
    device: null,
    host: null,
    sub: null,
    noSubs: false,
    browse: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device') out.device = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--sub') out.sub = argv[++i];
    else if (a === '--no-subs' || a === '--no-subtitles') out.noSubs = true;
    else if (a === '--browse') out.browse = argv[++i] || '.';
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

function didlMetadata(title, url, contentType, sub) {
  const protocolInfo = `http-get:*:${contentType}:${DLNA_FEATURES}`;

  // Subtitle resources. LG/Samsung sets pick up the <sec:CaptionInfo*>
  // elements; the extra <res> with the subtitle protocolInfo is the
  // generic DLNA hint. `sub` is { url, type } where type is e.g. "srt".
  let subRes = '';
  if (sub) {
    subRes =
      `<res protocolInfo="http-get:*:${sub.contentType}:*">` +
      `${xmlEscape(sub.url)}</res>` +
      `<sec:CaptionInfoEx sec:type="${sub.type}">${xmlEscape(sub.url)}</sec:CaptionInfoEx>` +
      `<sec:CaptionInfo sec:type="${sub.type}">${xmlEscape(sub.url)}</sec:CaptionInfo>`;
  }

  const inner =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:sec="http://www.sec.co.kr/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="${xmlEscape(protocolInfo)}">${xmlEscape(url)}</res>` +
    subRes +
    '</item></DIDL-Lite>';
  return inner;
}

async function cast(controlURL, url, title, contentType, sub) {
  const metadata = didlMetadata(title, url, contentType, sub);
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

// `resources` is a map of urlPath -> { file, contentType, captionUrl }.
// Each is served with Range support so the TV can seek.
function startServer(resources, host) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const r = resources[urlPath];
    if (!r) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const total = fs.statSync(r.file).size;
    const common = {
      'Content-Type': r.contentType,
      'Accept-Ranges': 'bytes',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': DLNA_FEATURES,
    };
    // Point the renderer at the sidecar subtitle when serving the video.
    if (r.captionUrl) common['CaptionInfo.sec'] = r.captionUrl;

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
      fs.createReadStream(r.file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...common, 'Content-Length': total });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(r.file).pipe(res);
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

// Look for a sidecar subtitle next to the video (same basename), preferring
// SRT. Returns an absolute path or null.
function findSidecarSubtitle(videoFile) {
  const dir = path.dirname(videoFile);
  const base = path.basename(videoFile, path.extname(videoFile));
  for (const ext of SUBTITLE_EXTS) {
    const candidate = path.join(dir, base + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// List video files in a directory and let the user pick one.
async function pickFromDir(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    die(`Not a folder: ${abs}`);
  }
  const vids = fs
    .readdirSync(abs)
    .filter((f) => VIDEO_EXTS.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  if (vids.length === 0) die(`No video files in ${abs}`);

  console.log(`\nVideos in ${abs}:`);
  vids.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  const pick = await ask('Choose video number: ');
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= vids.length) die('Invalid choice.');
  return path.join(abs, vids[idx]);
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

  if (args.help || (!args.file && !args.browse)) {
    console.log(
      'Casto — cast a local video to a DLNA TV\n\n' +
        '  node casto.js <video-file|folder> [options]\n\n' +
        'Options:\n' +
        '  --device <name>   match only renderers whose name contains <name>\n' +
        '  --host <lan-ip>   force the LAN IP advertised to the TV\n' +
        '  --sub <file>      use this subtitle file (overrides auto-detect)\n' +
        '  --no-subs         disable subtitles even if a sidecar exists\n' +
        '  --browse <dir>    pick a video from <dir> interactively\n\n' +
        'Controls while playing:  [space] play/pause   s stop   q quit'
    );
    process.exit(args.help ? 0 : 1);
  }

  // Resolve which video to cast: explicit folder/--browse → interactive pick,
  // a directory path → pick, otherwise a plain file.
  let file;
  if (args.browse) {
    file = await pickFromDir(args.browse);
  } else {
    file = path.resolve(args.file);
    if (!fs.existsSync(file)) die(`Not found: ${file}`);
    if (fs.statSync(file).isDirectory()) file = await pickFromDir(file);
    else if (!fs.statSync(file).isFile()) die(`Not a file: ${file}`);
  }

  const ext = path.extname(file).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'video/mp4';
  const title = path.basename(file, ext);

  // Subtitle resolution: explicit --sub wins, then sidecar auto-detect,
  // unless --no-subs turns the whole thing off.
  let subFile = null;
  if (!args.noSubs) {
    if (args.sub) {
      subFile = path.resolve(args.sub);
      if (!fs.existsSync(subFile)) die(`Subtitle not found: ${subFile}`);
    } else {
      subFile = findSidecarSubtitle(file);
    }
  }

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

  // Build the served resources and their URLs.
  const videoPath = '/' + encodeURIComponent(path.basename(file));
  const resources = { [decodeURIComponent(videoPath)]: { file, contentType } };

  let sub = null;
  if (subFile) {
    const subExt = path.extname(subFile).toLowerCase();
    const subContentType = SUBTITLE_TYPES[subExt] || 'text/plain';
    const subPath = '/' + encodeURIComponent(path.basename(subFile));
    resources[decodeURIComponent(subPath)] = {
      file: subFile,
      contentType: subContentType,
    };
    sub = {
      path: subPath,
      contentType: subContentType,
      type: subExt.replace('.', ''),
    };
  }

  const { server, port } = await startServer(resources, host);
  const base = `http://${host}:${port}`;
  const url = base + videoPath;
  if (sub) {
    sub.url = base + sub.path;
    resources[decodeURIComponent(videoPath)].captionUrl = sub.url;
  }

  console.log(`▶ Casting "${title}" → ${target.name}`);
  console.log(`  serving ${url}`);
  console.log(`  subtitles: ${sub ? path.basename(subFile) : 'off'}`);

  try {
    await cast(target.controlURL, url, title, contentType, sub);
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
