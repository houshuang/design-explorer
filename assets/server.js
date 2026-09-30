#!/usr/bin/env node
// Design Explorer — Global Singleton Server (zero dependencies)
// Manages multiple workspaces, one per mockup directory.
// Usage: node server.js [--port 10000] [--no-open]

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const workspace = require('./workspace');

// ── Config ──────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(getArg('port', '10000'), 10);
const HOST = '127.0.0.1';
const NO_OPEN = args.includes('--no-open');
const HARNESS = path.join(__dirname, 'harness-template.html');
const STATE_DIR = getArg('state-dir', path.join(process.env.HOME, '.claude'));
fs.mkdirSync(STATE_DIR, { recursive: true });
const PID_FILE = path.join(STATE_DIR, 'design-explorer.pid');
const STATE_FILE = path.join(STATE_DIR, 'design-explorer-workspaces.json');
// Mockup directories must live under this root; anything else is refused at registration.
const MOCKUP_ROOT = '/tmp/claude/design-explorer';
const MAX_BODY = 1024 * 1024;

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map(h => `http://${h}`));

// bin/register compares this with the installed files and restarts a stale server.
const SERVER_SRC = fs.readFileSync(__filename);
const TEMPLATE_SRC = fs.readFileSync(HARNESS);
const CODE_HASH = crypto.createHash('sha256').update(SERVER_SRC).update(TEMPLATE_SRC).update(fs.readFileSync(path.join(__dirname, 'workspace.js'))).digest('hex');

// ── Legacy mode: if --dir is passed, run as single-workspace server ──
const LEGACY_DIR = getArg('dir', null);

// ── PID file (written once listening) ───────────
function cleanup() { try { fs.unlinkSync(PID_FILE); } catch {} process.exit(0); }
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// ── Soniox key (global) ─────────────────────────
function loadSonioxKey() {
  if (process.env.SONIOX_KEY) return process.env.SONIOX_KEY;
  if (process.env.SONIX_KEY) return process.env.SONIX_KEY;
  try {
    const match = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
      .match(/(?:SONIOX_KEY|SONIX_KEY)=(.+)/);
    if (match) return match[1].trim();
  } catch {}
  return null;
}
const SONIOX_KEY = loadSonioxKey();

// ── Workspace Registry ──────────────────────────
const workspaces = new Map(); // id → Workspace
const clients = [];           // [{res, workspaceId}]

// The id comes from the mockup directory, not the repo, so two sessions in the
// same repo (each with its own directory) never share a workspace.
function makeWorkspaceId(mockupDir) {
  return path.relative(realRoot(), mockupDir)
    .replace(/^mockups\//, '')
    .replace(/[^a-zA-Z0-9-]/g, '-');
}

function realRoot() {
  fs.mkdirSync(MOCKUP_ROOT, { recursive: true });
  return fs.realpathSync(MOCKUP_ROOT);
}

// Returns the real path of an existing directory strictly inside MOCKUP_ROOT, or null.
// realpath resolves symlinks and `..`, so neither can escape the root.
function resolveMockupDir(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  let real;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch { return null; }
  const root = realRoot();
  return real.startsWith(root + path.sep) ? real : null;
}

function isMockup(f) {
  return (f.endsWith('.html') && f !== 'harness-template.html') || /^mockup-[a-z0-9-]+\.json$/.test(f);
}

function sessionForMockup(ws, mockupId) {
  for (const s of ws.sessions) {
    if (s.mockups.includes(mockupId)) return s.id;
  }
  return null;
}

function saveSessions(ws) {
  try {
    fs.writeFileSync(
      path.join(ws.mockupDir, 'sessions.json'),
      JSON.stringify(ws.sessions, null, 2)
    );
  } catch {}
}

// Each mockup keeps one number for the life of its directory, shown in the UI,
// the feedback file and bin/lineup, so "number 7" always means the same design.
// Numbers of deleted mockups are never reused.
function numberFor(ws, mockupId) {
  if (!ws.numbers.ids[mockupId]) {
    ws.numbers.ids[mockupId] = ws.numbers.next++;
    try {
      fs.writeFileSync(path.join(ws.mockupDir, 'numbers.json'), JSON.stringify(ws.numbers, null, 2));
    } catch {}
  }
  return ws.numbers.ids[mockupId];
}

function labelOf(html, mockupId) {
  const m = html.match(/data-label\s*=\s*"([^"]*)"/);
  return m && m[1].trim() ? m[1].trim() : mockupId;
}

