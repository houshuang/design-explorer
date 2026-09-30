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
  } else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`design-explorer: ${error.message}`);
  process.exitCode = 1;
});
