#!/usr/bin/env node
'use strict';

// Casto MediaServer — a lightweight DLNA MediaServer (DMS). Point it at a
// folder and your TV's built-in media player can browse the library, with
// poster art, and play files directly. Zero dependencies.
//
//   node server.js <media-folder> [--name <shown-name>] [--host <lan-ip>] [--port <n>]
//
// Stop with Ctrl-C (sends an ssdp:byebye so the TV drops us cleanly).

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const dgram = require('dgram');

function preventSleep() {
  if (process.platform !== "darwin") return;
  try {
    require("child_process").spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
  } catch (_) {}
}
const crypto = require('crypto');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
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

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const IMAGE_EXTS = Object.keys(IMAGE_TYPES);
const POSTER_NAMES = ['poster', 'folder', 'cover', 'thumb'];

const SOURCE_PROTOCOLS = [
  ...new Set(Object.values(CONTENT_TYPES)),
  'image/jpeg',
  'image/png',
  'text/srt',
]
  .map((ct) => `http-get:*:${ct}:*`)
  .join(',');

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function localIPv4() {
  const ifaces = os.networkInterfaces();
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

function parseArgs(argv) {
  const out = { dir: null, name: 'Casto', host: null, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10) || 0;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!a.startsWith('-') && !out.dir) out.dir = a;
  }
  return out;
}

