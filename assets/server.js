#!/usr/bin/env node
// Design Explorer — zero external dependencies
// Serves full-screen carousel harness with SSE live updates, sessions, optional Soniox voice
// Usage: node server.js --dir ./mockups --port 8000

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ── CLI args ─────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const DIR = path.resolve(getArg('dir', '.'));
const PORT = parseInt(getArg('port', '8000'), 10);
const NO_OPEN = args.includes('--no-open');
const HARNESS = getArg('harness', path.join(__dirname, 'harness-template.html'));

// ── Load Soniox key (optional) ──────────────────
// Checks: env vars → skill .env → .env files up from mockup dir
function loadSonioxKey() {
  if (process.env.SONIOX_KEY) return process.env.SONIOX_KEY;
  if (process.env.SONIX_KEY) return process.env.SONIX_KEY;
  function readKeyFromEnv(p) {
    try {
      const match = fs.readFileSync(p, 'utf8').match(/(?:SONIOX_KEY|SONIX_KEY)=(.+)/);
      if (match) return match[1].trim();
    } catch {}
    return null;
  }
  // Check skill directory .env (configured once, works everywhere)
  const skillEnv = readKeyFromEnv(path.join(__dirname, '..', '.env'));
  if (skillEnv) return skillEnv;
  // Walk up from mockup dir
  let dir = DIR;
  for (let i = 0; i < 4; i++) {
    const key = readKeyFromEnv(path.join(dir, '.env'));
    if (key) return key;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const SONIOX_KEY = loadSonioxKey();

// ── State ────────────────────────────────────────
const knownFiles = new Map(); // filename → {mtime, html, session}
const clients = [];
let sessions = [];
let nextSession = 1;

const sessionsPath = path.join(DIR, 'sessions.json');
try {
  sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  nextSession = sessions.length > 0 ? Math.max(...sessions.map(s => s.id)) + 1 : 1;
} catch {}

function saveSessions() {
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

function sessionForMockup(mockupId) {
  for (const s of sessions) {
    if (s.mockups.includes(mockupId)) return s.id;
  }
  return sessions.length > 0 ? sessions[sessions.length - 1].id + 1 : 0;
}

// ── File scanning ────────────────────────────────
function isMockup(f) {
  return f.endsWith('.html') && f !== 'harness-template.html';
}

function scanDir() {
  let files;
  try { files = fs.readdirSync(DIR).filter(isMockup).sort(); }
  catch { return []; }

  const currentFiles = new Set(files);
  const changes = [];

  for (const file of files) {
    const filePath = path.join(DIR, file);
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const existing = knownFiles.get(file);

    if (!existing) {
      const html = fs.readFileSync(filePath, 'utf8');
      const id = file.replace('.html', '');
      const session = sessionForMockup(id);
      knownFiles.set(file, { mtime: stat.mtimeMs, html, session });
      changes.push({ type: 'add', id, html, session });
    } else if (stat.mtimeMs > existing.mtime) {
      const html = fs.readFileSync(filePath, 'utf8');
      knownFiles.set(file, { ...existing, mtime: stat.mtimeMs, html });
      changes.push({ type: 'update', id: file.replace('.html', ''), html });
    }
  }

  for (const [file] of knownFiles) {
    if (!currentFiles.has(file)) {
      changes.push({ type: 'remove', id: file.replace('.html', '') });
      knownFiles.delete(file);
    }
  }

  return changes;
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function pushChanges() {
  for (const change of scanDir()) broadcast(change.type, change);
}

// Initial scan
scanDir();

// Watch with debounce + polling fallback
let watchTimeout = null;
let watchWorking = false;
try {
  fs.watch(DIR, () => {
    watchWorking = true;
    if (watchTimeout) clearTimeout(watchTimeout);
    watchTimeout = setTimeout(pushChanges, 200);
  });
} catch (e) {
  console.warn('Warning: fs.watch unavailable:', e.message);
}
// Poll every 1.5s as fallback (catches cases fs.watch misses)
setInterval(() => { if (!watchWorking) pushChanges(); }, 1500);
// Slower poll even when watch is working (catches edge cases)
setInterval(pushChanges, 5000);

// ── HTTP Server ──────────────────────────────────
const template = fs.readFileSync(HARNESS, 'utf8');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const page = template.replace(
      '/*__SONIOX_KEY_INJECT__*/',
      `window.__SONIOX_KEY = ${JSON.stringify(SONIOX_KEY || '')};`
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);

  } else if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    for (const [file, data] of knownFiles) {
      const id = file.replace('.html', '');
      res.write(`event: add\ndata: ${JSON.stringify({ id, html: data.html, session: data.session })}\n\n`);
    }
    clients.push(res);
    req.on('close', () => {
      const idx = clients.indexOf(res);
      if (idx >= 0) clients.splice(idx, 1);
    });

  } else if (req.method === 'POST' && url.pathname === '/session') {
    const allIds = [...knownFiles.keys()].map(f => f.replace('.html', ''));
    const previousIds = new Set(sessions.flatMap(s => s.mockups));
    const newIds = allIds.filter(id => !previousIds.has(id));
    const session = {
      id: nextSession++,
      created: new Date().toISOString(),
      mockups: newIds.length > 0 ? newIds : allIds,
    };
    sessions.push(session);
    saveSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session));

  } else if (req.method === 'GET' && url.pathname === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));

  } else if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mockups: knownFiles.size,
      sessions: sessions.length,
      soniox: !!SONIOX_KEY,
      dir: DIR,
    }));

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  Design Explorer → http://localhost:${PORT}`);
  console.log(`  Mockup dir: ${DIR}`);
  console.log(`  Mockups: ${knownFiles.size}`);
  console.log(`  Voice:  ${SONIOX_KEY ? '✓ Soniox ready' : '✗ disabled (set SONIOX_KEY for voice notes)'}\n`);

  if (!NO_OPEN) {
    if (process.platform === 'darwin') exec(`open http://localhost:${PORT}`);
    else if (process.platform === 'linux') exec(`xdg-open http://localhost:${PORT} 2>/dev/null`);
  }
});