function lineupRounds(ws) {
  return ws.sessions.map(session => ({
    round: session.id, label: session.label || '', open: !session.closed,
    mockups: [...ws.knownFiles]
      .filter(([, data]) => data.session === session.id)
      .map(([file, data]) => ({ number: data.number, label: labelOf(data.html, file.replace(/\.(html|json)$/, '')), file }))
      .sort((a, b) => a.number - b.number),
  })).filter(r => r.mockups.length > 0).reverse();
}

function formatLineup(rounds) {
  return rounds.map(r => [
    `Round ${r.round}${r.label ? ' · ' + r.label : ''}${r.open ? ' (open)' : ''}`,
    ...r.mockups.map(m => `  #${m.number}  ${m.label}  (${m.file})`),
  ].join('\n')).join('\n');
}

function getOrCreateOpenSession(ws) {
  if (ws.openSessionId !== null) {
    const session = ws.sessions.find(s => s.id === ws.openSessionId);
    if (session && !session.closed) return session;
  }
  const session = {
    id: ws.nextSession++,
    created: new Date().toISOString(),
    mockups: [],
    closed: false,
  };
  ws.sessions.push(session);
  ws.openSessionId = session.id;
  saveSessions(ws);
  broadcastToWorkspace(ws.id, 'session', { ...session, workspace: ws.id });
  return session;
}

// An empty open round stays open, so round numbers have no gaps.
function closeOpenSession(ws) {
  const open = ws.sessions.find(s => s.id === ws.openSessionId);
  if (!open || open.closed || open.mockups.length === 0) return;
  open.closed = true;
  ws.openSessionId = null;
  saveSessions(ws);
  broadcastToWorkspace(ws.id, 'session-closed', { id: open.id, workspace: ws.id });
}

// Idempotent: while the open round has no mockups, calling it again only
// updates the label.
function startRound(ws, label, question, state) {
  // Files written just before the call still belong to the round being closed.
  pushWorkspaceChanges(ws);
  closeOpenSession(ws);
  const session = getOrCreateOpenSession(ws);
  if (question !== undefined || state !== undefined) {
    const brief = workspace.readBrief(ws.mockupDir);
    if (question !== undefined) brief.question = question;
    if (state !== undefined) brief.state = state;
    workspace.atomicWrite(path.join(ws.mockupDir, 'exploration.json'), JSON.stringify(brief, null, 2));
    broadcastToWorkspace(ws.id, 'brief', { workspace: ws.id, brief });
  }
  if (label) {
    session.label = label;
    saveSessions(ws);
    broadcastToWorkspace(ws.id, 'session', { ...session, workspace: ws.id });
  }
  return session;
}

// New and revised mockups belong to the open round, so each round shows
// exactly what changed since the last one.
function assignToOpenSession(ws, mockupId) {
  const session = getOrCreateOpenSession(ws);
  for (const s of ws.sessions) {
    if (s !== session) s.mockups = s.mockups.filter(m => m !== mockupId);
  }
  if (!session.mockups.includes(mockupId)) session.mockups.push(mockupId);
  saveSessions(ws);
  return session.id;
}