// A stable UUID derived from the served path, so repeated runs don't leave
// stale duplicate servers lingering in the TV's device list.
function stableUuid(seed) {
  const h = crypto.createHash('md5').update(seed).digest('hex');
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-` +
    `${h.slice(16, 20)}-${h.slice(20, 32)}`
  );
}

// --- Content tree ----------------------------------------------------------

// Build an in-memory object tree the ContentDirectory will expose. Each node
// is { id, parentId, container, title, file?, contentType?, size?, art?,
// children? }. Root is id "0".
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
    for (const name of POSTER_NAMES) {
      for (const ext of IMAGE_EXTS) {
        const p = path.join(dir, name + ext);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }

  function scan(dirPath, parentId, title) {
    const id = parentId === '-1' ? '0' : String(nextId++);
    const node = {
      id,
      parentId,
      container: true,
      title,
      art: posterFor(dirPath, true),
      children: [],
    };
    objects.set(id, node);

    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
      return node;
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries
      .filter(
        (e) =>
          e.isFile() && VIDEO_EXTS.includes(path.extname(e.name).toLowerCase())
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      const child = scan(path.join(dirPath, d.name), id, d.name);
      if (child.children.length > 0) node.children.push(child.id);
      else objects.delete(child.id); // prune empty folders
    }
    for (const f of files) {
      const filePath = path.join(dirPath, f.name);
      const ext = path.extname(f.name).toLowerCase();
      const cid = String(nextId++);
      objects.set(cid, {
        id: cid,
        parentId: id,
        container: false,
        title: path.basename(f.name, ext),
        file: filePath,
        contentType: CONTENT_TYPES[ext] || 'video/mp4',
        size: fs.statSync(filePath).size,
        art: posterFor(filePath, false),
      });
      node.children.push(cid);
    }
    return node;
  }

  scan(root, '-1', path.basename(root) || 'Casto');
  return objects;
}

// --- DIDL-Lite -------------------------------------------------------------

function didlOpen() {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">'
  );
}

function didlForObject(node, objects, base) {
  if (node.container) {
    const childCount = node.children ? node.children.length : 0;
    let s =
      `<container id="${node.id}" parentID="${node.parentId}" ` +
      `restricted="1" childCount="${childCount}">` +
      `<dc:title>${xmlEscape(node.title)}</dc:title>` +
      '<upnp:class>object.container.storageFolder</upnp:class>';
    if (node.art) s += `<upnp:albumArtURI>${base}/art/${node.id}</upnp:albumArtURI>`;
    return s + '</container>';
  }
  const protocolInfo = `http-get:*:${node.contentType}:${DLNA_FEATURES}`;
  let s =
    `<item id="${node.id}" parentID="${node.parentId}" restricted="1">` +
    `<dc:title>${xmlEscape(node.title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>';
  if (node.art) s += `<upnp:albumArtURI>${base}/art/${node.id}</upnp:albumArtURI>`;
  s +=
    `<res protocolInfo="${xmlEscape(protocolInfo)}" size="${node.size}">` +
    `${base}/media/${node.id}</res>`;
  return s + '</item>';
}

// --- SOAP / XML helpers ----------------------------------------------------

function getTag(xml, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</`, 'i').exec(xml);
  return m ? m[1] : '';
}

function soapResponse(res, service, action, fields) {
  let inner = '';
  for (const [k, v] of Object.entries(fields)) inner += `<${k}>${v}</${k}>`;
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action}Response xmlns:u="${service}">` +
    inner +
    `</u:${action}Response></s:Body></s:Envelope>`;
  res.writeHead(200, {
    'Content-Type': 'text/xml; charset="utf-8"',
    EXT: '',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function soapFault(res) {
  const body =
    '<?xml version="1.0"?><s:Envelope ' +
    'xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
    '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>' +
    '</s:Fault></s:Body></s:Envelope>';
  res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
  res.end(body);
}

// --- HTTP server -----------------------------------------------------------

const CD_SERVICE = 'urn:schemas-upnp-org:service:ContentDirectory:1';
const CM_SERVICE = 'urn:schemas-upnp-org:service:ConnectionManager:1';

function descriptionXml(uuid, name, base) {
  return (
    '<?xml version="1.0"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0" ' +
    'xmlns:dlna="urn:schemas-dlna-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    '<device>' +
    '<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>' +
    `<friendlyName>${xmlEscape(name)}</friendlyName>` +
    '<manufacturer>Casto</manufacturer>' +
    '<modelName>Casto MediaServer</modelName>' +
    '<modelNumber>0.1</modelNumber>' +
    '<dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>' +
    `<UDN>uuid:${uuid}</UDN>` +
    '<serviceList>' +
    '<service>' +
    `<serviceType>${CD_SERVICE}</serviceType>` +
    '<serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>' +
    '<SCPDURL>/cd_scpd.xml</SCPDURL>' +
    '<controlURL>/cd/control</controlURL>' +
    '<eventSubURL>/cd/event</eventSubURL>' +
    '</service>' +
    '<service>' +
    `<serviceType>${CM_SERVICE}</serviceType>` +
    '<serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>' +
    '<SCPDURL>/cm_scpd.xml</SCPDURL>' +
    '<controlURL>/cm/control</controlURL>' +
    '<eventSubURL>/cm/event</eventSubURL>' +
    '</service>' +
    '</serviceList>' +
    '</device></root>'
  );
}

function action(name, args, ret) {
  const a = (list, dir) =>
    (list || [])
      .map(
        (n) =>
          `<argument><name>${n[0]}</name><direction>${dir}</direction>` +
          `<relatedStateVariable>${n[1]}</relatedStateVariable></argument>`
      )
      .join('');
  return (
    `<action><name>${name}</name><argumentList>` +
    a(args, 'in') +
    a(ret, 'out') +
    '</argumentList></action>'
  );
}

function stateVar(name, type, sendEvents = 'no') {
  return (
    `<stateVariable sendEvents="${sendEvents}">` +
    `<name>${name}</name><dataType>${type}</dataType></stateVariable>`
  );
}

function cdScpd() {
  return (
    '<?xml version="1.0"?>' +
    '<scpd xmlns="urn:schemas-upnp-org:service-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    '<actionList>' +
    action(
      'Browse',
      [
        ['ObjectID', 'A_ARG_TYPE_ObjectID'],
        ['BrowseFlag', 'A_ARG_TYPE_BrowseFlag'],
        ['Filter', 'A_ARG_TYPE_Filter'],
        ['StartingIndex', 'A_ARG_TYPE_Index'],
        ['RequestedCount', 'A_ARG_TYPE_Count'],
        ['SortCriteria', 'A_ARG_TYPE_SortCriteria'],
      ],
      [
        ['Result', 'A_ARG_TYPE_Result'],
        ['NumberReturned', 'A_ARG_TYPE_Count'],
        ['TotalMatches', 'A_ARG_TYPE_Count'],
        ['UpdateID', 'A_ARG_TYPE_UpdateID'],
      ]
    ) +
    action('GetSearchCapabilities', [], [['SearchCaps', 'SearchCapabilities']]) +
    action('GetSortCapabilities', [], [['SortCaps', 'SortCapabilities']]) +
    action('GetSystemUpdateID', [], [['Id', 'SystemUpdateID']]) +
    '</actionList><serviceStateTable>' +
    stateVar('A_ARG_TYPE_ObjectID', 'string') +
    stateVar('A_ARG_TYPE_Result', 'string') +
    stateVar('A_ARG_TYPE_BrowseFlag', 'string') +
    stateVar('A_ARG_TYPE_Filter', 'string') +
    stateVar('A_ARG_TYPE_SortCriteria', 'string') +
    stateVar('A_ARG_TYPE_Index', 'ui4') +
    stateVar('A_ARG_TYPE_Count', 'ui4') +
    stateVar('A_ARG_TYPE_UpdateID', 'ui4') +
    stateVar('SearchCapabilities', 'string') +
    stateVar('SortCapabilities', 'string') +
    stateVar('SystemUpdateID', 'ui4', 'yes') +
    '</serviceStateTable></scpd>'
  );
}

function cmScpd() {
  return (
    '<?xml version="1.0"?>' +
    '<scpd xmlns="urn:schemas-upnp-org:service-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    '<actionList>' +
    action(
      'GetProtocolInfo',
      [],
      [
        ['Source', 'SourceProtocolInfo'],
        ['Sink', 'SinkProtocolInfo'],
      ]
    ) +
    action(
      'GetCurrentConnectionIDs',
      [],
      [['ConnectionIDs', 'CurrentConnectionIDs']]
    ) +
    '</actionList><serviceStateTable>' +
    stateVar('SourceProtocolInfo', 'string', 'yes') +
    stateVar('SinkProtocolInfo', 'string', 'yes') +
    stateVar('CurrentConnectionIDs', 'string', 'yes') +
    '</serviceStateTable></scpd>'
  );
}

function serveFile(req, res, filePath, contentType) {
  let total;
  try {
    total = fs.statSync(filePath).size;
  } catch (_) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const headers = {
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
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': total });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }
}

function handleBrowse(req, res, body, objects, base) {
  const objectId = getTag(body, 'ObjectID') || '0';
  const flag = getTag(body, 'BrowseFlag') || 'BrowseDirectChildren';
  const start = parseInt(getTag(body, 'StartingIndex'), 10) || 0;
  const reqCount = parseInt(getTag(body, 'RequestedCount'), 10) || 0;

  const node = objects.get(objectId);
  if (!node) return soapFault(res);

  let didl = didlOpen();
  let numberReturned = 0;
  let totalMatches = 0;

  if (flag === 'BrowseMetadata') {
    didl += didlForObject(node, objects, base);
    numberReturned = 1;
    totalMatches = 1;
  } else {
    const childIds = node.children || [];
    totalMatches = childIds.length;
    const slice =
      reqCount > 0 ? childIds.slice(start, start + reqCount) : childIds.slice(start);
    for (const cid of slice) {
      const child = objects.get(cid);
      if (child) {
        didl += didlForObject(child, objects, base);
        numberReturned++;
      }
    }
  }
  didl += '</DIDL-Lite>';

  soapResponse(res, CD_SERVICE, 'Browse', {
    Result: xmlEscape(didl),
    NumberReturned: numberReturned,
    TotalMatches: totalMatches,
    UpdateID: 1,
  });
}

function startHttp(objects, uuid, name, host, port) {
  const server = http.createServer((req, res) => {
    const base = `http://${host}:${server.address().port}`;
    const url = req.url.split('?')[0];

    // UPnP eventing: acknowledge SUBSCRIBE/UNSUBSCRIBE so TVs proceed.
    if (req.method === 'SUBSCRIBE') {
      res.writeHead(200, {
        SID: `uuid:${crypto.randomUUID()}`,
        TIMEOUT: 'Second-1800',
      });
      return res.end();
    }
    if (req.method === 'UNSUBSCRIBE') {
      res.writeHead(200);
      return res.end();
    }

    if (url === '/description.xml') {
      const xml = descriptionXml(uuid, name, base);
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
      return res.end(xml);
    }
    if (url === '/cd_scpd.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
      return res.end(cdScpd());
    }
    if (url === '/cm_scpd.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
      return res.end(cmScpd());
    }

    if (url === '/cd/control' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (/GetSortCapabilities/.test(body)) {
          return soapResponse(res, CD_SERVICE, 'GetSortCapabilities', {
            SortCaps: 'dc:title',
          });
        }
        if (/GetSearchCapabilities/.test(body)) {
          return soapResponse(res, CD_SERVICE, 'GetSearchCapabilities', {
            SearchCaps: '',
          });
        }
        if (/GetSystemUpdateID/.test(body)) {
          return soapResponse(res, CD_SERVICE, 'GetSystemUpdateID', { Id: 1 });
        }
        if (/Browse/.test(body)) {
          return handleBrowse(req, res, body, objects, base);
        }
        soapFault(res);
      });
      return;
    }

    if (url === '/cm/control' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (/GetProtocolInfo/.test(body)) {
          return soapResponse(res, CM_SERVICE, 'GetProtocolInfo', {
            Source: xmlEscape(SOURCE_PROTOCOLS),
            Sink: '',
          });
        }
        if (/GetCurrentConnectionIDs/.test(body)) {
          return soapResponse(res, CM_SERVICE, 'GetCurrentConnectionIDs', {
            ConnectionIDs: '0',
          });
        }
        soapFault(res);
      });
      return;
    }

    if (url.startsWith('/media/')) {
      const node = objects.get(url.slice('/media/'.length));
      if (!node || node.container) {
        res.writeHead(404);
        return res.end('Not found');
      }
      return serveFile(req, res, node.file, node.contentType);
    }

    if (url.startsWith('/art/')) {
      const node = objects.get(url.slice('/art/'.length));
      if (!node || !node.art) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(node.art).toLowerCase();
      return serveFile(req, res, node.art, IMAGE_TYPES[ext] || 'image/jpeg');
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// --- SSDP advertising ------------------------------------------------------

function startSsdp(uuid, locationUrl, host) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const usnList = [
    ['upnp:rootdevice', `uuid:${uuid}::upnp:rootdevice`],
    [`uuid:${uuid}`, `uuid:${uuid}`],
    [
      'urn:schemas-upnp-org:device:MediaServer:1',
      `uuid:${uuid}::urn:schemas-upnp-org:device:MediaServer:1`,
    ],
    [
      'urn:schemas-upnp-org:service:ContentDirectory:1',
      `uuid:${uuid}::urn:schemas-upnp-org:service:ContentDirectory:1`,
    ],
    [
      'urn:schemas-upnp-org:service:ConnectionManager:1',
      `uuid:${uuid}::urn:schemas-upnp-org:service:ConnectionManager:1`,
    ],
  ];
  const server = `${os.type()}/${os.release()} UPnP/1.0 Casto/0.1`;

  function notify(nts) {
    for (const [nt, usn] of usnList) {
      const msg = Buffer.from(
        'NOTIFY * HTTP/1.1\r\n' +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          'CACHE-CONTROL: max-age=1800\r\n' +
          `LOCATION: ${locationUrl}\r\n` +
          `NT: ${nt}\r\n` +
          `NTS: ${nts}\r\n` +
          `SERVER: ${server}\r\n` +
          `USN: ${usn}\r\n\r\n`
      );
      sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR);
    }
  }

  sock.on('message', (msg, rinfo) => {
    const text = msg.toString();
    if (!text.startsWith('M-SEARCH')) return;
    const st = (/^ST:\s*(.+)$/im.exec(text) || [])[1];
    if (!st) return;
    const target = st.trim();
    const matches =
      target === 'ssdp:all'
        ? usnList
        : usnList.filter(([nt]) => nt === target);
    for (const [nt, usn] of matches) {
      const reply = Buffer.from(
        'HTTP/1.1 200 OK\r\n' +
          'CACHE-CONTROL: max-age=1800\r\n' +
          `DATE: ${new Date().toUTCString()}\r\n` +
          'EXT:\r\n' +
          `LOCATION: ${locationUrl}\r\n` +
          `SERVER: ${server}\r\n` +
          `ST: ${nt}\r\n` +
          `USN: ${usn}\r\n\r\n`
      );
      // Respond twice; SSDP unicast replies are easily lost.
      sock.send(reply, 0, reply.length, rinfo.port, rinfo.address);
      setTimeout(
        () => sock.send(reply, 0, reply.length, rinfo.port, rinfo.address),
        100
      );
    }
  });

  return new Promise((resolve) => {
    sock.bind(SSDP_PORT, () => {
      try {
        sock.addMembership(SSDP_ADDR, host);
      } catch (_) {}
      notify('ssdp:alive');
      setTimeout(() => notify('ssdp:alive'), 500);
      const timer = setInterval(() => notify('ssdp:alive'), 300000);
      resolve({ sock, bye: () => notify('ssdp:byebye'), timer });
    });
  });
}

// --- Main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dir) {
    console.log(
      'Casto MediaServer — browse a folder from your TV over DLNA\n\n' +
        '  node server.js <media-folder> [options]\n\n' +
        'Options:\n' +
        '  --name <shown-name>   name shown on the TV (default: Casto)\n' +
        '  --host <lan-ip>       force the LAN IP advertised to the TV\n' +
        '  --port <n>            fixed HTTP port (default: random free port)\n'
    );
    process.exit(args.help ? 0 : 1);
  }
  preventSleep();

  const root = path.resolve(args.dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    die(`Not a folder: ${root}`);
  }

  const host = args.host || localIPv4();
  if (!host) die('Could not determine your LAN IP. Pass one with --host.');

  console.log('⊙ Indexing media…');
  const objects = buildTree(root);
  objects.get('0').title = args.name;
  const items = [...objects.values()].filter((n) => !n.container).length;
  const folders = [...objects.values()].filter((n) => n.container).length;
  if (items === 0) die(`No playable video files found under ${root}`);

  const uuid = stableUuid(root + '|' + args.name);
  const server = await startHttp(objects, uuid, args.name, host, args.port);
  const httpPort = server.address().port;
  const location = `http://${host}:${httpPort}/description.xml`;

  const ssdp = await startSsdp(uuid, location, host);

  console.log(`▶ "${args.name}" is live as a DLNA MediaServer`);
  console.log(`  ${items} videos in ${folders} folders`);
  console.log(`  ${location}`);
  console.log(
    '\n  On the TV: open the media/photo player or Home Dashboard and pick ' +
      `"${args.name}".\n  Ctrl-C to stop.\n`
  );

  const shutdown = () => {
    try {
      ssdp.bye();
      clearInterval(ssdp.timer);
      ssdp.sock.close();
    } catch (_) {}
    server.close();
    // Give the byebye a moment to leave the wire.
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => die(e.message));
