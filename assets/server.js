#!/usr/bin/env node
// Design Explorer Server — zero external dependencies
// Usage: node server.js --dir ./mockups --port 8000

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const crypto = require('crypto');

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
const FEEDBACK_FILE = path.join(DIR, 'feedback.json');
const ANNOTATIONS_DIR = path.join(DIR, 'annotations');

// --- Soniox config ---
const SONIOX_BASE_URL = 'api.soniox.com';
const SONIOX_MODEL = 'stt-async-v4';
const SONIOX_POLL_INTERVAL_MS = 2000;
const SONIOX_POLL_TIMEOUT_MS = 120000;

function getSonioxKey() {
  // CLI arg > env var > .env files
  const fromArg = getArg('soniox-key', null);
  if (fromArg) return fromArg;
  if (process.env.SONIOX_API_KEY) return process.env.SONIOX_API_KEY;
  if (process.env.SONIX_KEY) return process.env.SONIX_KEY;
  // Try common .env locations
  for (const envPath of [
    path.join(DIR, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(process.env.HOME, 'src', 'petrarca', '.env'),
    path.join(process.env.HOME, 'src', 'alignment', '.env'),
  ]) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/(?:SONIOX_API_KEY|SONIX_KEY)\s*=\s*(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  return null;
}
const SONIOX_KEY = getSonioxKey();

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
      if (filename && (filename.startsWith('mockup-') && filename.endsWith('.html'))) {
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

  if (mockupFiles.length === 0) {
    return null; // no mockups yet
  }

  let harness = fs.readFileSync(HARNESS_TEMPLATE, 'utf8');
  const fragments = mockupFiles.map(f =>
    fs.readFileSync(path.join(DIR, f), 'utf8')
  ).join('\n\n');

  // Insert fragments at the marker
  const marker = '<!-- === MOCKUP SECTIONS GO HERE === -->';
  if (harness.includes(marker)) {
    harness = harness.replace(marker, marker + '\n' + fragments);
  } else {
    // Fallback: insert before </body>
    harness = harness.replace('</body>', fragments + '\n</body>');
  }

  return harness;
}

// --- Feedback store ---
function readFeedback() {
  if (!fs.existsSync(FEEDBACK_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeFeedback(data) {
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(data, null, 2));
}

// --- Feedback long-poll waiters ---
let feedbackWaiters = [];

function notifyFeedbackWaiters(feedback) {
  while (feedbackWaiters.length) {
    const { res, timer } = feedbackWaiters.shift();
    clearTimeout(timer);
    sendJSON(res, { status: 'new_feedback', count: feedback.length });
  }
}

// --- Soniox API helpers (zero-dep HTTPS) ---

function sonioxRequest(method, apiPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SONIOX_BASE_URL,
      path: `/v1${apiPath}`,
      method,
      headers: {
        'Authorization': `Bearer ${SONIOX_KEY}`,
      }
    };

    if (body && contentType) {
      options.headers['Content-Type'] = contentType;
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data, raw: true });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function sonioxUpload(audioBuffer, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----DexBoundary' + crypto.randomBytes(8).toString('hex');
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, audioBuffer, footer]);

    const options = {
      hostname: SONIOX_BASE_URL,
      path: '/v1/files',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SONIOX_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString();
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Upload failed (${res.statusCode}): ${data}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Upload parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Upload timeout')); });
    req.write(body);
    req.end();
  });
}

async function transcribeWithSoniox(audioBuffer, format) {
  const ext = format === 'webm' ? 'webm' : format === 'mp4' ? 'mp4' : 'webm';

  // 1. Upload audio file
  console.log(`  Uploading ${audioBuffer.length} bytes to Soniox...`);
  const uploadResult = await sonioxUpload(audioBuffer, `critique.${ext}`);
  const fileId = uploadResult.id;
  console.log(`  File uploaded: ${fileId}`);

  try {
    // 2. Create transcription
    const createBody = JSON.stringify({
      model: SONIOX_MODEL,
      file_id: fileId,
      language_hints: ['en', 'no', 'sv', 'da', 'it', 'de', 'es', 'fr', 'zh', 'id'],
    });
    const createResult = await sonioxRequest('POST', '/transcriptions', createBody, 'application/json');
    if (createResult.status >= 400) {
      throw new Error(`Create transcription failed: ${JSON.stringify(createResult.data)}`);
    }
    const transcriptionId = createResult.data.id;
    console.log(`  Transcription created: ${transcriptionId}`);

    // 3. Poll until complete
    const pollStart = Date.now();
    while (true) {
      const pollResult = await sonioxRequest('GET', `/transcriptions/${transcriptionId}`);
      const status = pollResult.data.status;

      if (status === 'completed') {
        console.log(`  Transcription completed (${Math.round((Date.now() - pollStart) / 1000)}s)`);
        break;
      }
      if (status === 'error') {
        throw new Error(`Transcription error: ${pollResult.data.error_message || 'unknown'}`);
      }
      if (Date.now() - pollStart > SONIOX_POLL_TIMEOUT_MS) {
        throw new Error('Transcription timed out');
      }
      await new Promise(r => setTimeout(r, SONIOX_POLL_INTERVAL_MS));
    }

    // 4. Get transcript with tokens
    const transcriptResult = await sonioxRequest('GET', `/transcriptions/${transcriptionId}/transcript`);
    if (transcriptResult.status >= 400) {
      throw new Error(`Get transcript failed: ${JSON.stringify(transcriptResult.data)}`);
    }

    return transcriptResult.data;
  } finally {
    // 5. Cleanup: delete file and transcription
    sonioxRequest('DELETE', `/files/${fileId}`).catch(() => {});
  }
}