function scanWorkspace(ws) {
  let files;
  let brief;
  try {
    files = fs.readdirSync(ws.mockupDir).filter(isMockup).sort();
    brief = workspace.readBrief(ws.mockupDir);
  } catch (error) {
    broadcastToWorkspace(ws.id, 'workspace-error', { workspace: ws.id, error: error.message });
    return [];
  }
  const briefJSON = JSON.stringify(brief);
  if (briefJSON !== ws.briefJSON) {
    ws.briefJSON = briefJSON;
    broadcastToWorkspace(ws.id, 'brief', { workspace: ws.id, brief });
  }
  const currentFiles = new Set(files);
  const changes = [];
  const ids = new Set();
  for (const file of files) {
    const id = file.replace(/\.(html|json)$/, '');
    if (ids.has(id)) {
      changes.push({ type: 'workspace-error', workspace: ws.id, error: `Duplicate design: ${id}. Keep either HTML or JSON.` });
      continue;
    }
    ids.add(id);
    try {
      const stat = fs.statSync(path.join(ws.mockupDir, file));
      const existing = ws.knownFiles.get(file) || [...ws.knownFiles].find(([previous]) => previous.replace(/\.(html|json)$/, '') === id)?.[1];
      const renderConfig = JSON.stringify({ base: brief.base, styles: brief.styles, data: brief.data });
      if (ws.knownFiles.has(file) && existing.mtime === stat.mtimeMs && existing.renderConfig === renderConfig && workspace.dependenciesUnchanged(ws.mockupDir, existing.dependencies || {})) continue;
      const { html, dependencies } = workspace.compose(ws.mockupDir, file, brief);
      if (existing && html === existing.html && stat.mtimeMs === existing.mtime) {
        ws.knownFiles.set(file, { ...existing, dependencies, renderConfig });
        continue;
      }
      let sessionId = sessionForMockup(ws, id);
      if (existing) {
        const current = ws.sessions.find(s => s.id === existing.session);
        sessionId = current && !current.closed ? current.id : assignToOpenSession(ws, id);
      } else if (sessionId === null) sessionId = assignToOpenSession(ws, id);
      const number = numberFor(ws, id);
      const revision = workspace.snapshot(ws.mockupDir, id, html, sessionId, file).revision;
      ws.knownFiles.set(file, { mtime: stat.mtimeMs, html, session: sessionId, number, revision, dependencies, renderConfig });
      changes.push({ type: existing ? 'update' : 'add', id, html, session: sessionId, number, revision, workspace: ws.id });
      ws.errors.delete(file);
    } catch (error) {
      if (ws.errors.get(file) !== error.message) {
        changes.push({ type: 'workspace-error', workspace: ws.id, error: `${file}: ${error.message}` });
        ws.errors.set(file, error.message);
      }
    }
  }
  for (const [file] of ws.knownFiles) {
    if (!currentFiles.has(file)) {
      const id = file.replace(/\.(html|json)$/, '');
      if (!ids.has(id)) changes.push({ type: 'remove', id, workspace: ws.id });
      ws.knownFiles.delete(file);
    }
  }
  return changes;
}

function pushWorkspaceChanges(ws) {
  for (const change of scanWorkspace(ws)) {
    broadcastToWorkspace(ws.id, change.type, change);
  }
}

// ── Watching ─────────────────────────────────────
function startWatching(ws) {
  try { fs.mkdirSync(ws.mockupDir, { recursive: true }); } catch {}
  scanWorkspace(ws);

  try {
    ws.watcher = fs.watch(ws.mockupDir, () => {
      ws.watchWorking = true;
      if (ws.watchTimeout) clearTimeout(ws.watchTimeout);
      ws.watchTimeout = setTimeout(() => pushWorkspaceChanges(ws), 200);
    });
  } catch {}

  ws.pollTimer = setInterval(() => {
    if (!ws.watchWorking) pushWorkspaceChanges(ws);
  }, 1500);
  ws.slowPollTimer = setInterval(() => pushWorkspaceChanges(ws), 5000);
}

function stopWatching(ws) {
  if (ws.watcher) { ws.watcher.close(); ws.watcher = null; }
  if (ws.pollTimer) { clearInterval(ws.pollTimer); ws.pollTimer = null; }
  if (ws.slowPollTimer) { clearInterval(ws.slowPollTimer); ws.slowPollTimer = null; }
}

