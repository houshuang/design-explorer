#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { compose } = require("../assets/workspace");
const { chromium } = require(process.env.DE_PLAYWRIGHT || "playwright");

async function main() {
  const [root, out] = process.argv.slice(2);
  if (!root || !out) throw new Error("capture.js MOCKUP_ROOT OUTPUT_DIRECTORY");
  fs.mkdirSync(out, { recursive: true });
  const harness = fs.readFileSync(path.join(__dirname, "../assets/harness-template.html"), "utf8");
  const start = harness.indexOf("    function buildIframeSrc(");
  const end = harness.indexOf("    // ── Carousel navigation", start);
  const builder = new Function(harness.slice(start, end) + "\nreturn buildIframeSrc;")();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const cases = new Set(process.argv.slice(4));
  const manifest = path.join(out, "manifest.json");
  const results =
    cases.size && fs.existsSync(manifest)
      ? JSON.parse(fs.readFileSync(manifest, "utf8")).filter((x) => !cases.has(x.round))
      : [];
  try {
    for (const dir of fs
      .readdirSync(root)
      .filter((name) => fs.statSync(path.join(root, name)).isDirectory())
      .sort()) {
      const files = fs
        .readdirSync(path.join(root, dir))
        .filter((file) => /^mockup-.*\.(html|json)$/.test(file))
        .sort();
      const round = dir.match(/-(nrk|skard|hirsch)-/)?.[1];
      if (!round || (cases.size && !cases.has(round))) continue;
      for (const file of files) {
        const id = crypto
          .createHash("sha256")
          .update(dir + "/" + file)
          .digest("hex")
          .slice(0, 10);
        const { html } = compose(path.join(root, dir), file);
        const body = html.replace(/^<section\b[^>]*>/, "").replace(/<\/section>\s*$/, "");
        const doc = builder(body, id);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(doc, { waitUntil: "load", timeout: 30000 });
        await page.evaluate(() =>
          Promise.all([
            document.fonts.ready,
            ...[...document.images].map((img) =>
              img.complete
                ? Promise.resolve()
                : new Promise((resolve) => {
                    img.onload = resolve;
                    img.onerror = resolve;
                  }),
            ),
          ]),
        );
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 800 });
          await page.waitForTimeout(200);
          const metrics = await page.evaluate(() => ({
            width: innerWidth,
            height: document.documentElement.scrollHeight,
            overflow: document.documentElement.scrollWidth > innerWidth,
            brokenImages: [...document.images].filter((img) => !img.naturalWidth).length,
            text: document.body.innerText,
            details: [...document.querySelectorAll("details")].map((el) => ({
              open: el.open,
              text: el.innerText,
            })),
            dialogs: [...document.querySelectorAll("dialog")].map((el) => ({ open: el.open })),
          }));
          const screenshot = path.join(out, `${id}-${width}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          results.push({
            id,
            round,
            dir,
            file,
            width,
            screenshot,
            errors: [...errors],
            ...metrics,
          });
          console.log(
            `captured ${dir}/${file} at ${width}: overflow=${metrics.overflow}, errors=${errors.length}`,
          );
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(results, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
