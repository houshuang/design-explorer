#!/usr/bin/env node
// Design Explorer — Global Singleton Server (zero dependencies)
// Manages multiple workspaces, one per project/branch.
// Usage: node server.js [--port 10000] [--no-open]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

// ── Config ──────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(getArg('port', '10000'), 10);
const NO_OPEN = args.includes('--no-open');
const HARNESS = path.join(__dirname, 'harness-template.html');
const PID_FILE = path.join(process.env.HOME, '.claude', 'design-explorer.pid');

// ── Legacy mode: if --dir is passed, run as single-workspace server ──
const LEGACY_DIR = getArg('dir', null);

// ── PID file ────────────────────────────────────
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
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
const chatHistories = new Map(); // workspaceId → [{id, role, content, mockupId, context, timestamp}]
let nextChatId = 1;

function makeWorkspaceId(projectPath, branch) {
  const name = path.basename(projectPath);
  const clean = (branch || 'default').replace(/[^a-zA-Z0-9-]/g, '-');
  return `${name}-${clean}`;
}

function isMockup(f) {
  return f.endsWith('.html') && f !== 'harness-template.html';
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

function loadChatHistory(ws) {
  if (chatHistories.has(ws.id)) return chatHistories.get(ws.id);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ws.mockupDir, 'chat-history.json'), 'utf8'));
    chatHistories.set(ws.id, data);
    if (data.length > 0) {
      const maxId = Math.max(...data.map(m => parseInt(m.id.split('-')[1] || '0', 10)));
      if (maxId >= nextChatId) nextChatId = maxId + 1;
    }
    return data;
  } catch {
    chatHistories.set(ws.id, []);
    return [];
  }
}

function saveChatHistory(ws) {
  const history = chatHistories.get(ws.id) || [];
  try {
    fs.writeFileSync(
      path.join(ws.mockupDir, 'chat-history.json'),
      JSON.stringify(history, null, 2)
    );
  } catch {}
}

function addChatMessage(ws, role, content, mockupId, context) {
  const history = loadChatHistory(ws);
  const msg = {
    id: `chat-${nextChatId++}`,
    role,
    content,
    mockupId: mockupId || null,
    context: context || null,
    timestamp: new Date().toISOString(),
  };
  history.push(msg);
  saveChatHistory(ws);
  return msg;
}

// ── AI auto-response via Claude Code CLI ─────────
const activeResponses = new Map(); // wsId → child process