// `mockupDir` must already be validated by resolveMockupDir.
function createWorkspace(projectPath, branch, mockupDir) {
  const id = makeWorkspaceId(mockupDir);

  if (workspaces.has(id)) {
    const ws = workspaces.get(id);
    ws.lastActive = Date.now();
    return ws;
  }

  const ws = {
    id,
    projectPath,
    projectName: path.basename(projectPath),
    branch: branch || 'default',
    mockupDir,
    knownFiles: new Map(),
    errors: new Map(),
    briefJSON: '',
    sessions: [],
    nextSession: 1,
    lastActive: Date.now(),
    watcher: null, watchTimeout: null, watchWorking: false,
    pollTimer: null, slowPollTimer: null,
    openSessionId: null,
    numbers: { next: 1, ids: {} },
  };

  // Load existing sessions
  try {
    ws.sessions = JSON.parse(fs.readFileSync(path.join(ws.mockupDir, 'sessions.json'), 'utf8'));
    ws.nextSession = ws.sessions.length > 0
      ? Math.max(...ws.sessions.map(s => s.id)) + 1 : 1;
    const lastSession = ws.sessions[ws.sessions.length - 1];
    if (lastSession && !lastSession.closed) {
      ws.openSessionId = lastSession.id;
    }
  } catch {}

  try {
    const numbers = JSON.parse(fs.readFileSync(path.join(ws.mockupDir, 'numbers.json'), 'utf8'));
    if (numbers && numbers.ids && Number.isInteger(numbers.next)) ws.numbers = numbers;
  } catch {
    // Directories from before numbering: number by round, then order within it.
    for (const session of ws.sessions) {
      for (const id of session.mockups) {
        if ((fs.existsSync(path.join(ws.mockupDir, id + '.html')) || fs.existsSync(path.join(ws.mockupDir, id + '.json')))) numberFor(ws, id);
      }
    }
  }

  startWatching(ws);
  workspaces.set(id, ws);
  saveWorkspaceState();
  broadcastGlobal('workspace-add', workspaceSummary(ws));
  for (const [file, data] of ws.knownFiles) {
    broadcastToWorkspace(ws.id, 'add', { id: file.replace(/\.(html|json)$/, ''), ...data, workspace: ws.id });
  }
  broadcastToWorkspace(ws.id, 'brief', { workspace: ws.id, brief: JSON.parse(ws.briefJSON || '{}'), drafts: workspace.readDrafts(ws.mockupDir) });
  return ws;
}

function removeWorkspace(id) {
  const ws = workspaces.get(id);
  if (!ws) return;
  stopWatching(ws);
  workspaces.delete(id);
  saveWorkspaceState();
  broadcastGlobal('workspace-remove', { id });
}

// Registrations survive a restart (bin/register restarts the server when its
// code changes), so other sessions' tabs don't disappear.
function saveWorkspaceState() {
  const state = [...workspaces.values()].map(ws => ({
    projectPath: ws.projectPath, branch: ws.branch, mockupDir: ws.mockupDir,
  }));
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function restoreWorkspaceState() {
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(state)) return;
  for (const entry of state) {
    const dir = resolveMockupDir(entry && entry.mockupDir);
    if (dir && typeof entry.projectPath === 'string') {
      createWorkspace(entry.projectPath, entry.branch, dir);
    }
  }
  saveWorkspaceState();
}

// ── SSE Broadcasting ─────────────────────────────
function broadcastToWorkspace(workspaceId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (!c.workspaceId || c.workspaceId === workspaceId) c.res.write(msg);
  }
}

function broadcastGlobal(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.res.write(msg);
}

// ── Helpers ──────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) { body = ''; req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Rejects DNS-rebinding (foreign Host) and cross-site requests (foreign Origin).
// Mockup iframes are sandboxed with an opaque origin, so their requests carry
// `Origin: null` and are refused too. curl sends no Origin and is allowed.
function checkRequestOrigin(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return 'bad host';
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return 'cross-origin request';
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (req.method === 'POST' && type !== 'application/json') return 'content-type must be application/json';
  }
  return null;
}

function workspaceFromPath(pathname) {
  return workspaces.get(decodeURIComponent(pathname.split('/')[2] || ''));
}

function workspaceSummary(ws) {
  return {
    id: ws.id, projectName: ws.projectName, branch: ws.branch,
    mockupDir: ws.mockupDir, mockups: ws.knownFiles.size,
    sessions: ws.sessions.length, lastActive: ws.lastActive,
  };
}

