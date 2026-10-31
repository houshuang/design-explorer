const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

test(
  "one case is shown in every design, compares against another case and tags the notes",
  { skip: !process.env.DE_PLAYWRIGHT, timeout: 60000 },
  async (t) => {
    const { chromium } = require(process.env.DE_PLAYWRIGHT);
    const dir = fs.mkdtempSync("/tmp/claude/design-explorer/cases-test-");
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "de-cases-state-"));
    const port = Number(process.env.DE_BROWSER_PORT || 10084);
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(
      process.execPath,
      [path.join(__dirname, "../assets/server.js"), "--port", String(port), "--state-dir", state, "--no-open"],
      { stdio: "ignore" },
    );
    let browser;
    t.after(async () => {
      await browser?.close();
      server.kill("SIGTERM");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    });
    async function api(endpoint, body) {
      const res = await fetch(
        base + endpoint,
        body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {},
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
    fs.mkdirSync(path.join(dir, "shared"));
    fs.writeFileSync(
      path.join(dir, "shared/people.json"),
      JSON.stringify({ light: { name: "Bergen", works: 3 }, heavy: { name: "Henrik Ibsen", works: 41 } }),
    );
    fs.writeFileSync(
      path.join(dir, "exploration.json"),
      JSON.stringify({ data: "shared/people.json", cases: { light: "Bergen · 3", heavy: "Henrik Ibsen · 41" } }),
    );
    const reads = (label) =>
      JSON.stringify({
        label,
        html: `<h1 data-region="title"></h1><script>document.querySelector('h1').textContent = mockupCase.name + ' ' + mockupCase.works</script>`,
      });
    fs.writeFileSync(path.join(dir, "mockup-a.json"), reads("List"));
    fs.writeFileSync(path.join(dir, "mockup-b.json"), reads("Grid"));
    fs.writeFileSync(
      path.join(dir, "mockup-c.html"),
      '<section class="mockup-section" data-label="Static"><h1>Fixed</h1></section>',
    );
    const ws = await api("/workspace/register", { projectPath: dir, mockupDir: dir });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route(/https:\/\//, (route) => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/?workspace=${ws.id}`);
    const title = (id, selector = "iframe:not(.comparison-frame)") =>
      page.frameLocator(`.slide[data-id="${ws.id}:${id}"] ${selector}`).locator("h1");

    await page.locator("#counter").filter({ hasText: "List" }).waitFor();
    await title("mockup-a").filter({ hasText: "Bergen 3" }).waitFor();
    assert.deepEqual(await page.locator("#cases button").allTextContents(), ["Bergen · 3", "Henrik Ibsen · 41"]);

    await page.keyboard.press("]");
    await title("mockup-a").filter({ hasText: "Henrik Ibsen 41" }).waitFor();
    await page.keyboard.press("ArrowRight");
    await page.locator("#counter").filter({ hasText: "Grid" }).waitFor();
    await title("mockup-b").filter({ hasText: "Henrik Ibsen 41" }).waitFor();
    assert.equal(await page.locator('#cases button[aria-pressed="true"]').textContent(), "Henrik Ibsen · 41");

    // The same design in another case is a comparison reference.
    await page.waitForFunction(() => [...document.querySelector("#reference").options].some((o) => o.value === "case:light"));
    await page.locator("#reference").selectOption("case:light");
    await page.waitForFunction(() => !document.querySelector("#side-btn").disabled);
    await page.locator("#side-btn").click();
    await title("mockup-b", ".comparison-frame").filter({ hasText: "Bergen 3" }).waitFor();
    assert.equal(await title("mockup-b").textContent(), "Henrik Ibsen 41");
    await page.locator("#side-btn").click();

    await page.locator("#notes").focus();
    assert.equal(await page.locator("#notes").inputValue(), "[Henrik Ibsen · 41]\n");
    await page.keyboard.type("Labels collide");
    await page.keyboard.press("Escape");
    await page.locator("#cases button").filter({ hasText: "Bergen" }).click();
    await title("mockup-b").filter({ hasText: "Bergen 3" }).waitFor();
    await page.locator("#notes").focus();
    await page.keyboard.press("Escape");
    await page.locator("#btn-up").click();

    await page.keyboard.press("ArrowRight");
    await page.locator("#counter").filter({ hasText: "Static" }).waitFor();
    assert.equal(await page.locator("#cases").isHidden(), true);

    await page.locator("#submit-btn").click();
    await page.locator("#submit-btn").filter({ hasText: "Submitted" }).waitFor();
    const feedback = fs.readFileSync(path.join(dir, "feedback-round-1.md"), "utf8");
    assert.match(feedback, /Cases: Bergen · 3 \(light\), Henrik Ibsen · 41 \(heavy\)/);
    assert.match(feedback, /### #2 Grid .*\[👍\]\n\[Henrik Ibsen · 41\]\nLabels collide\n*(###|$)/);
    assert.doesNotMatch(feedback, /\[Bergen · 3\]\n/);
    assert.deepEqual(errors, []);
  },
);
