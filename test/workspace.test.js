const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  compose,
  snapshot,
  readHistory,
  revisionHTML,
  saveDraft,
  readDrafts,
} = require("../assets/workspace");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "de-compose-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "shared"));
  fs.writeFileSync(
    path.join(dir, "shared/page.html"),
    "<header>Approved header</header><!--slot:body--><p>Original body</p><!--/slot:body-->",
  );
  fs.writeFileSync(path.join(dir, "shared/style.css"), "body { color: navy }");
  fs.writeFileSync(
    path.join(dir, "shared/data.json"),
    JSON.stringify([{ name: "</script><script>bad()</script>" }]),
  );
  fs.writeFileSync(
    path.join(dir, "exploration.json"),
    JSON.stringify({
      base: "shared/page.html",
      styles: ["shared/style.css"],
      data: "shared/data.json",
    }),
  );
  return dir;
}

test("region variants preserve the shell and inject shared styles and safe fixture data before overrides", (t) => {
  const dir = fixture(t);
  fs.writeFileSync(
    path.join(dir, "mockup-layout.json"),
    JSON.stringify({
      label: 'A "quoted" layout',
      slots: { body: '<div class="grid">New grouping</div>' },
      css: ".grid{display:grid}",
      script: "console.log(mockupData)",
    }),
  );
  const { html } = compose(dir, "mockup-layout.json");
  assert.ok(html.includes("<header>Approved header</header>"));
  assert.ok(html.includes('<div class="grid">New grouping</div>'));
  assert.ok(!html.includes("Original body"));
  assert.ok(html.indexOf("color: navy") < html.indexOf(".grid{display:grid}"));
  assert.ok(html.includes("\\u003c/script>"));
  assert.ok(!html.includes("<script>bad()"));
  assert.ok(html.includes("A &quot;quoted&quot; layout"));
});

test("full HTML and JSON html escape hatches share assets without forcing a base layout", (t) => {
  const dir = fixture(t);
  for (const [file, content] of [
    ["mockup-full.html", '<section class="mockup-section"><h1>Independent layout</h1></section>'],
    [
      "mockup-full.json",
      JSON.stringify({ label: "Independent", html: "<h1>Independent layout</h1>" }),
    ],
  ]) {
    fs.writeFileSync(path.join(dir, file), content);
    const { html } = compose(dir, file);
    assert.ok(html.includes("Independent layout"));
    assert.ok(html.includes("color: navy"));
    assert.ok(!html.includes("Approved header"));
  }
});

test("legacy mockup-content retains shared resources when the reviewer extracts its body", (t) => {
  const dir = fixture(t);
  fs.writeFileSync(
    path.join(dir, "mockup-legacy.html"),
    '<section class="mockup-section"><div class="mockup-header">Old label</div><div class="mockup-content"><h1>Old body</h1></div></section>',
  );
  const { html } = compose(dir, "mockup-legacy.html");
  const body = html.split('<div class="mockup-content">')[1];
  assert.ok(body.includes("color: navy"));
  assert.ok(body.includes("window.mockupData="));
});

test("missing slots, duplicate slots, conflicting modes and escaping paths fail explicitly", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "mockup-error.json");
  fs.writeFileSync(file, JSON.stringify({ label: "Bad", slots: { missing: "new" } }));
  assert.throws(() => compose(dir, "mockup-error.json"), /exactly once/);
  fs.appendFileSync(path.join(dir, "shared/page.html"), "<!--slot:body--><!--/slot:body-->");
  fs.writeFileSync(file, JSON.stringify({ label: "Bad", slots: { body: "new" } }));
  assert.throws(() => compose(dir, "mockup-error.json"), /exactly once/);
  fs.writeFileSync(file, JSON.stringify({ label: "Bad", html: "new", slots: { body: "new" } }));
  assert.throws(() => compose(dir, "mockup-error.json"), /not both/);
  fs.symlinkSync("/etc", path.join(dir, "shared/escape"));
  fs.writeFileSync(file, JSON.stringify({ label: "Bad", base: "shared/escape/passwd" }));
  assert.throws(() => compose(dir, "mockup-error.json"), /escapes/);
});

test("local images are copied as bytes by the composer, with traversal checks", (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "shared/picture.png"), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(
    path.join(dir, "mockup-image.json"),
    JSON.stringify({ label: "Image", html: '<img src="shared/picture.png">' }),
  );
  assert.ok(compose(dir, "mockup-image.json").html.includes("data:image/png;base64,iVBORw=="));
  fs.symlinkSync("/etc", path.join(dir, "shared/escape"));
  fs.writeFileSync(
    path.join(dir, "mockup-image.json"),
    JSON.stringify({ label: "Image", html: '<img src="shared/escape/passwd.png">' }),
  );
  assert.throws(() => compose(dir, "mockup-image.json"));
});

test("style changes create immutable revisions while identical content reuses its version", (t) => {
  const dir = fixture(t);
  const file = "mockup-style.json";
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ label: "Style", css: "h1{color:rust}" }));
  const first = compose(dir, file).html;
  assert.equal(snapshot(dir, "mockup-style", first, 1, file).revision, 1);
  assert.equal(snapshot(dir, "mockup-style", first, 2, file).revision, 1);
  fs.writeFileSync(path.join(dir, "shared/style.css"), "body{color:black}");
  const second = compose(dir, file).html;
  assert.equal(snapshot(dir, "mockup-style", second, 2, file).revision, 2);
  fs.unlinkSync(path.join(dir, file));
  assert.equal(revisionHTML(dir, "mockup-style", 1).html, first);
  assert.equal(revisionHTML(dir, "mockup-style", 2).html, second);
  assert.equal(readHistory(dir)["mockup-style"].length, 2);
  assert.throws(() => revisionHTML(dir, "../escape", 1), /Invalid/);
});

test("feedback autosaves per revision, distinguishes neutral and unseen, and rejects stale writes", (t) => {
  const dir = fixture(t);
  snapshot(dir, "mockup-a", "first", 1, "mockup-a.html");
  snapshot(dir, "mockup-a", "second", 2, "mockup-a.html");
  const history = readHistory(dir);
  saveDraft(
    dir,
    {
      id: "mockup-a",
      revision: 1,
      notes: "Keep the header",
      vote: "up",
      seen: true,
      clientUpdated: 10,
    },
    history,
  );
  saveDraft(
    dir,
    { id: "mockup-a", revision: 1, notes: "stale", vote: "down", seen: true, clientUpdated: 9 },
    history,
  );
  saveDraft(
    dir,
    { id: "mockup-a", revision: 2, notes: "", vote: "neutral", seen: true, clientUpdated: 11 },
    history,
  );
  const drafts = readDrafts(dir);
  assert.equal(drafts["mockup-a:r1"].notes, "Keep the header");
  assert.equal(drafts["mockup-a:r2"].vote, "neutral");
  assert.throws(
    () => saveDraft(dir, { id: "mockup-a", revision: 3, notes: "", vote: null }, history),
    /Unknown/,
  );
});
