const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

test(
  "reviewer keeps workspace identity, autosaves by revision, compares and reports failed submission",
  { skip: !process.env.DE_PLAYWRIGHT, timeout: 60000 },
  async (t) => {
    const { chromium } = require(process.env.DE_PLAYWRIGHT);
    const root = fs.mkdtempSync("/tmp/claude/design-explorer/browser-test-");
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "de-browser-state-"));
    const port = Number(process.env.DE_BROWSER_PORT || 10083);
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(
      process.execPath,
      [
        path.join(__dirname, "../assets/server.js"),
        "--port",
        String(port),
        "--state-dir",
        state,
        "--no-open",
      ],
      { stdio: "ignore" },
    );
    let browser;
    t.after(async () => {
      await browser?.close();
      server.kill("SIGTERM");
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true });
    async function api(endpoint, body) {
      const res = await fetch(
        base + endpoint,
        body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {},
      );
      assert.equal(res.status, 200, await res.clone().text());
      return res.json();
    }
    for (let i = 0; i < 50; i++) {
      try {
        await api("/health");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const dirs = ["alpha", "beta"].map((name) => path.join(root, name));
    const html = (text) =>
      `<section class="mockup-section" data-label="${text}"><style>h1{font:36px Georgia}</style><h1 data-region="title">${text}</h1><button onclick="document.querySelector('dialog').showModal()">Working control</button><dialog><form method="dialog"><button>Lukk</button></form></dialog></section>`;
    for (const dir of dirs) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "mockup-same.html"), html(path.basename(dir)));
    }
    fs.writeFileSync(
      path.join(dirs[0], "exploration.json"),
      JSON.stringify({ viewport: { width: 1280, height: 500 } }),
    );
    const first = await api("/workspace/register", { projectPath: root, mockupDir: dirs[0] });
    const context = await browser.newContext();
    await context.route(/https:\/\//, (route) => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/?workspace=${first.id}`);
    await page.locator("#counter").filter({ hasText: "alpha" }).waitFor();
    const initialPreview = page.frameLocator(`.slide[data-id="${first.id}:mockup-same"] iframe`);
    await initialPreview.getByRole("button", { name: "Working control" }).click();
    await initialPreview.locator("dialog").waitFor({ state: "visible" });
    await initialPreview.getByRole("button", { name: "Lukk" }).click();
    await initialPreview.locator("dialog").waitFor({ state: "hidden" });
    await page.locator("#notes").fill("Keep this title");
    await page.locator("#btn-up").click();
    await page.waitForFunction(() => document.querySelector("#notes").value === "Keep this title");
    await new Promise((r) => setTimeout(r, 400));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#notes").value === "Keep this title");
    assert.equal(await page.locator("#notes").inputValue(), "Keep this title");
    const second = await api("/workspace/register", { projectPath: root, mockupDir: dirs[1] });
    await page.waitForFunction(() => document.querySelectorAll(".ws-tab").length === 2);
    assert.match(await page.locator("#counter").textContent(), /alpha/);
    assert.equal(await page.locator("iframe").count(), 2);
    await page.locator(".ws-tab").filter({ hasText: second.id }).click();
    assert.match(await page.locator("#counter").textContent(), /beta/);
    assert.ok(
      (await page
        .locator(`.slide[data-id="${second.id}:mockup-same"] iframe`)
        .evaluate((frame) => frame.getBoundingClientRect().height)) >= 600,
    );
    assert.equal(await page.locator("#notes").inputValue(), "");
    await page.locator(".ws-tab").filter({ hasText: first.id }).click();
    await page.locator("#pin-btn").click();
    await page.locator("#notes").fill("Keep this title before revision");
    await api("/round", { mockupDir: dirs[0], label: "Revision" });
    fs.writeFileSync(path.join(dirs[0], "mockup-same.html"), html("alpha revised"));
    await api(`/lineup?dir=${encodeURIComponent(dirs[0])}`);
    await page.locator("#counter").filter({ hasText: "r2" }).waitFor();
    assert.equal(await page.locator("#notes").inputValue(), "");
    await page.waitForFunction(() => document.querySelector("#reference").options.length >= 2);
    await page.locator("#reference").selectOption("1");
    await page.waitForFunction(() => !document.querySelector("#compare-btn").disabled);
    await page.locator("#compare-btn").click();
    assert.equal(await page.locator("#notes").isDisabled(), true);
    const reference = page
      .frames()
      .find(
        (frame) =>
          frame !== page.mainFrame() && frame.url() === "about:srcdoc" && frame.name() === "",
      );
    assert.ok(reference);
    await page.locator("#compare-btn").click();
    await page.locator("#viewport").selectOption("390");
    await page.locator("#side-btn").click();
    const widths = await page
      .locator(`.slide[data-id="${first.id}:mockup-same"] iframe`)
      .evaluateAll((frames) =>
        frames.map((frame) => Math.round(frame.getBoundingClientRect().width)),
      );
    assert.deepEqual(widths, [390, 390]);
    await page.locator("#side-btn").click();
    await page.locator("#point-btn").click();
    const preview = page.frameLocator(
      `.slide[data-id="${first.id}:mockup-same"] iframe:not(.comparison-frame)`,
    );
    await preview.locator("h1").click();
    await page.waitForFunction(() =>
      document.querySelector("#notes").value.includes("title: alpha revised"),
    );
    await page.locator("#notes").fill("Revised title is better");
    await page.locator("#btn-neutral").click();
    await page.route("**/feedback", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "disk unavailable" }),
      }),
    );
    await page.locator("#submit-btn").click();
    await page.locator("#review-status").filter({ hasText: "not submitted" }).waitFor();
    assert.ok(!(await page.locator("#submit-btn").textContent()).includes("Submitted"));
    await page.unroute("**/feedback");
    await page.locator("#submit-btn").click();
    await page.locator("#submit-btn").filter({ hasText: "Submitted" }).waitFor();
    const feedback = fs.readFileSync(path.join(dirs[0], "feedback-round-2.md"), "utf8");
    assert.match(feedback, /revision 2/);
    assert.match(feedback, /reviewed, no preference/);
    const drafts = JSON.parse(fs.readFileSync(path.join(dirs[0], "review-drafts.json"), "utf8"));
    await page.waitForFunction(
      (key) => drafts.get(key)?.notes === "Keep this title before revision",
      `${first.id}:mockup-same:r1`,
    );
    const savedAfterRevision = JSON.parse(
      fs.readFileSync(path.join(dirs[0], "review-drafts.json"), "utf8"),
    );
    assert.equal(savedAfterRevision["mockup-same:r1"].notes, "Keep this title before revision");
    assert.equal(drafts["mockup-same:r2"].notes, "Revised title is better");
    fs.mkdirSync(path.join(dirs[1], "archived"));
    fs.renameSync(
      path.join(dirs[1], "mockup-same.html"),
      path.join(dirs[1], "archived/mockup-same.html"),
    );
    fs.writeFileSync(path.join(dirs[1], "mockup-next.html"), html("beta next"));
    await api(`/lineup?dir=${encodeURIComponent(dirs[1])}`);
    await page.locator(".ws-tab").filter({ hasText: second.id }).click();
    await page.waitForFunction(() =>
      [...document.querySelector("#reference").options].some((option) =>
        option.text.startsWith("Archived"),
      ),
    );
    await page.locator("#reference").selectOption("archived:mockup-same:1");
    await page.waitForFunction(() => !document.querySelector("#compare-btn").disabled);
    await page.locator("#compare-btn").click();
    const archived = page.frameLocator(
      `.slide[data-id="${second.id}:mockup-next"] .comparison-frame`,
    );
    assert.equal(await archived.locator("h1").textContent(), "beta");
    await page.locator("#compare-btn").click();
    await page.evaluate(() => {
      recording = true;
      recordingTarget = { ...currentMockup() };
      preRecordingNotes = "";
      transcript = { final: "Voice belongs to beta next", nonfinal: "" };
      stopRecording();
    });
    await page.locator(".ws-tab").filter({ hasText: first.id }).click();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("#notes").inputValue(), "Revised title is better");
    const voiceDrafts = JSON.parse(
      fs.readFileSync(path.join(dirs[1], "review-drafts.json"), "utf8"),
    );
    assert.equal(voiceDrafts["mockup-next:r1"].notes, "Voice belongs to beta next");
    const longDir = path.join(root, "coverage-ui-1791183933827-dc88bb");
    fs.mkdirSync(longDir);
    fs.writeFileSync(path.join(longDir, "mockup-same.html"), html("gamma"));
    const third = await api("/workspace/register", { projectPath: root, mockupDir: longDir });
    const thirdTab = page.locator(".ws-tab").filter({ hasText: "coverage-ui" });
    await thirdTab.waitFor();
    assert.match(await thirdTab.locator(".ws-name").textContent(), /coverage-ui$/);
    await thirdTab.hover();
    await thirdTab.locator(".ws-close").click();
    await page.waitForFunction(() => document.querySelectorAll(".ws-tab").length === 2);
    assert.ok(!(await api("/workspaces")).some((ws) => ws.id === third.id));
    assert.ok(fs.existsSync(path.join(longDir, "mockup-same.html")));
    await page.goto(`${base}/?workspace=${third.id}`);
    await page.locator("#counter").filter({ hasText: /alpha|beta/ }).waitFor();
    await api("/workspace/register", { projectPath: root, mockupDir: longDir });
    await page.locator("#counter").filter({ hasText: "gamma" }).waitFor();
    assert.deepEqual(errors, []);
  },
);
