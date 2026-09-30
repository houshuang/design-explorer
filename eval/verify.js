#!/usr/bin/env node
// Exercise generated report-entry variants inside the real sandboxed reviewer.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const { chromium } = require(process.env.DE_PLAYWRIGHT || "playwright");

async function main() {
  const [out, ...directories] = process.argv.slice(2);
  if (!out || !directories.length) throw new Error("verify.js OUTPUT_DIRECTORY WORKSPACE...");
  fs.mkdirSync(out, { recursive: true });
  const state = path.join(out, "server-state");
  const port = process.env.DE_VERIFY_PORT || "10084";
  const base = `http://127.0.0.1:${port}`;
  let pid;
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    for (const directory of directories) {
      const registration = spawnSync(
        path.join(__dirname, "../bin/register"),
        ["--project", __dirname, "--dir", directory, "--port", port, "--state-dir", state],
        { encoding: "utf8" },
      );
      assert.equal(registration.status, 0, registration.stderr);
      pid = (await (await fetch(base + "/health")).json()).pid;
      const workspace = registration.stdout.trim();
      const data = await (await fetch(`${base}/workspace/${workspace}/context?compact=1`)).json();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}/?workspace=${workspace}`);
      await page.addStyleTag({ content: "#carousel,.slide-inner{transition:none!important}" });
      await page.locator("#counter").filter({ hasText: "r1" }).waitFor();
      for (const design of data.mockups) {
        await page.evaluate((id) => goTo(visible().findIndex((m) => m.id === id)), design.id);
        await page.waitForFunction(
          () =>
            !document
              .querySelector("#carousel")
              .getAnimations()
              .some((animation) => animation.playState === "running"),
        );
        const locator = page.locator(`.slide[data-id="${workspace}:${design.id}"] iframe`);
        const preview = locator.contentFrame();
        await preview.locator("#report-dialog").waitFor({ state: "attached" });
        await preview.locator("body").evaluate(
          () =>
            new Promise((resolve) => {
              if (document.readyState === "loading")
                document.addEventListener("DOMContentLoaded", resolve, { once: true });
              else resolve();
            }),
        );
        for (const width of ["1280", "390"]) {
          await page.locator("#viewport").selectOption(width);
          await page.waitForTimeout(100);
          await page
            .locator(`.slide[data-id="${workspace}:${design.id}"]`)
            .evaluate((slide) => (slide.scrollTop = 0));
          await preview.locator("html").evaluate(() => window.scrollTo(0, 0));
          await preview.locator("h1").waitFor();
          assert.equal(
            await preview.locator("#report-dialog").evaluate((dialog) => dialog.open),
            false,
          );
          const button = preview.locator("[data-report]").first();
          if (!(await button.isVisible())) {
            const trigger = preview
              .locator('summary, [aria-haspopup="menu"], [aria-haspopup="true"]')
              .first();
            await trigger.click();
            await button.waitFor({ state: "visible" });
          }
          await button.click();
          await preview.locator("#report-dialog").waitFor({ state: "visible" });
          assert.equal(
            await preview.locator("#report-dialog").evaluate((dialog) => dialog.open),
            true,
          );
          await locator.evaluate((iframe) =>
            iframe.scrollIntoView({ block: "center", inline: "nearest" }),
          );
          await preview.getByRole("button", { name: "Lukk", exact: true }).click();
          assert.equal(
            await preview.locator("#report-dialog").evaluate((dialog) => dialog.open),
            false,
          );
          const text = await preview.locator("body").innerText();
          for (const fact of ["Hedda Gabler", "Henrik Ibsen", "1975", "2 t 4 min", "Kun i Norge"])
            assert.ok(text.includes(fact), fact);
          const overflow = await preview
            .locator("html")
            .evaluate((html) => html.scrollWidth > innerWidth);
          assert.equal(overflow, false);
          const screenshot = path.join(
            out,
            `${path.basename(directory)}-${design.id}-${width}.png`,
          );
          await locator.screenshot({ path: screenshot });
          results.push({
            directory,
            design: design.id,
            width: Number(width),
            dialogOpenClose: true,
            programmeFacts: true,
            overflow,
            errors: [...errors],
            screenshot,
          });
        }
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    fs.writeFileSync(path.join(out, "verification.json"), JSON.stringify(results, null, 2));
    console.log(
      `Verified ${results.length} design/viewport combinations in the sandboxed reviewer.`,
    );
  } finally {
    await browser?.close();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
