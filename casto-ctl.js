#!/usr/bin/env node
'use strict';

// casto-ctl — admin CLI for the Casto cast daemon (castd.js).
// Local (same machine) needs no token. To control a daemon on another machine,
// set CASTO_DAEMON to its URL and provide the shared token (CASTO_TOKEN env or
// ~/.casto/token).
//
//   casto-ctl devices
//   casto-ctl cast <file|url> [--tv "Living Room"]
//   casto-ctl pause | play | stop | forward | back [--session <id>]
//   casto-ctl sessions

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const BASE = process.env.CASTO_DAEMON || 'http://127.0.0.1:7700';
function loadToken() {
  if (process.env.CASTO_TOKEN) return process.env.CASTO_TOKEN;
  try { return fs.readFileSync(path.join(os.homedir(), '.casto', 'token'), 'utf8').trim() || null; }
  catch (_) { return null; }
}
const TOKEN = loadToken();

function api(method, pathQ) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + pathQ);
    const headers = TOKEN ? { 'X-Casto-Token': TOKEN } : {};
    const req = http.request(
      { method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { let body; try { body = JSON.parse(d); } catch (_) { body = d; } resolve({ status: res.statusCode, body }); });
      });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out — is castd running?')));
    req.end();
  });
}

function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; }

// A URL stays a URL; an existing path becomes an absolute src; anything else
// is treated as a library movie name for the daemon to resolve.
function srcParam(src) {
  if (/^https?:\/\//i.test(src)) return 'src=' + encodeURIComponent(src);
  const abs = path.resolve(src);
  if (fs.existsSync(abs)) return 'src=' + encodeURIComponent(abs);
  return 'name=' + encodeURIComponent(src);
}

function usage() {
  console.log(
    'casto-ctl — drive the Casto cast daemon\n\n' +
    '  casto-ctl list                            list library movies\n' +
    '  casto-ctl devices                         list TVs\n' +
    '  casto-ctl cast <movie|file|url> [--tv <name>]  play on a TV\n' +
    '  casto-ctl play|pause|stop|forward|back [--session <id>]\n' +
    '  casto-ctl queue [--tv <name>]             show the queue\n' +
    '  casto-ctl queue add <movie|file|url> --tv <name>\n' +
    '  casto-ctl queue clear --tv <name>\n' +
    '  casto-ctl next --tv <name>                play next queued\n' +
    '  casto-ctl autoplay on|off --tv <name>\n' +
    '  casto-ctl sessions                        list active streams\n\n' +
    `daemon: ${BASE}   ${TOKEN ? '(token loaded)' : '(no token — local only)'}`);
}

function report(r) {
  if (r.status === 401) {
    console.error('✗ unauthorized — set CASTO_TOKEN or copy ~/.casto/token from the daemon machine');
    process.exit(1);
  }
  if (r.body && r.body.ok === false) { console.error('✗ ' + (r.body.error || 'failed')); process.exit(1); }
  console.log(JSON.stringify(r.body, null, 2));
}

async function pickSession() {
  const r = await api('GET', '/sessions');
  const list = (r.body && r.body.sessions) || [];
  if (list.length === 0) throw new Error('no active sessions');
  if (list.length === 1) return list[0].session;
  console.error('Multiple sessions — pass --session <id>:');
  list.forEach((s) => console.error(`  ${s.session}  ${s.device}  ${s.src}`));
  process.exit(1);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '-h' || cmd === '--help') return usage();
  try {
    if (cmd === 'devices') return report(await api('GET', '/devices'));
    if (cmd === 'sessions') return report(await api('GET', '/sessions'));
    if (cmd === 'list') return report(await api('GET', '/library'));
    if (cmd === 'cast') {
      const src = process.argv[3];
      if (!src || src.startsWith('-')) throw new Error('usage: casto-ctl cast <movie|file|url> [--tv <name>]');
      const tv = arg('--tv');
      return report(await api('POST', `/cast?${srcParam(src)}` + (tv ? `&target=${encodeURIComponent(tv)}` : '')));
    }
    if (cmd === 'next') {
      const tv = arg('--tv'); if (!tv) throw new Error('usage: casto-ctl next --tv <name>');
      return report(await api('POST', `/queue/next?tv=${encodeURIComponent(tv)}`));
    }
    if (cmd === 'autoplay') {
      const on = process.argv[3], tv = arg('--tv');
      if (!['on', 'off'].includes(on) || !tv) throw new Error('usage: casto-ctl autoplay on|off --tv <name>');
      return report(await api('POST', `/autoplay?tv=${encodeURIComponent(tv)}&on=${on === 'on'}`));
    }
    if (cmd === 'queue') {
      const sub = process.argv[3];
      const tv = arg('--tv');
      if (sub === 'add') {
        const src = process.argv[4];
        if (!src || !tv) throw new Error('usage: casto-ctl queue add <movie|file|url> --tv <name>');
        return report(await api('POST', `/queue/add?tv=${encodeURIComponent(tv)}&${srcParam(src)}`));
      }
      if (sub === 'clear') {
        if (!tv) throw new Error('usage: casto-ctl queue clear --tv <name>');
        return report(await api('POST', `/queue/clear?tv=${encodeURIComponent(tv)}`));
      }
      return report(await api('GET', '/queue' + (tv ? `?tv=${encodeURIComponent(tv)}` : '')));
    }
    if (['play', 'pause', 'stop', 'forward', 'back'].includes(cmd)) {
      const session = arg('--session') || (await pickSession());
      return report(await api('POST', `/control?session=${encodeURIComponent(session)}&action=${cmd}`));
    }
    usage();
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}

main();
