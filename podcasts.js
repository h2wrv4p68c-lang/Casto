#!/usr/bin/env node
'use strict';

// Casto Podcasts — a lightweight, standalone podcast app. Subscribe to shows by
// RSS feed (or find them by searching the public directory), then listen in the
// browser with resume-where-you-left-off, variable speed, and offline download.
//
//   node podcasts.js [--port <n>] [--host <lan-ip>]
//
// This is a thin shell over podcast-core.js (which is also embedded as the
// "Podcasts" content-type in the unified library hub). No account, no database,
// no tracking — subscriptions, progress, and downloads live in ~/.casto.

const os = require('os');
const http = require('http');
const { URL } = require('url');
const core = require('./podcast-core');

function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'eth0', 'wlan0', ...Object.keys(ifaces)]) {
    for (const a of ifaces[name] || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

// The standalone page: a header + a single container that the CastoPod widget
// (from podcast-core) mounts into, plus the shared player dock. API at /api.
function pageHTML() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Casto Podcasts</title>
<style>
  :root{ --wood:#e9d6b0; --ink:#5b3a22; --sub:#6d5236; --accent:#2f4156; --card:#fbf1dd; --line:#c9ac74; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--wood);color:var(--ink);font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding-bottom:96px}
  header{display:flex;align-items:center;gap:14px;padding:16px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--wood);z-index:6}
  header h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:32px;margin:0}
  header .tag{font-size:12px;color:var(--sub);letter-spacing:.12em;text-transform:uppercase}
  main{padding:22px 24px;max-width:1100px;margin:0 auto}
  a{color:var(--accent)}
${core.podcastCSS()}
</style></head><body>
<header><h1>Casto Podcasts</h1><span class="tag">Listen</span></header>
<main id="pod"></main>
${core.podcastDockHTML()}
<script>${core.podcastClientJS()}</script>
<script>CastoPod.mount(document.getElementById('pod'), { apiPrefix: '/api' });</script>
</body></html>`;
}

function start({ port, host }) {
  core.ensureDirs();
  const json = (res, code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${host}:${port}`);
    try {
      if (u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageHTML());
      }
      if (await core.handlePodcastRoutes(req, res, u, json, '/api')) return;
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
    console.log(`  Data:    ${core.STORE}`);
  });
}

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