// --- Merge Soniox tokens with hover/annotation logs ---

function mergeTranscript(sonioxResult, hoverLog, annotationLog, iteration) {
  const tokens = sonioxResult.tokens || [];

  if (tokens.length === 0) {
    // Fallback: plain text only
    const text = sonioxResult.text || '';
    if (!text) return { transcript: '(No speech detected)', duration_s: 0 };
    return { transcript: text, duration_s: 0 };
  }

  // Group tokens into segments by pauses (>600ms gap) or sentence-ending punctuation
  const segments = [];
  let currentSeg = { startMs: tokens[0].start_ms, endMs: tokens[0].end_ms, text: '' };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    currentSeg.text += tok.text;
    currentSeg.endMs = tok.end_ms;

    const nextTok = tokens[i + 1];
    const gap = nextTok ? nextTok.start_ms - tok.end_ms : Infinity;
    const endsWithPunct = /[.!?]\s*$/.test(currentSeg.text);

    if (gap > 600 || (endsWithPunct && gap > 200) || !nextTok) {
      currentSeg.text = currentSeg.text.trim();
      if (currentSeg.text) segments.push(currentSeg);
      if (nextTok) {
        currentSeg = { startMs: nextTok.start_ms, endMs: nextTok.end_ms, text: '' };
      }
    }
  }

  if (segments.length === 0) {
    return { transcript: '(No speech detected)', duration_s: 0 };
  }

  const totalDuration = Math.round(segments[segments.length - 1].endMs / 1000);

  let output = `=== Critique Session (${totalDuration}s) — Iteration ${iteration} ===\n`;
  let lastMockupId = null;

  for (const seg of segments) {
    const relevantHover = hoverLog
      .filter(h => h.t <= seg.startMs)
      .sort((a, b) => b.t - a.t)[0];

    if (relevantHover && relevantHover.mockupId !== lastMockupId) {
      lastMockupId = relevantHover.mockupId;
      const num = relevantHover.mockupId.replace('mockup-', '');
      output += `\n[Mockup ${num}: "${relevantHover.label}"]\n`;
    }

    output += seg.text + '\n';

    const relevantAnnotations = annotationLog.filter(
      a => a.t >= seg.startMs && a.t <= seg.endMs
    );
    for (const ann of relevantAnnotations) {
      output += `[📝 Drawing annotation: ${ann.imageFile}]\n`;
    }
  }

  output += '\n=== End ===';
  return { transcript: output, duration_s: totalDuration };
}

// --- Save annotation image ---
function saveAnnotation(dataUrl) {
  if (!fs.existsSync(ANNOTATIONS_DIR)) {
    fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });
  }
  const existing = fs.readdirSync(ANNOTATIONS_DIR).filter(f => f.startsWith('annotation_'));
  const num = String(existing.length + 1).padStart(3, '0');
  const filename = `annotation_${num}.png`;
  const filepath = path.join(ANNOTATIONS_DIR, filename);

  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
  return `annotations/${filename}`;
}

// --- HTTP helpers ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(html);
}

