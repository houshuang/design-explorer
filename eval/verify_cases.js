// Render every design of each evaluation run in every case, through the real reviewer.
// Usage: DE_PLAYWRIGHT=/path/to/playwright node eval/verify_cases.js EVIDENCE_DIR [SERVER_REPO]
// Writes EVIDENCE_DIR/verify.json and screenshots under EVIDENCE_DIR/screens/.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require(process.env.DE_PLAYWRIGHT || "playwright");

const evidence = path.resolve(process.argv[2]);
const serverRepo = path.resolve(process.argv[3] || path.join(__dirname, ".."));
const port = 10099;
const base = `http://127.0.0.1:${port}`;
// Words that name another entity in a hand-written in-preview switch (baseline runs).
const OTHER_ENTITIES = /Ibsen|Opplysning|Bergen/;

async function api(endpoint, body) {
  const res = await fetch(base + endpoint, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(`${endpoint}: ${res.status} ${await res.text()}`);
  return res.json();
}

function staticReport(dir) {
  const brief = JSON.parse(fs.readFileSync(path.join(dir, "exploration.json"), "utf8"));
  const files = fs.readdirSync(dir).filter((f) => /^mockup-.*\.(html|json)$/.test(f)).sort();
  const shared = brief.base && fs.existsSync(path.join(dir, brief.base)) ? fs.readFileSync(path.join(dir, brief.base), "utf8") : "";
  return {
    cases: brief.cases || null,
    baseReadsCase: shared.includes("mockupCase"),
    designs: files.map((file) => {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      let script = source;
      try { const v = JSON.parse(source); script = [v.script, v.html, ...Object.values(v.slots || {})].filter(Boolean).join("\n"); } catch {}
      return {
        file,
        bytes: source.length,
        readsCase: source.includes("mockupCase"),
        handSwitch: /review-switch|Object\.(keys|entries)\((window\.)?mockupData\)|mockupData\[(cur|key|k|current|sel|active)/.test(script),
      };
    }),
  };
}

async function main() {
  const runs = fs.readdirSync(evidence).filter((f) => /\.json$/.test(f) && !["jobs.json", "verify.json"].includes(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(evidence, f), "utf8"))).filter((r) => r.run_dir);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "de-verify-"));
  const server = spawn(process.execPath, [path.join(serverRepo, "assets/server.js"), "--port", String(port), "--state-dir", state, "--no-open"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await api("/health"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const browser = await chromium.launch();
  const shots = path.join(evidence, "screens");
  fs.mkdirSync(shots, { recursive: true });
  const report = {};
  try {
    for (const run of runs) {
      const name = run.job.name;
      const dir = run.run_dir;
      if (!fs.existsSync(path.join(dir, "exploration.json"))) { report[name] = { error: "no exploration" }; continue; }
      const result = { ...staticReport(dir), renders: [] };
      report[name] = result;
      const ws = await api("/workspace/register", { projectPath: dir, mockupDir: dir });
      const lineup = await api(`/lineup?dir=${encodeURIComponent(dir)}`);
      result.lineup = lineup.text;
      const numbers = JSON.parse(fs.readFileSync(path.join(dir, "numbers.json"), "utf8")).ids;
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width: Math.max(width + 80, 900), height: 1000 } });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`${base}/?workspace=${ws.id}`);
        await page.locator("#viewport").selectOption(String(width));
        await page.waitForTimeout(1500);
        const ids = (await page.locator(".slide").evaluateAll((s) => s.map((x) => x.dataset.id))).filter((id) => id.startsWith(ws.id + ":")).sort((a, b) => (numbers[a.split(":")[1]] || 0) - (numbers[b.split(":")[1]] || 0));
        for (let n = 0; n < ids.length; n++) {
          if (n) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(400); }
          const pills = await page.locator("#cases button").allTextContents();
          const variants = pills.length ? pills : [null];
          for (const pill of variants) {
            errors.length = 0;
            if (pill) { await page.locator("#cases button").filter({ hasText: pill }).first().click(); await page.waitForTimeout(1200); }
            const handle = await page.locator(`.slide[data-id="${ids[n]}"] iframe:not(.comparison-frame)`).elementHandle();
            const frame = await handle.contentFrame();
            const measure = () => frame.evaluate(() => ({
              text: document.body.innerText.replace(/\s+/g, " ").trim(),
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              links: document.querySelectorAll('a[href*="/planer/"]').length,
            }));
            const shown = await measure();
            const entry = { id: ids[n].split(":")[1], width, case: pill, chars: shown.text.length, overflow: shown.overflow, planLinks: shown.links, head: shown.text.slice(0, 160), errors: [...errors] };
            entry.hash = require("crypto").createHash("sha1").update(shown.text).digest("hex").slice(0, 10);
            const file = `${name}--${entry.id}--${width}--${(pill || "default").replace(/[^a-zA-Z0-9]+/g, "_")}.png`;
            await handle.screenshot({ path: path.join(shots, file) }).catch(() => {});
            entry.shot = file;
            // Baseline designs have no reviewer cases; try a switch inside the preview.
            if (!pill && width === 1280) {
              const inside = frame.locator("button, [role=tab], a").filter({ hasText: OTHER_ENTITIES });
              entry.inPreviewSwitch = await inside.count();
              if (entry.inPreviewSwitch) {
                const texts = new Set([entry.hash]);
                for (let i = 0; i < Math.min(entry.inPreviewSwitch, 4); i++) {
                  errors.length = 0;
                  await inside.nth(i).click({ timeout: 2000 }).catch(() => {});
                  await page.waitForTimeout(500);
                  const after = await measure().catch(() => null);
                  if (after) texts.add(require("crypto").createHash("sha1").update(after.text).digest("hex").slice(0, 10));
                  entry.errors.push(...errors);
                }
                entry.inPreviewStates = texts.size;
              }
            }
            result.renders.push(entry);
          }
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    fs.rmSync(state, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(evidence, "verify.json"), JSON.stringify(report, null, 2));
  for (const [name, r] of Object.entries(report)) {
    if (r.error) { console.log(name, r.error); continue; }
    const errs = r.renders.filter((x) => x.errors.length).length;
    const distinct = {};
    for (const x of r.renders.filter((x) => x.width === 1280)) (distinct[x.id] ||= new Set()).add(x.hash);
    console.log([
      name,
      `cases=${r.cases ? Object.keys(r.cases).join("/") : "none"}`,
      `designs=${r.designs.length}`,
      `readCase=${r.designs.filter((d) => d.readsCase).length}${r.baseReadsCase ? "+base" : ""}`,
      `handSwitch=${r.designs.filter((d) => d.handSwitch).length}`,
      `states/design=${Object.values(distinct).map((s) => s.size).join(",")}`,
      `inPreview=${r.renders.filter((x) => x.inPreviewStates).map((x) => x.inPreviewStates).join(",") || "-"}`,
      `errRenders=${errs}`,
      `overflow390=${r.renders.filter((x) => x.width === 390 && x.overflow > 1).length}`,
      `bytes=${r.designs.reduce((a, d) => a + d.bytes, 0)}`,
    ].join("  "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
