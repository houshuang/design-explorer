const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function resolveLocal(dir, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative))
    throw new Error("Shared files must use relative paths");
  const root = fs.realpathSync(dir);
  const file = fs.realpathSync(path.resolve(root, relative));
  if (!file.startsWith(root + path.sep)) throw new Error("Shared file escapes the workspace");
  if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error("Shared file exceeds 5 MiB");
  return file;
}

function readLocal(dir, relative) {
  return fs.readFileSync(resolveLocal(dir, relative), "utf8");
}

function readBrief(dir) {
  const file = path.join(dir, "exploration.json");
  if (!fs.existsSync(file)) return {};
  const brief = JSON.parse(readLocal(dir, "exploration.json"));
  if (!brief || typeof brief !== "object" || Array.isArray(brief))
    throw new Error("exploration.json must be an object");
  return brief;
}

const escapeAttr = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const scriptJSON = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

function dependencyStamp(dir, relative) {
  const file = resolveLocal(dir, relative);
  const stat = fs.statSync(file);
  return `${file}:${stat.mtimeMs}:${stat.size}:${stat.ino}`;
}

function dependenciesUnchanged(dir, dependencies) {
  try {
    return Object.entries(dependencies).every(
      ([file, stamp]) => dependencyStamp(dir, file) === stamp,
    );
  } catch {
    return false;
  }
}

function compose(dir, file, brief = readBrief(dir)) {
  const dependencies = {};
  const read = (relative) => {
    dependencies[relative] = dependencyStamp(dir, relative);
    return readLocal(dir, relative);
  };
  const source = read(file);
  const id = file.replace(/\.(html|json)$/, "");
  let html = source;
  if (file.endsWith(".json")) {
    const variant = JSON.parse(source);
    if (!variant || typeof variant !== "object" || Array.isArray(variant))
      throw new Error("Variant must be an object");
    if (typeof variant.label !== "string" || !variant.label.trim())
      throw new Error("Variant needs a label");
    const base = variant.base === undefined ? brief.base : variant.base;
    let body = typeof variant.html === "string" ? variant.html : base ? read(base) : "";
    if (!body) throw new Error("Variant needs html or a shared base");
    if (variant.html !== undefined && variant.slots !== undefined)
      throw new Error("Use html or slots, not both");
    for (const [slot, replacement] of Object.entries(variant.slots || {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(slot) || typeof replacement !== "string")
        throw new Error("Slots need simple names and HTML strings");
      const pattern = new RegExp(`<!--slot:${slot}-->[\\s\\S]*?<!--/slot:${slot}-->`, "g");
      const matches = body.match(pattern);
      if (!matches || matches.length !== 1)
        throw new Error(`Slot ${slot} must appear exactly once in the base`);
      body = body.replace(pattern, () => `<!--slot:${slot}-->${replacement}<!--/slot:${slot}-->`);
    }
    if (variant.css !== undefined && typeof variant.css !== "string")
      throw new Error("css must be a string");
    if (variant.script !== undefined && typeof variant.script !== "string")
      throw new Error("script must be a string");
    html = `<section class="mockup-section" data-mockup-id="${escapeAttr(id)}" data-label="${escapeAttr(variant.label)}">${variant.css ? `<style>${variant.css}</style>` : ""}${body}${variant.script ? `<script>${variant.script}</script>` : ""}</section>`;
  }
  const styles = (brief.styles || []).map((file) => `<style>${read(file)}</style>`).join("");
  const data = brief.data
    ? `<script>window.mockupData=${scriptJSON(JSON.parse(read(brief.data)))};</script>`
    : "";
  const prefix = styles + data;
  if (prefix) {
    const legacyContent = /<[^>]+class=["'][^"']*\bmockup-content\b[^"']*["'][^>]*>/i;
    if (legacyContent.test(html)) html = html.replace(legacyContent, (match) => match + prefix);
    else if (/<section\b[^>]*>/i.test(html))
      html = html.replace(/<section\b[^>]*>/i, (match) => match + prefix);
    else
      html = `<section class="mockup-section" data-mockup-id="${escapeAttr(id)}">${prefix}${html}</section>`;
  }
  html = html.replace(
    /\b(src|poster)=(['"])(shared\/[^'"]+)\2/g,
    (match, attr, quote, relative) => {
      const types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
      };
      const type = types[path.extname(relative).toLowerCase()];
      if (!type) throw new Error("Shared images must be PNG, JPEG, WebP, GIF or SVG");
      dependencies[relative] = dependencyStamp(dir, relative);
      const bytes = fs.readFileSync(resolveLocal(dir, relative));
      return `${attr}=${quote}data:${type};base64,${bytes.toString("base64")}${quote}`;
    },
  );
  return { html, source, dependencies };
}

function readHistory(dir) {
  const file = path.join(dir, ".history", "index.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function snapshot(dir, id, html, round, file) {
  const history = readHistory(dir);
  const revisions = history[id] || [];
  const hash = crypto.createHash("sha256").update(html).digest("hex");
  const last = revisions[revisions.length - 1];
  if (last && last.hash === hash) return last;
  const revision = (last?.revision || 0) + 1;
  const entry = { revision, hash, round, file, created: new Date().toISOString() };
  atomicWrite(path.join(dir, ".history", `${id}-r${revision}.html`), html);
  history[id] = [...revisions, entry];
  atomicWrite(path.join(dir, ".history", "index.json"), JSON.stringify(history, null, 2));
  return entry;
}

function revisionHTML(dir, id, revision) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isInteger(revision) || revision < 1)
    throw new Error("Invalid revision");
  const entry = (readHistory(dir)[id] || []).find((entry) => entry.revision === revision);
  if (!entry) throw new Error("Revision not found");
  return {
    ...entry,
    html: fs.readFileSync(path.join(dir, ".history", `${id}-r${revision}.html`), "utf8"),
  };
}

function readDrafts(dir) {
  const file = path.join(dir, "review-drafts.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function saveDraft(dir, review, history) {
  if (
    !review ||
    typeof review.id !== "string" ||
    !history[review.id]?.some((r) => r.revision === review.revision)
  )
    throw new Error("Unknown design revision");
  if (![null, "up", "down", "neutral"].includes(review.vote ?? null))
    throw new Error("Invalid vote");
  if (typeof review.notes !== "string" || review.notes.length > 50000)
    throw new Error("Invalid notes");
  const drafts = readDrafts(dir);
  const clientUpdated = Number.isFinite(review.clientUpdated) ? review.clientUpdated : Date.now();
  const previous = drafts[`${review.id}:r${review.revision}`];
  if (previous && previous.clientUpdated > clientUpdated) return previous;
  drafts[`${review.id}:r${review.revision}`] = {
    id: review.id,
    revision: review.revision,
    vote: review.vote ?? null,
    notes: review.notes,
    seen: review.seen === true,
    clientUpdated,
    updated: new Date().toISOString(),
  };
  atomicWrite(path.join(dir, "review-drafts.json"), JSON.stringify(drafts, null, 2));
  return drafts[`${review.id}:r${review.revision}`];
}

module.exports = {
  atomicWrite,
  readLocal,
  readBrief,
  compose,
  readHistory,
  snapshot,
  revisionHTML,
  readDrafts,
  saveDraft,
  dependenciesUnchanged,
};