// ── HTTP Server ──────────────────────────────────
const template = TEMPLATE_SRC.toString('utf8');
let browserOpened = false;

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    if (!res.headersSent) sendJson(res, 400, { error: error.message });
    else res.end();
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const rejection = checkRequestOrigin(req);
  if (rejection) { sendJson(res, 403, { error: rejection }); return; }

  // ── Page ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/') {
    // The Soniox key is only ever embedded in this page, which the checks above
    // limit to same-origin loads on a loopback Host.
    const page = template.replace(
      '/*__SONIOX_KEY_INJECT__*/',
      `window.__SONIOX_KEY = ${JSON.stringify(SONIOX_KEY || '').replace(/</g, '\\u003c')};`
    );
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(page);

  // ── SSE ───────────────────────────────────────
  } else if (req.method === 'GET' && url.pathname === '/events') {
    const wsId = url.searchParams.get('workspace');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send workspace list
    res.write(`event: workspaces\ndata: ${JSON.stringify(
      [...workspaces.values()].map(workspaceSummary)
    )}\n\n`);

    // Send existing mockups + sessions for relevant workspaces
    for (const [id, ws] of workspaces) {
      if (wsId && wsId !== id) continue;
      for (const [file, data] of ws.knownFiles) {
        res.write(`event: add\ndata: ${JSON.stringify({
          id: file.replace(/\.(html|json)$/, ''), html: data.html,
          session: data.session, number: data.number, revision: data.revision, workspace: id,
        })}\n\n`);
      }
      try {
        res.write(`event: brief\ndata: ${JSON.stringify({ workspace: id, brief: workspace.readBrief(ws.mockupDir), drafts: workspace.readDrafts(ws.mockupDir) })}\n\n`);
      } catch (error) {
        res.write(`event: workspace-error\ndata: ${JSON.stringify({ workspace: id, error: error.message })}\n\n`);
      }
      for (const session of ws.sessions) {
        res.write(`event: session\ndata: ${JSON.stringify({ ...session, workspace: id })}\n\n`);
      }
    }

    res.write(`event: init-complete\ndata: {}\n\n`);

    const client = { res, workspaceId: wsId || null };
    clients.push(client);
    req.on('close', () => {
      const idx = clients.indexOf(client);
      if (idx >= 0) clients.splice(idx, 1);
    });

  // ── Register workspace ────────────────────────
  } else if (req.method === 'POST' && url.pathname === '/workspace/register') {
    const body = await readBody(req);
    if (typeof body.projectPath !== 'string' || !body.projectPath || !body.mockupDir) {
      sendJson(res, 400, { error: 'projectPath and mockupDir required' });
      return;
    }
    const mockupDir = resolveMockupDir(body.mockupDir);
    if (!mockupDir) {
      sendJson(res, 400, { error: `mockupDir must be an existing directory inside ${MOCKUP_ROOT}` });
      return;
    }
    const branch = typeof body.branch === 'string' ? body.branch : 'default';
    const ws = createWorkspace(body.projectPath, branch, mockupDir);

    if (!browserOpened && !NO_OPEN) {
      browserOpened = true;
      if (process.platform === 'darwin') exec(`open http://localhost:${PORT}`);
      else if (process.platform === 'linux') exec(`xdg-open http://localhost:${PORT} 2>/dev/null`);
    }

    sendJson(res, 200, workspaceSummary(ws));

  // ── Deregister workspace ──────────────────────
  } else if (req.method === 'DELETE' && url.pathname.match(/^\/workspace\/[^/]+$/)) {
    removeWorkspace(decodeURIComponent(url.pathname.split('/')[2]));
    sendJson(res, 200, { ok: true });

  // ── Create session (scoped to workspace) ──────
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/session$/)) {
    const ws = workspaceFromPath(url.pathname);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    sendJson(res, 200, getOrCreateOpenSession(ws) || {});

  // ── Lineup: numbered mockups per round (bin/lineup) ──
  } else if (req.method === 'GET' && url.pathname === '/lineup') {
    const mockupDir = resolveMockupDir(url.searchParams.get('dir'));
    const ws = mockupDir && [...workspaces.values()].find(w => w.mockupDir === mockupDir);
    if (!ws) { sendJson(res, 404, { error: 'dir is not registered; run bin/register first' }); return; }
    pushWorkspaceChanges(ws);
    const rounds = lineupRounds(ws);
    sendJson(res, 200, { rounds, text: formatLineup(rounds) });

  // ── Start a new round (bin/round) ─────────────
  } else if (req.method === 'POST' && url.pathname === '/round') {
    const body = await readBody(req);
    const mockupDir = resolveMockupDir(body.mockupDir);
    const ws = mockupDir && [...workspaces.values()].find(w => w.mockupDir === mockupDir);
    if (!ws) { sendJson(res, 404, { error: 'mockupDir is not registered; run bin/register first' }); return; }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    const session = startRound(ws, label, typeof body.question === 'string' ? body.question : undefined, typeof body.state === 'string' ? body.state : undefined);
    sendJson(res, 200, {
      round: session.id, label: session.label || '',
      feedback: path.join(ws.mockupDir, `feedback-round-${session.id}.md`),
    });

  // ── Submit feedback (write to feedback-round-N.md) ──
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/feedback$/)) {
    const ws = workspaceFromPath(url.pathname);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const body = await readBody(req);
    // Round = the session the UI was showing, else the open one, else the latest.
    // Resubmitting the same round overwrites its file.
    const session =
      ws.sessions.find(s => s.id === body.session) ||
      ws.sessions.find(s => s.id === ws.openSessionId) ||
      ws.sessions[ws.sessions.length - 1];
    const round = session ? session.id : 1;
    const feedbackPath = path.join(ws.mockupDir, `feedback-round-${round}.md`);
    try {
      // Feedback on the open round closes it; the next files start a new one.
      if (session && session.id === ws.openSessionId) closeOpenSession(ws);
      // The lineup travels with the feedback, so "#4" in the notes resolves to a file.
      const lineup = formatLineup(lineupRounds(ws));
      const content = typeof body.content === 'string' ? body.content : '';
      workspace.atomicWrite(feedbackPath, lineup ? `${content}\n\n# Lineup\n${lineup}\n` : content);
      ws.lastActive = Date.now();
      broadcastToWorkspace(ws.id, 'feedback-submitted', { workspace: ws.id, round });
      sendJson(res, 200, { path: feedbackPath, round });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }

  } else if (req.method === 'GET' && url.pathname.match(/^\/workspace\/[^/]+\/revisions$/)) {
    const ws = workspaceFromPath(url.pathname);
    if (!ws) { sendJson(res, 404, { error: 'Workspace not found' }); return; }
    const id = url.searchParams.get('mockup');
    sendJson(res, 200, { revisions: workspace.readHistory(ws.mockupDir)[id] || [] });

  } else if (req.method === 'GET' && url.pathname.match(/^\/workspace\/[^/]+\/archive$/)) {
    const ws = workspaceFromPath(url.pathname);
    if (!ws) { sendJson(res, 404, { error: 'Workspace not found' }); return; }
    const active = new Set([...ws.knownFiles.keys()].map(file => file.replace(/\.(html|json)$/, '')));
    const archived = Object.entries(workspace.readHistory(ws.mockupDir)).filter(([id]) => !active.has(id)).map(([id, revisions]) => {
      const last = revisions[revisions.length - 1];
      return { id, number: ws.numbers.ids[id], revision: last.revision, label: labelOf(workspace.revisionHTML(ws.mockupDir, id, last.revision).html, id) };
    });
    sendJson(res, 200, { archived });

  } else if (req.method === 'GET' && url.pathname.match(/^\/workspace\/[^/]+\/revision$/)) {
    const ws = workspaceFromPath(url.pathname);
    if (!ws) { sendJson(res, 404, { error: 'Workspace not found' }); return; }
    try {
      sendJson(res, 200, workspace.revisionHTML(ws.mockupDir, url.searchParams.get('mockup'), Number(url.searchParams.get('revision'))));
    } catch (error) { sendJson(res, 404, { error: error.message }); }

  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/draft$/)) {
    const ws = workspaceFromPath(url.pathname);
    if (!ws) { sendJson(res, 404, { error: 'Workspace not found' }); return; }
    try {
      const review = workspace.saveDraft(ws.mockupDir, await readBody(req), workspace.readHistory(ws.mockupDir));
      broadcastToWorkspace(ws.id, 'draft', { workspace: ws.id, review });
      sendJson(res, 200, review);
    } catch (error) { sendJson(res, 400, { error: error.message }); }

  // ── Context: gather workspace context for AI ───
  } else if (req.method === 'GET' && url.pathname.match(/^\/workspace\/[^/]+\/context$/)) {
    const ws = workspaceFromPath(url.pathname);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }

    const mockupList = [];
    for (const [file, data] of ws.knownFiles) {
      mockupList.push({
        id: file.replace(/\.(html|json)$/, ''),
        filename: file,
        session: data.session,
        number: data.number,
        revision: data.revision,
        html: data.html,
      });
    }

    const context = {
      workspace: {
        id: ws.id,
        projectPath: ws.projectPath,
        projectName: ws.projectName,
        branch: ws.branch,
        mockupDir: ws.mockupDir,
      },
      mockups: url.searchParams.has('compact') ? mockupList.map(({ html, ...meta }) => meta) : mockupList,
      sessions: ws.sessions,
      brief: workspace.readBrief(ws.mockupDir),
      lineup: formatLineup(lineupRounds(ws)),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(context));

  // ── Health check ──────────────────────────────
  } else if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      app: 'design-explorer',
      hash: CODE_HASH,
      pid: process.pid,
      port: PORT,
      soniox: !!SONIOX_KEY,
      workspaces: [...workspaces.values()].map(workspaceSummary),
    }));

  // ── List workspaces ───────────────────────────
  } else if (req.method === 'GET' && url.pathname === '/workspaces') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...workspaces.values()].map(workspaceSummary)));

  // ── Legacy compat: POST /session ──────────────
  } else if (req.method === 'POST' && url.pathname === '/session') {
    const ws = [...workspaces.values()][0];
    if (!ws) { res.writeHead(404); res.end('No workspaces'); return; }
    const session = getOrCreateOpenSession(ws);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session || {}));

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}

