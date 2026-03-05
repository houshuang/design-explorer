#!/usr/bin/env node
// Design Explorer Server — zero external dependencies
// Serves harness template + mockup-*.html fragments with SSE auto-reload
// Usage: node server.js --dir ./mockups --port 8000

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const DIR = path.resolve(getArg('dir', '.'));
const PORT = parseInt(getArg('port', '8000'), 10);
const NO_OPEN = args.includes('--no-open');
const HARNESS_TEMPLATE = getArg('harness',
  path.join(__dirname, 'harness-template.html'));

// --- SSE clients ---
let sseClients = [];
let debounceTimer = null;

function broadcastReload() {
  for (const res of sseClients) {
    res.write('event: reload\ndata: {}\n\n');
  }
}

// Watch directory for mockup-*.html changes
let watcher = null;
function startWatcher() {
  if (watcher) return;
  try {
    watcher = fs.watch(DIR, { persistent: false }, (eventType, filename) => {
      if (filename && filename.startsWith('mockup-') && filename.endsWith('.html')) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(broadcastReload, 200);
      }
    });
  } catch (e) {
    console.warn('Warning: could not watch directory:', e.message);
  }
}

// Assemble page: harness template + mockup-*.html fragments
function assemblePage() {
  const mockupFiles = fs.readdirSync(DIR)
    .filter(f => f.match(/^mockup-\d+.*\.html$/))
    .sort((a, b) => {
      const numA = parseInt(a.match(/^mockup-(\d+)/)[1]);
      const numB = parseInt(b.match(/^mockup-(\d+)/)[1]);
      return numA - numB;
    });

  if (mockupFiles.length === 0) return null;

  let harness = fs.readFileSync(HARNESS_TEMPLATE, 'utf8');
  const fragments = mockupFiles.map(f =>
    fs.readFileSync(path.join(DIR, f), 'utf8')
  ).join('\n\n');

  const marker = '<!-- === MOCKUP SECTIONS GO HERE === -->';
  if (harness.includes(marker)) {
    harness = harness.replace(marker, marker + '\n' + fragments);
  } else {
    harness = harness.replace('</body>', fragments + '\n</body>');
  }

  return harness;
}

function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// --- Request handler ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET / — assemble page
  if (url.pathname === '/' && req.method === 'GET') {
    const html = assemblePage();
    if (!html) {
      sendHTML(res, `<!DOCTYPE html><html><body style="background:#0a0a0a;color:#aaa;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="text-align:center">
          <h1 style="font-size:20px;color:#666;">Design Explorer</h1>
          <p>Waiting for mockup files…</p>
          <p style="font-size:12px;color:#555;margin-top:8px;">Write mockup-1.html, mockup-2.html, etc. to ${DIR}</p>
        </div>
        <script>const es=new EventSource('/events');es.addEventListener('reload',()=>location.reload());</script>
      </body></html>`);
      return;
    }
    sendHTML(res, html);
    return;
  }

  // GET /events — SSE for auto-reload
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // GET /health
  if (url.pathname === '/health' && req.method === 'GET') {
    const mockupFiles = fs.readdirSync(DIR)
      .filter(f => f.match(/^mockup-\d+.*\.html$/));
    const body = JSON.stringify({
      status: 'ok',
      mockupCount: mockupFiles.length,
      mockupFiles,
      dir: DIR
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Design Explorer running at http://localhost:${PORT}`);
  console.log(`Mockup dir: ${DIR}`);
  startWatcher();

  if (!NO_OPEN) {
    if (process.platform === 'darwin') {
      exec(`open http://localhost:${PORT}`);
    } else if (process.platform === 'linux') {
      exec(`xdg-open http://localhost:${PORT} 2>/dev/null`);
    }
  }
});