function respondWithClaude(ws, userMsg) {
  // Don't respond to assistant messages or if already responding
  if (userMsg.role !== 'user') return;
  if (activeResponses.has(ws.id)) {
    // Kill previous response if a new question comes in
    try { activeResponses.get(ws.id).kill(); } catch {}
  }

  // Gather context
  const mockupFile = userMsg.mockupId ? userMsg.mockupId + '.html' : null;
  const mockupHtml = mockupFile && ws.knownFiles.has(mockupFile)
    ? ws.knownFiles.get(mockupFile).html : '';

  const history = loadChatHistory(ws);
  const threadHistory = history
    .filter(m => m.mockupId === userMsg.mockupId && m.id !== userMsg.id)
    .slice(-20) // last 20 messages for context window
    .map(m => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join('\n\n');

  // List all mockups for cross-reference
  const mockupList = [...ws.knownFiles.keys()]
    .map(f => f.replace('.html', ''))
    .join(', ');

  const systemPrompt = `You are an AI assistant integrated into a Design Explorer tool. You help review and analyze design mockups — answering questions about design choices, code patterns, visual decisions, and suggesting improvements.

## Current context
- Project: ${ws.projectPath}
- Branch: ${ws.branch}
- Current mockup: ${userMsg.mockupId || 'none'}
- All mockups in session: ${mockupList}

${mockupHtml ? `## Current mockup HTML\n\`\`\`html\n${mockupHtml}\n\`\`\`` : ''}

${threadHistory ? `## Conversation history for this thread\n${threadHistory}` : ''}

## Instructions
- Answer questions about the mockup's design: typography, colors, layout, components, interactions
- When referencing code, cite specific files and line numbers
- Use the tools available to explore the project codebase, git history, and related files
- Keep responses concise and actionable — this is a review context, not a tutorial
- Format with markdown: use code blocks, bold for emphasis, lists for comparisons`;

  // Broadcast typing indicator
  broadcastToWorkspace(ws.id, 'chat_typing', {
    type: 'chat_typing', active: true, workspace: ws.id,
  });

  const streamMsgId = `chat-${nextChatId++}`;
  let fullContent = '';
  let buffer = '';

  const proc = spawn('claude', [
    '-p', userMsg.content,
    '-s', systemPrompt,
    '--output-format', 'text',
    '--allowedTools', 'Read,Grep,Glob,Bash(git log:git diff:git show:git blame:ls)',
  ], {
    cwd: ws.projectPath,
    env: { ...process.env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeResponses.set(ws.id, proc);

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    fullContent += text;
    broadcastToWorkspace(ws.id, 'chat_stream', {
      type: 'chat_stream',
      messageId: streamMsgId,
      chunk: text,
      done: false,
      mockupId: userMsg.mockupId,
      workspace: ws.id,
    });
  });

  proc.stderr.on('data', () => {}); // suppress stderr

  proc.on('close', (code) => {
    activeResponses.delete(ws.id);

    // Stop typing indicator
    broadcastToWorkspace(ws.id, 'chat_typing', {
      type: 'chat_typing', active: false, workspace: ws.id,
    });

    if (fullContent.trim()) {
      // Save the full response
      const msg = addChatMessage(ws, 'assistant', fullContent.trim(), userMsg.mockupId);
      broadcastToWorkspace(ws.id, 'chat_stream', {
        type: 'chat_stream',
        messageId: streamMsgId,
        chunk: '',
        done: true,
        content: fullContent.trim(),
        mockupId: userMsg.mockupId,
        workspace: ws.id,
      });
      // Also broadcast as regular message for history
      broadcastToWorkspace(ws.id, 'chat_message', {
        type: 'chat_message', ...msg, workspace: ws.id,
      });
    } else if (code !== 0) {
      // Send error message
      const errMsg = addChatMessage(ws, 'assistant',
        '_Failed to get a response. Make sure `claude` CLI is available and you\'re logged in._',
        userMsg.mockupId);
      broadcastToWorkspace(ws.id, 'chat_message', {
        type: 'chat_message', ...errMsg, workspace: ws.id,
      });
    }
  });

  // Close stdin immediately (non-interactive mode)
  proc.stdin.end();
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

function scanWorkspace(ws) {
  let files;
  try { files = fs.readdirSync(ws.mockupDir).filter(isMockup).sort(); }
  catch { return []; }

  const currentFiles = new Set(files);
  const changes = [];

  for (const file of files) {
    const filePath = path.join(ws.mockupDir, file);
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const existing = ws.knownFiles.get(file);

    if (!existing) {
      const html = fs.readFileSync(filePath, 'utf8');
      const id = file.replace('.html', '');
      let sessionId = sessionForMockup(ws, id);
      if (sessionId === null) {
        const session = getOrCreateOpenSession(ws);
        if (!session.mockups.includes(id)) {
          session.mockups.push(id);
          saveSessions(ws);
        }
        sessionId = session.id;
      }
      ws.knownFiles.set(file, { mtime: stat.mtimeMs, html, session: sessionId });
      changes.push({ type: 'add', id, html, session: sessionId, workspace: ws.id });
    } else if (stat.mtimeMs > existing.mtime) {
      const html = fs.readFileSync(filePath, 'utf8');
      ws.knownFiles.set(file, { ...existing, mtime: stat.mtimeMs, html });
      changes.push({ type: 'update', id: file.replace('.html', ''), html, workspace: ws.id });
    }
  }

  for (const [file] of ws.knownFiles) {
    if (!currentFiles.has(file)) {
      changes.push({ type: 'remove', id: file.replace('.html', ''), workspace: ws.id });
      ws.knownFiles.delete(file);
    }
  }

  // Reset sessions when all mockups are deleted (clean start)
  if (ws.knownFiles.size === 0 && ws.sessions.length > 0) {
    ws.sessions = [];
    ws.nextSession = 1;
    ws.openSessionId = null;
    saveSessions(ws);
  }

  ws.lastActive = Date.now();
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

function createWorkspace(projectPath, branch, mockupDir) {
  const id = makeWorkspaceId(projectPath, branch);

  if (workspaces.has(id)) {
    const ws = workspaces.get(id);
    ws.lastActive = Date.now();
    if (ws.mockupDir !== path.resolve(mockupDir)) {
      stopWatching(ws);
      ws.mockupDir = path.resolve(mockupDir);
      startWatching(ws);
    }
    return ws;
  }

  const ws = {
    id,
    projectPath,
    projectName: path.basename(projectPath),
    branch: branch || 'default',
    mockupDir: path.resolve(mockupDir),
    knownFiles: new Map(),
    sessions: [],
    nextSession: 1,
    lastActive: Date.now(),
    watcher: null, watchTimeout: null, watchWorking: false,
    pollTimer: null, slowPollTimer: null,
    openSessionId: null,
    batching: false,
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

  startWatching(ws);
  workspaces.set(id, ws);
  broadcastGlobal('workspace-add', { id, projectName: ws.projectName, branch: ws.branch });
  return ws;
}

function removeWorkspace(id) {
  const ws = workspaces.get(id);
  if (!ws) return;
  stopWatching(ws);
  workspaces.delete(id);
  broadcastGlobal('workspace-remove', { id });
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
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function workspaceSummary(ws) {
  return {
    id: ws.id, projectName: ws.projectName, branch: ws.branch,
    mockupDir: ws.mockupDir, mockups: ws.knownFiles.size,
    sessions: ws.sessions.length, lastActive: ws.lastActive,
  };
}

// ── HTTP Server ──────────────────────────────────
const template = fs.readFileSync(HARNESS, 'utf8');
let browserOpened = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Page ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/') {
    const page = template.replace(
      '/*__SONIOX_KEY_INJECT__*/',
      `window.__SONIOX_KEY = ${JSON.stringify(SONIOX_KEY || '')};`
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
          id: file.replace('.html', ''), html: data.html,
          session: data.session, workspace: id,
        })}\n\n`);
      }
      for (const session of ws.sessions) {
        res.write(`event: session\ndata: ${JSON.stringify({ ...session, workspace: id })}\n\n`);
      }
      // Send existing chat history
      const chatHistory = loadChatHistory(ws);
      if (chatHistory.length > 0) {
        res.write(`event: chat_history\ndata: ${JSON.stringify({ workspace: id, messages: chatHistory })}\n\n`);
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
    if (!body.projectPath || !body.mockupDir) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'projectPath and mockupDir required' }));
      return;
    }
    const ws = createWorkspace(body.projectPath, body.branch, body.mockupDir);

    if (!browserOpened && !NO_OPEN) {
      browserOpened = true;
      if (process.platform === 'darwin') exec(`open http://localhost:${PORT}`);
      else if (process.platform === 'linux') exec(`xdg-open http://localhost:${PORT} 2>/dev/null`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(workspaceSummary(ws)));

  // ── Deregister workspace ──────────────────────
  } else if (req.method === 'DELETE' && url.pathname.startsWith('/workspace/')) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    removeWorkspace(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  // ── Batch start (suppress auto-session during writes) ──
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/batch\/start$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    ws.batching = true;
    ws.lastActive = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ batching: true }));

  // ── Batch end (create session immediately with all unassigned mockups) ──
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/batch\/end$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    ws.batching = false;
    ws.lastActive = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  // ── Create session (scoped to workspace) ──────
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/session$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const session = getOrCreateOpenSession(ws);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session || {}));

  // ── Submit feedback (write to file) ───────────
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/feedback$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const body = await readBody(req);
    const feedbackPath = path.join(ws.mockupDir, 'feedback.md');
    try {
      fs.writeFileSync(feedbackPath, body.content || '');
      // Close current session — next files start a new round
      if (ws.openSessionId !== null) {
        const session = ws.sessions.find(s => s.id === ws.openSessionId);
        if (session) {
          session.closed = true;
          saveSessions(ws);
          broadcastToWorkspace(ws.id, 'session-closed', { id: session.id, workspace: ws.id });
        }
        ws.openSessionId = null;
      }
      ws.lastActive = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: feedbackPath }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  // ── Chat: send message ───────────────────────
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/chat$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const body = await readBody(req);
    if (!body.message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'message required' }));
      return;
    }
    const msg = addChatMessage(ws, 'user', body.message, body.mockupId, body.context);
    broadcastToWorkspace(ws.id, 'chat_message', {
      type: 'chat_message', ...msg, workspace: ws.id,
    });
    ws.lastActive = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));

    // Auto-respond with Claude Code CLI
    respondWithClaude(ws, msg);

  // ── Chat: get history ──────────────────────────
  } else if (req.method === 'GET' && url.pathname.match(/^\/workspace\/[^/]+\/chat$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const history = loadChatHistory(ws);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));

  // ── Chat: post response to a message ───────────
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/chat\/[^/]+\/respond$/)) {
    const parts = url.pathname.split('/');
    const id = decodeURIComponent(parts[2]);
    const messageId = decodeURIComponent(parts[4]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const body = await readBody(req);
    const role = body.role || 'assistant';
    const msg = addChatMessage(ws, role, body.content || '', body.mockupId);
    msg.inReplyTo = messageId;
    saveChatHistory(ws);
    broadcastToWorkspace(ws.id, 'chat_message', {
      type: 'chat_message', ...msg, workspace: ws.id,
    });
    ws.lastActive = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));

  // ── Chat: stream a chunk (for progressive responses) ──
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/chat\/stream$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const body = await readBody(req);
    // body: {messageId, chunk, done}
    broadcastToWorkspace(ws.id, 'chat_stream', {
      type: 'chat_stream',
      messageId: body.messageId || null,
      chunk: body.chunk || '',
      done: !!body.done,
      workspace: ws.id,
    });
    // If done and there's a full content, save it
    if (body.done && body.content) {
      const msg = addChatMessage(ws, 'assistant', body.content, body.mockupId);
      msg.inReplyTo = body.messageId;
      saveChatHistory(ws);
    }
    ws.lastActive = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  // ── Chat: typing indicator ─────────────────────
  } else if (req.method === 'POST' && url.pathname.match(/^\/workspace\/[^/]+\/chat\/typing$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }
    const body = await readBody(req);
    broadcastToWorkspace(ws.id, 'chat_typing', {
      type: 'chat_typing',
      active: !!body.active,
      workspace: ws.id,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  // ── Context: gather workspace context for AI ───
  } else if (req.method === 'GET' && url.pathname.match(/^\/workspace\/[^/]+\/context$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const ws = workspaces.get(id);
    if (!ws) { res.writeHead(404); res.end('Workspace not found'); return; }

    const mockupList = [];
    for (const [file, data] of ws.knownFiles) {
      mockupList.push({
        id: file.replace('.html', ''),
        filename: file,
        session: data.session,
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
      mockups: mockupList,
      sessions: ws.sessions,
      chatHistory: loadChatHistory(ws),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(context));

  // ── Health check ──────────────────────────────
  } else if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
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
});

server.listen(PORT, () => {
  console.log(`\n  Design Explorer (singleton) → http://localhost:${PORT}`);
  console.log(`  PID: ${process.pid}`);
  console.log(`  Voice: ${SONIOX_KEY ? '✓ Soniox ready' : '✗ disabled'}\n`);

  // Legacy mode: auto-register if --dir was passed
  if (LEGACY_DIR) {
    const dir = path.resolve(LEGACY_DIR);
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
