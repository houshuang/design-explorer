---
name: design-explorer
description: Generate diverse design mockups and collect structured feedback via full-screen carousel with keyboard voting, notes, and optional voice
user-invocable: true
allowed-tools:
  - Bash(~/.claude/skills/design-explorer/bin/*)
  - Write(//tmp/claude/design-explorer/**)
  - Edit(//tmp/claude/design-explorer/**)
  - Write(//private/tmp/claude/design-explorer/**)
  - Edit(//private/tmp/claude/design-explorer/**)
---

# Design Explorer

Generate design mockups as HTML fragments. A local singleton server shows them in a full-screen, keyboard-driven carousel with voting, notes and optional voice. When the user submits, feedback is written to a file you wait for; it is also copied to the clipboard as a fallback.

## Trigger

User says: `/design-explorer [description]` or "explore designs for [thing]"

## Workflow

### 0. Preparation

- Read any `DESIGN_GUIDE.md`, design tokens, existing screens or mockups, and design references in `CLAUDE.md`.
- If the project has an established visual language, use it by default. Diverge only when the user asks for alternatives, and even then riff from the existing design.
- If no design system exists, explore freely across the aesthetic spectrum.

### 1. Register with the server

Each exploration gets its **own directory** under `/tmp/claude/design-explorer/mockups/`, named after the repo plus a short topic slug and a time suffix. Other sessions (even in the same repo) use their own directories, so never touch a directory you did not create. The server refuses directories outside `/tmp/claude/design-explorer`.

```bash
PROJECT_NAME=$(cd "{working_dir}" && basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || basename "{working_dir}")
MOCKUP_DIR="/tmp/claude/design-explorer/mockups/$PROJECT_NAME-{topic-slug}-$(date +%H%M%S)"
mkdir -p "$MOCKUP_DIR" && echo "$MOCKUP_DIR"
~/.claude/skills/design-explorer/bin/register --project "{working_dir}" --dir "$MOCKUP_DIR"
```

`{topic-slug}` is 1–3 words, e.g. `settings-page`. Shell variables do not persist between Bash calls, so note the printed `MOCKUP_DIR` and use the literal path from now on. To continue an earlier exploration, reuse its directory instead of creating a new one.

`register` starts the server if needed (always `http://localhost:10000`), restarts it if the installed code changed, and prints the workspace ID. Each directory gets its own tab in the UI. If it fails, it prints the reason and the log path (`~/.claude/design-explorer.log`); report that to the user rather than working around it.

### 2. Plan, then generate

Before writing any mockup, write down in your reply:
- **Fixed constraints**: what every mockup keeps (content, data, brand, platform, required features).
- **2–3 variation axes**: the dimensions this round explores (e.g. density, navigation model, tone). Place each mockup at a distinct point on those axes.

**Round size**: 5 mockups in the first round; 3–4 when converging on liked directions. Write them as parallel Write calls in one batch.

**Start the round first.** Before writing or editing any mockup for this round, including the first, run:

```bash
~/.claude/skills/design-explorer/bin/round --dir "<MOCKUP_DIR>" --label "<what this round explores, 2–5 words>"
```

It prints `Round N · label` and the feedback file to wait for. Every mockup created **or edited** after the call belongs to round N, so the round pill in the UI shows exactly what is new; untouched mockups stay in their earlier rounds. Running it again before any file is written only updates the label, so a repeat after compaction is harmless.

Each mockup is a file `mockup-{descriptive-slug}.html` in `MOCKUP_DIR`:
- The slug captures the design's character in 2–4 words (`mockup-warm-editorial.html`, `mockup-dense-dashboard.html`), never `mockup-1.html` or `mockup-v2.html`.
- `data-mockup-id` matches the filename without `.html`.

A mockup file is a `<section>` wrapper, no `<html>` or `<head>`:

```html
<section class="mockup-section" data-mockup-id="mockup-warm-editorial" data-label="Warm Editorial">
  <!-- Design HTML; Tailwind classes, <style> blocks, Lucide icons and Google Fonts are available -->
</section>
```


### What's available inside each mockup

Each mockup renders in a sandboxed iframe (`sandbox="allow-scripts"`): scripts run, but the mockup cannot reach the parent page, use `localStorage`/cookies, or submit forms. Pre-loaded:

- **Tailwind CSS** (JIT via CDN). Inline config works: `<script>tailwind.config = { theme: { extend: { colors: { parchment: '#f7f4ec' } } } }</script>`
- **Google Fonts**: Inter, DM Sans, Space Grotesk, Syne, Cormorant Garamond, EB Garamond, Crimson Pro, Playfair Display, Instrument Serif, JetBrains Mono, Space Mono. Use `font-family: 'Cormorant Garamond'` or `class="font-['Cormorant_Garamond']"`; `@import` any other Google Font.
- **Lucide icons**: `<i data-lucide="search" class="w-5 h-5"></i>` (https://lucide.dev/icons)
- **Baseline CSS**: `box-sizing: border-box`, `body { margin: 0 }`, Inter as fallback font.

### Design generation principles

- **Real content**: use the product's actual copy, data, names and screens. No lorem ipsum or grey placeholder boxes. Images must be full-resolution `https://` URLs (the project's live assets or suitable photos) or `data:` URIs; local file paths do not load.
- **Distinct, not cosmetic**: each mockup should differ along the chosen axes in layout, hierarchy or interaction model, not just colour.
- **Range to match the brief**: without an existing design language, cover real extremes (minimal vs. maximal, dense vs. spacious, serif vs. sans, quiet vs. bold) and include at least one unexpected direction. With one, stay inside it and vary structure and interaction instead.
- **Bespoke over generic**: make each design feel built for this product rather than assembled from a component library.
- **Self-contained**: Tailwind, inline styles or scoped `<style>` only.

### 3. Wait for feedback

Run `~/.claude/skills/design-explorer/bin/lineup --dir "<MOCKUP_DIR>"` and paste the new round's lines into your reply:

```
Round 2 · two-column (open)
  #2  Warm Editorial  (mockup-warm-editorial.html)
  #6  Split Reader  (mockup-split-reader.html)
```

Every mockup has a **number that never changes** within its directory, shown as `#N` in the carousel. A revised mockup keeps its number and a deleted one's number is never reused. The pasted lineup puts the number-to-design mapping into the conversation, where you will need it when feedback arrives.

Tell the user the mockups are live at `http://localhost:10000`: arrows navigate, ↑/↓ vote, Tab for notes, hold Space to dictate (if voice is set up), C to submit.

Then wait for the feedback file that `round` printed instead of asking the user to paste. Start a Monitor (timeout 30 min) with:

```bash
F="<feedback file printed by round>"
for i in $(seq 1 900); do [ -s "$F" ] && { cat "$F"; exit 0; }; sleep 2; done; echo "No feedback after 30 min: $F"
```

If Monitor is unavailable, run the same loop with Bash `run_in_background`. If it times out, ask the user to press C or paste the feedback (it is on their clipboard).

The user often gives feedback in chat instead. Treat it the same way: stop the Monitor and go to step 4. Do not write `feedback-round-N.md` yourself.

### 4. Iterate

- **Start the next round** with `bin/round` (step 2) before touching any file.
- **Edit** a liked mockup in place: the iframe reloads live and the mockup moves into the new round.
- **Delete** rejected mockups.
- **Add** new variants with fresh slugs (list the directory first to avoid collisions).
- Go back to step 3 with the feedback file the new round printed.

### Interpreting feedback

```
### #2 Warm Editorial (mockup-warm-editorial.html)  [👍]
Love the dark palette, serif typography works well

### #4 Dense Dashboard (mockup-dense-dashboard.html)  [👎]
Too busy, hard to read

### No feedback
- #6 Minimal Cards (mockup-minimal-cards.html)
```

- **Numbers identify designs, not positions.** "Number 4", "#4", "the fourth one" or "four" in chat or notes means the mockup numbered `#4`, never the fourth slide or the fourth file you wrote. Resolve every number against the latest `bin/lineup` output (run it again if unsure) and name the design back when you act on it ("#4 Dense Dashboard: dropping it"). If a number matches no mockup, ask; do not guess.

- **👍** strong positive: build on it. **👎** rejection: drop it.
- **No feedback**: not interesting enough to comment on; move away.
- **Notes are the richest signal**: read them for the specific elements called out, and amplify what was liked.

## Technical notes

- **Singleton**: one server on `127.0.0.1:10000` for all projects; each mockup directory is a workspace tab. Registrations survive server restarts.
- **Security**: loopback only; requests with a foreign `Host` or `Origin` are refused.
- **Rounds**: `bin/round` closes the open round and starts the next; pressing C on the open round also closes it. Both leave an empty round open, so numbers have no gaps. Round numbers match `feedback-round-N.md` and never restart within a directory. Resubmitting a round overwrites its file.
- **Lifecycle**: the server runs detached from the Claude session; PID in `~/.claude/design-explorer.pid`, log in `~/.claude/design-explorer.log`.

## CLI tools

```bash
~/.claude/skills/design-explorer/bin/register --project /path --dir /tmp/claude/design-explorer/mockups/NAME [--branch main]
~/.claude/skills/design-explorer/bin/round --dir /tmp/claude/design-explorer/mockups/NAME [--label TEXT]
~/.claude/skills/design-explorer/bin/lineup --dir /tmp/claude/design-explorer/mockups/NAME
~/.claude/skills/design-explorer/bin/status
~/.claude/skills/design-explorer/bin/stop
```
