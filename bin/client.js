#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const command = path.basename(process.argv[1]);
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || process.argv[i + 1] === undefined)
    throw new Error("Expected --option value");
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const port = Number(options.port || 10000);
const root = "/tmp/claude/design-explorer";
const url = `http://127.0.0.1:${port}`;

async function request(endpoint, body) {
  const response = await fetch(url + endpoint, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function context(dir) {
  const lineup = await request(`/lineup?dir=${encodeURIComponent(dir)}`);
  const workspaces = await request("/workspaces");
  const real = fs.realpathSync(dir);
  const ws = workspaces.find((ws) => ws.mockupDir === real);
  if (!ws) throw new Error("Directory is not registered");
  const result = await request(`/workspace/${encodeURIComponent(ws.id)}/context?compact=1`);
  return { ...result, lineup: lineup.text };
}

function findChrome() {
  // Playwright's headless shell starts much faster than a full Chrome; prefer its newest build.
  const cache = path.join(require("os").homedir(), "Library/Caches/ms-playwright");
  const shells = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-"))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .flatMap((d) => ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]
          .map((arch) => path.join(cache, d, arch, "chrome-headless-shell")))
    : [];
  const candidates = [
    process.env.CHROME,
    ...shells,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map(
      (name) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim(),
    ),
  ];
  const found = candidates.find((file) => file && fs.existsSync(file));
  if (!found) throw new Error("No Chrome or Chromium found; set CHROME=/path/to/chrome");
  return found;
}

// One headless Chrome driven over the DevTools protocol: a shared cache, exact full-page
// captures and real exception events. Node 22+ provides the WebSocket client.
async function openChrome(chrome) {
  const profile = fs.mkdtempSync(path.join(require("os").tmpdir(), "de-shot-"));
  const child = require("child_process").spawn(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(portFile)) { child.kill(); throw new Error("Chrome did not start"); }
  const [debugPort, browserPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const socket = new WebSocket(`ws://127.0.0.1:${debugPort}${browserPath}`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("No DevTools connection")); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    } else for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    socket.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    send,
    listeners,
    async close() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      send("Browser.close").catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      socket.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function capture(browser, page, width, height, file) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  let loaded;
  const done = new Promise((resolve) => (loaded = resolve));
  const listener = (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") {
      const d = message.params.exceptionDetails;
      errors.push(d.exception?.description?.split("\n")[0] || d.text);
    }
    if (message.method === "Page.loadEventFired") loaded();
  };
  browser.listeners.add(listener);
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height: height || 200, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: page });
    await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
    await new Promise((r) => setTimeout(r, 800)); // fonts, icons and late layout
    const { result } = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: "({h: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)), o: document.documentElement.scrollWidth - document.documentElement.clientWidth})",
    });
    const fullHeight = height || Math.min(result.value.h, 10000);
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !height,
      clip: { x: 0, y: 0, width, height: fullHeight, scale: 1 },
    });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return { height: fullHeight, overflow: result.value.o, errors };
  } finally {
    browser.listeners.delete(listener);
    await browser.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// One screenshot per design × case × width, rendered the way the reviewer renders it.
async function shot() {
  if (!options.dir) throw new Error("shot --dir DIR [--design N|slug|all] [--case KEY|all] [--width 1280,390] [--out DIR]");
  const dir = fs.realpathSync(options.dir);
  const brief = (await context(dir)).brief;
  const { rounds } = await request(`/lineup?dir=${encodeURIComponent(dir)}`);
  const designs = !options.design || options.design === "all"
    ? (rounds[0]?.mockups || [])
    : options.design.split(",").map((d) => rounds.flatMap((r) => r.mockups).find((m) => String(m.number) === d.replace(/^#/, "") || m.file.replace(/\.(html|json)$/, "") === d) || { number: d, label: d, file: d });
  if (!designs.length) throw new Error("No designs in the latest round");
  const cases = brief.cases ? Object.keys(brief.cases) : [];
  const wanted = !options.case || options.case === "all" ? cases : options.case.split(",");
  for (const key of wanted) if (!cases.includes(key)) throw new Error(`No case ${key}; cases: ${cases.join(", ") || "none"}`);
  const widths = (options.width || String(brief.viewport?.width || 1280)).split(",").map(Number);
  if (widths.some((w) => !Number.isInteger(w) || w < 200 || w > 4000)) throw new Error("Widths must be whole pixels between 200 and 4000");
  const out = options.out ? path.resolve(options.out) : path.join(dir, ".shots");
  fs.mkdirSync(out, { recursive: true });
  const browser = await openChrome(findChrome());
  const jobs = [];
  for (const design of designs) {
    const id = String(design.file).replace(/\.(html|json)$/, "");
    for (const key of wanted.length ? wanted : [null])
      for (const width of widths) jobs.push({ design, id, key, width });
  }
  const lines = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const { design, id, key, width } = jobs[index];
      const query = new URLSearchParams({ dir, design: id, ...(key ? { case: key } : {}) });
      const page = `${url}/preview?${query}`;
      const file = path.join(out, `${design.number}-${id.replace(/^mockup-/, "")}${key ? "-" + key : ""}-${width}.png`);
      fs.rmSync(file, { force: true });
      let notes;
      try {
        const probe = await capture(browser, page, width, brief.viewport?.height, file);
        notes = `${probe.height}px tall; ` + ([probe.overflow > 1 ? `overflows by ${probe.overflow}px` : "", probe.errors.length ? `errors: ${probe.errors.join(" | ")}` : ""].filter(Boolean).join("; ") || "ok");
      } catch (error) {
        notes = `failed: ${error.message}`;
      }
      lines[index] = `#${design.number} ${design.label}${key ? ` · ${brief.cases[key]}` : ""} · ${width}px → ${fs.existsSync(file) ? file : "(no screenshot)"}  ${notes}`;
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  } finally {
    await browser.close();
  }
  // Exit once the lines are flushed: the DevTools socket and fetch keep-alive would hold Node open.
  process.stdout.write(lines.join("\n") + "\n", () => process.exit(lines.some((l) => / failed: /.test(l)) ? 1 : 0));
}

async function main() {
  if (command === "begin") {
    if (!options.project || !options.question)
      throw new Error(
        "begin --project PATH --topic SLUG --question TEXT [--state TEXT] [--dir DIR]",
      );
    const slug = `${path.basename(options.project)}-${options.topic || "design"}`.replace(
      /[^a-zA-Z0-9-]/g,
      "-",
    );
    const dir =
      options.dir ||
      path.join(root, "mockups", `${slug}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
    fs.mkdirSync(dir, { recursive: true });
    const args = ["--project", options.project, "--dir", dir, "--port", String(port)];
    if (options.branch) args.push("--branch", options.branch);
    if (options["state-dir"]) args.push("--state-dir", options["state-dir"]);
    const register = spawnSync(path.join(__dirname, "register"), args, { encoding: "utf8" });
    if (register.status !== 0) throw new Error(register.stderr || register.stdout);
    const round = await request("/round", {
      mockupDir: dir,
      label: options.label || options.topic || "Explore",
      question: options.question,
      ...(options.state ? { state: options.state } : {}),
    });
    console.log(
      `Directory: ${dir}\nWorkspace: ${register.stdout.trim()}\nRound ${round.round} · ${round.label}\nFeedback file: ${round.feedback}\nReview: http://localhost:${port}/?workspace=${encodeURIComponent(register.stdout.trim())}`,
    );
    console.log(JSON.stringify((await context(dir)).brief));
  } else if (command === "context") {
    if (!options.dir) throw new Error("context --dir DIR");
    const result = await context(options.dir);
    console.log(`Brief: ${JSON.stringify(result.brief)}\n${result.lineup || "No mockups yet."}`);
  } else if (command === "feedback") {
    if (!options.dir || !/^[1-9][0-9]*$/.test(options.round || ""))
      throw new Error("feedback --dir DIR --round N [--wait-seconds 60] [--after HASH]");
    const seconds = Number(options["wait-seconds"] || 0);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
      throw new Error("Wait must be between 0 and 60 seconds");
    const real = fs.realpathSync(options.dir);
    if (!real.startsWith(fs.realpathSync(root) + path.sep))
      throw new Error("Directory is outside the mockup root");
    const file = path.join(real, `feedback-round-${options.round}.md`);
    let finished = false;
    let timer;
    let watcher;
    await new Promise((resolve) => {
      function finish(text) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        watcher?.close();
        console.log(text);
        resolve();
      }
      function check() {
        if (!fs.existsSync(file)) return;
        const content = fs.readFileSync(file, "utf8");
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        if (content && hash !== options.after) finish(`Submission: ${hash}\n${content}`);
      }
      watcher = fs.watch(real, check);
      timer = setTimeout(
        () => finish("No new submitted feedback. Chat feedback can also end this round."),
        seconds * 1000,
      );
      check();
    });
  } else if (command === "shot") {
    await shot();
  } else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`design-explorer: ${error.message}`);
  process.exitCode = 1;
});
