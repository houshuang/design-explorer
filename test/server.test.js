// Run with: node --test test/server.test.js
// Starts a private server on a spare port with a temporary HOME, via bin/register.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO = path.join(__dirname, '..');
const REGISTER = path.join(REPO, 'bin', 'register');
const PORT = Number(process.env.DE_TEST_PORT || 10077);
const ROOT = '/tmp/claude/design-explorer';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'de-test-home-'));
const MOCKUP_DIR = path.join(ROOT, 'mockups', `de-test-${crypto.randomBytes(4).toString('hex')}`);
const env = { ...process.env, HOME };

function request({ method = 'GET', pathname = '/', headers = {}, body, host = '127.0.0.1', port = PORT }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: pathname, headers, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (headers.Accept === 'text/event-stream' && data.includes('init-complete')) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const json = { 'Content-Type': 'application/json' };

function register(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(REGISTER, args, { env: { ...env, ...extraEnv } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: stdout.trim(), stderr });
    });
  });
}

let workspaceId;
let serverPid;

before(async () => {
  fs.mkdirSync(MOCKUP_DIR, { recursive: true });
  const r = await register(['--project', REPO, '--dir', MOCKUP_DIR, '--port', String(PORT)]);
  assert.equal(r.code, 0, r.stderr);
  workspaceId = r.stdout;
  serverPid = JSON.parse((await request({ pathname: '/health' })).body).pid;
});