server.on('error', (e) => {
  console.error(`Design Explorer failed to listen on ${HOST}:${PORT}: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  console.log(`\n  Design Explorer (singleton) → http://localhost:${PORT} (bound to ${HOST})`);
  console.log(`  PID: ${process.pid}`);
  console.log(`  Voice: ${SONIOX_KEY ? '✓ Soniox ready' : '✗ disabled'}\n`);

  restoreWorkspaceState();

  // Legacy mode: auto-register if --dir was passed
  if (LEGACY_DIR) {
    const dir = resolveMockupDir(LEGACY_DIR);
    if (!dir) {
      console.error(`  --dir must be an existing directory inside ${MOCKUP_ROOT}`);
      process.exit(1);
    }
    let branch = 'default';
    try { branch = require('child_process').execSync('git branch --show-current', { cwd: path.dirname(dir) }).toString().trim() || 'default'; } catch {}
    const projectPath = path.dirname(dir);
    createWorkspace(projectPath, branch, dir);
    console.log(`  Legacy mode: registered ${path.basename(projectPath)} (${branch})`);

    if (!NO_OPEN) {
      browserOpened = true;
      if (process.platform === 'darwin') exec(`open http://localhost:${PORT}`);
      else if (process.platform === 'linux') exec(`xdg-open http://localhost:${PORT} 2>/dev/null`);
    }
  }
});

// Idle shutdown: exit after 30 min with no workspaces and no clients
let lastActivity = Date.now();
setInterval(() => {
  if (workspaces.size > 0 || clients.length > 0) { lastActivity = Date.now(); return; }
  if (Date.now() - lastActivity > 30 * 60 * 1000) {
    console.log('Idle shutdown (30 min, no workspaces or clients)');
    process.exit(0);
  }
}, 5 * 60 * 1000);