// --- Request handler ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  try {
    // GET / — assemble harness + mockup fragments
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

    // GET /events — SSE
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('event: connected\ndata: {}\n\n');
      sseClients.push(res);
      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
      });
      return;
    }

    // GET /feedback — return all feedback
    if (url.pathname === '/feedback' && req.method === 'GET') {
      sendJSON(res, readFeedback());
      return;
    }

    // GET /feedback/wait — long-poll until new feedback arrives
    if (url.pathname === '/feedback/wait' && req.method === 'GET') {
      const timeout = Math.min(
        parseInt(url.searchParams.get('timeout') || '120000', 10),
        300000
      );
      const sinceCount = parseInt(url.searchParams.get('since') || '0', 10);

      // Check if there's already new feedback
      const current = readFeedback();
      if (current.length > sinceCount) {
        sendJSON(res, { status: 'new_feedback', count: current.length });
        return;
      }

      // Wait for new feedback
      const timer = setTimeout(() => {
        feedbackWaiters = feedbackWaiters.filter(w => w.res !== res);
        sendJSON(res, { status: 'timeout' });
      }, timeout);

      feedbackWaiters.push({ res, timer });

      req.on('close', () => {
        clearTimeout(timer);
        feedbackWaiters = feedbackWaiters.filter(w => w.res !== res);
      });
      return;
    }

    // POST /feedback — accept structured feedback
    if (url.pathname === '/feedback' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());

      // Process any base64 annotations into files
      if (body.mockups) {
        for (const mockup of body.mockups) {
          if (mockup.pendingAnnotations) {
            mockup.annotations = mockup.annotations || [];
            for (const ann of mockup.pendingAnnotations) {
              if (ann.compositeDataUrl) {
                mockup.annotations.push(saveAnnotation(ann.compositeDataUrl));
              } else if (ann.imageDataUrl) {
                mockup.annotations.push(saveAnnotation(ann.imageDataUrl));
              }
            }
            delete mockup.pendingAnnotations;
          }
        }
      }

      const feedback = readFeedback();
      feedback.push({
        iteration: feedback.length + 1,
        submittedAt: new Date().toISOString(),
        ...body
      });
      writeFeedback(feedback);

      // Notify any long-poll waiters
      notifyFeedbackWaiters(feedback);

      sendJSON(res, { ok: true, iteration: feedback.length });
      return;
    }

    // POST /transcribe — voice + hover + annotations → merged transcript
    if (url.pathname === '/transcribe' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const { audio, format, hoverLog, annotationLog } = body;

      if (!audio || audio.length < 100) {
        sendJSON(res, { error: 'No audio data received. Check microphone.' }, 400);
        return;
      }

      if (!SONIOX_KEY) {
        sendJSON(res, {
          error: 'Soniox API key not configured. Set SONIOX_API_KEY env var or pass --soniox-key.'
        }, 503);
        return;
      }

      // Save any annotation images first
      const processedAnnotations = [];
      if (annotationLog) {
        for (const ann of annotationLog) {
          if (ann.imageDataUrl) {
            const saved = saveAnnotation(ann.imageDataUrl);
            processedAnnotations.push({ ...ann, imageFile: saved });
          } else {
            processedAnnotations.push(ann);
          }
        }
      }

      // Decode + transcribe via Soniox
      const audioBuffer = Buffer.from(audio, 'base64');
      console.log(`Transcribing ${audioBuffer.length} bytes of ${format} audio via Soniox...`);

      try {
        const sonioxResult = await transcribeWithSoniox(audioBuffer, format || 'webm');

        const feedback = readFeedback();
        const iteration = feedback.length + 1;

        const result = mergeTranscript(
          sonioxResult,
          hoverLog || [],
          processedAnnotations,
          iteration
        );

        console.log(`Transcription complete: ${result.duration_s}s`);
        sendJSON(res, result);
      } catch (err) {
        console.error('Soniox transcription error:', err);
        sendJSON(res, { error: 'Transcription failed: ' + err.message }, 500);
      }
      return;
    }

    // GET /health
    if (url.pathname === '/health' && req.method === 'GET') {
      const mockupFiles = fs.readdirSync(DIR)
        .filter(f => f.match(/^mockup-\d+.*\.html$/));
      sendJSON(res, {
        status: 'ok',
        transcription: SONIOX_KEY ? 'soniox' : 'not configured',
        sonioxModel: SONIOX_MODEL,
        mockupCount: mockupFiles.length,
        mockupFiles,
        feedbackCount: readFeedback().length,
        dir: DIR
      });
      return;
    }

    // Serve annotation images
    if (url.pathname.startsWith('/annotations/') && req.method === 'GET') {
      const filePath = path.join(DIR, url.pathname);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(data);
        return;
      }
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('Error:', err);
    sendJSON(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Design Explorer server running at http://localhost:${PORT}`);
  console.log(`Mockup dir: ${DIR}`);
  console.log(`Harness: ${HARNESS_TEMPLATE}`);
  console.log(`Transcription: ${SONIOX_KEY ? `Soniox (${SONIOX_MODEL})` : 'NOT CONFIGURED — set SONIOX_API_KEY'}`);
  startWatcher();

  // Auto-open browser
  if (!NO_OPEN) {
    if (process.platform === 'darwin') {
      exec(`open http://localhost:${PORT}`);
    } else if (process.platform === 'linux') {
      exec(`xdg-open http://localhost:${PORT} 2>/dev/null`);
    }
  }
});