after(() => {
  try { process.kill(serverPid, 'SIGTERM'); } catch {}
  fs.rmSync(MOCKUP_DIR, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('server keeps running after register exits (detached)', () => {
  assert.doesNotThrow(() => process.kill(serverPid, 0));
});

test('binds to 127.0.0.1 only: LAN address refuses connections', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) { t.skip('no LAN interface'); return; }
  await assert.rejects(request({ host: lan.address, pathname: '/health' }), /ECONNREFUSED|timeout/);
});

test('no wildcard CORS header', async () => {
  const r = await request({ pathname: '/health' });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('health reports the code hash of server.js + harness', async () => {
  const h = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(REPO, 'assets/server.js')))
    .update(fs.readFileSync(path.join(REPO, 'assets/harness-template.html')))
    .digest('hex');
  const r = JSON.parse((await request({ pathname: '/health' })).body);
  assert.equal(r.app, 'design-explorer');
  assert.equal(r.hash, h);
});

test('foreign Host header is rejected (DNS rebinding)', async () => {
  const r = await request({ pathname: '/', headers: { Host: `evil.example:${PORT}` } });
  assert.equal(r.status, 403);
  assert.ok(!r.body.includes('__SONIOX_KEY'));
});

test('cross-origin requests are rejected', async () => {
  const body = { projectPath: REPO, mockupDir: MOCKUP_DIR };
  for (const origin of ['http://evil.example', 'null', 'http://localhost:3000']) {
    const r = await request({ method: 'POST', pathname: '/workspace/register', headers: { ...json, Origin: origin }, body });
    assert.equal(r.status, 403, origin);
  }
  const page = await request({ pathname: '/', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(page.status, 403);
  const form = await request({ method: 'POST', pathname: `/workspace/${workspaceId}/feedback`, headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 403);
});

test('same-origin browser requests are accepted', async () => {
  const r = await request({ pathname: '/', headers: { Origin: `http://localhost:${PORT}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(r.status, 200);
});

test('register refuses directories outside the mockup root', async () => {
  const escape = path.join(MOCKUP_DIR, 'escape-link');
  fs.symlinkSync('/etc', escape);
  try {
    for (const dir of ['/tmp', '/etc', `${ROOT}/../../../etc`, ROOT, escape, `${ROOT}/does-not-exist`]) {
      const r = await request({ method: 'POST', pathname: '/workspace/register', headers: json, body: { projectPath: REPO, mockupDir: dir } });
      assert.equal(r.status, 400, dir);
    }
  } finally {
    fs.unlinkSync(escape);
  }
  const cli = await register(['--project', REPO, '--dir', fs.mkdtempSync(path.join(os.tmpdir(), 'de-outside-')), '--port', String(PORT)]);
  assert.notEqual(cli.code, 0);
});

test('path traversal finds nothing', async () => {
  for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', `/${ROOT}/x.html`]) {
    const r = await request({ pathname: p });
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('root:'));
  }
  const r = await request({ method: 'POST', pathname: '/workspace/..%2F..%2F..%2Fetc/feedback', headers: json, body: { content: 'x' } });
  assert.equal(r.status, 404);
});

test('chat and batch endpoints are gone', async () => {
  for (const p of ['chat', 'batch/start', 'batch/end']) {
    const r = await request({ method: 'POST', pathname: `/workspace/${workspaceId}/${p}`, headers: json, body: { message: 'hi' } });
    assert.equal(r.status, 404, p);
  }
});

test('register builds JSON safely for paths with quotes', async () => {
  const odd = path.join(ROOT, 'mockups', `de-test-"quote's-${crypto.randomBytes(3).toString('hex')}`);
  try {
    const r = await register(['--project', '/tmp/pro"ject', '--dir', odd, '--port', String(PORT)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^de-test--quote-s-/);
  } finally {
    fs.rmSync(odd, { recursive: true, force: true });
  }
});

test('register fails loudly when the port belongs to something else', async () => {
  const squatter = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\n\r\nhello')).listen(0, '127.0.0.1');
  await new Promise((r) => squatter.on('listening', r));
  const port = squatter.address().port;
  try {
    const r = await register(['--project', REPO, '--dir', MOCKUP_DIR, '--port', String(port)]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not design-explorer/);
    assert.match(r.stderr, /design-explorer\.log/);
  } finally {
    squatter.close();
  }
});

test('full cycle: register -> mockup served -> feedback-round-1.md written', async () => {
  fs.writeFileSync(path.join(MOCKUP_DIR, 'mockup-test-card.html'),
    '<section class="mockup-section" data-mockup-id="mockup-test-card" data-label="Test Card"><h1>Hello</h1></section>');
  // The watcher debounces for 200ms; poll the SSE snapshot until the mockup appears.
  let events = '';
  for (let i = 0; i < 30 && !events.includes('mockup-test-card'); i++) {
    await new Promise((r) => setTimeout(r, 200));
    events = (await request({ pathname: `/events?workspace=${workspaceId}`, headers: { Accept: 'text/event-stream' } })).body;
  }
  assert.match(events, /event: add\ndata: .*mockup-test-card/);

  const page = await request({ pathname: '/' });
  assert.equal(page.status, 200);
  assert.match(page.body, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.equal(page.headers['x-frame-options'], 'DENY');

  const content = '### Test Card (mockup-test-card.html)  [👍]\nLove it';
  const r = await request({ method: 'POST', pathname: `/workspace/${workspaceId}/feedback`,
    headers: { ...json, Origin: `http://localhost:${PORT}` }, body: { content } });
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).round, 1);
  assert.equal(fs.readFileSync(path.join(MOCKUP_DIR, 'feedback-round-1.md'), 'utf8'), content);
  assert.ok(!fs.existsSync(path.join(MOCKUP_DIR, 'feedback.md')));
});

test('register restarts a server whose code differs and keeps registrations', async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'de-copy-'));
  fs.cpSync(path.join(REPO, 'bin'), path.join(copy, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO, 'assets'), path.join(copy, 'assets'), { recursive: true });
  const port = PORT + 1;
  const reg = (dir) => new Promise((resolve) => execFile(path.join(copy, 'bin', 'register'),
    ['--project', REPO, '--dir', dir, '--port', String(port)], { env },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout: stdout.trim(), stderr })));
  const health = async () => JSON.parse((await request({ port, pathname: '/health' })).body);
  const other = `${MOCKUP_DIR}-other`;
  fs.mkdirSync(other, { recursive: true });
  let pid;
  try {
    assert.equal((await reg(other)).code, 0);
    const before = await health();
    fs.appendFileSync(path.join(copy, 'assets', 'harness-template.html'), '\n<!-- changed -->\n');
    assert.equal((await reg(MOCKUP_DIR)).code, 0);
    const afterRestart = await health();
    pid = afterRestart.pid;
    assert.notEqual(afterRestart.pid, before.pid);
    assert.notEqual(afterRestart.hash, before.hash);
    assert.deepEqual(afterRestart.workspaces.map((w) => w.id).sort(),
      [path.basename(MOCKUP_DIR), path.basename(other)].sort());
  } finally {
    try { process.kill(pid || (await health()).pid, 'SIGTERM'); } catch {}
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  }
});
