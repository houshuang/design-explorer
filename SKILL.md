---
name: design-explorer
description: Explore UI design variations quickly as HTML previews, preserving product identity and real content; collect reviewer feedback and iterate with stable design numbers and version comparison. Also use when the user calls this design-review.
allowed-tools:
  - Bash(~/.claude/skills/design-explorer/bin/*)
  - Write(//tmp/claude/design-explorer/**)
  - Edit(//tmp/claude/design-explorer/**)
  - Write(//private/tmp/claude/design-explorer/**)
  - Edit(//private/tmp/claude/design-explorer/**)
---

# Design Explorer

Generate the meaningful design differences. The local reviewer supplies the carousel, resources, feedback, viewport controls and A/B comparison. Keep the visual craft: reuse what the brief fixes, and freely author the parts it asks you to explore.

## Frame the decision

Read the existing screen, design guide/tokens and relevant real content. Preserve an approved product identity unless the user asks to explore it. State the decision this round resolves, what stays fixed, and the initial interaction state in one short paragraph. For an entry-point decision, show the entry points with the same dialog closed; for a flow decision, make the relevant states reachable.

Use roughly 4–5 genuinely different directions for broad exploration, 2–3 for a narrow decision, or one revision when feedback is specific. Structural decisions need different structure; palette or typography decisions can use identical markup with CSS differences. Avoid spending a round on an already-settled choice.

## Start or resume

```bash
~/.claude/skills/design-explorer/bin/begin --project "<project path>" --topic "<short slug>" --label "<round label>" --question "<decision to resolve>" --state "<initial state>"
```

It creates a unique private directory, registers it, starts the round, and prints its directory, feedback file and review URL. Use those literal paths in subsequent calls. Work only in your own directory. The server accepts directories strictly inside `/tmp/claude/design-explorer`.

For an existing exploration, register its directory and read the compact brief and numbered lineup:

```bash
~/.claude/skills/design-explorer/bin/register --project "<project path>" --dir "<directory>"
~/.claude/skills/design-explorer/bin/context --dir "<directory>"
```

Before writing the next round, including edits, run `bin/round --dir "<directory>" --label "<label>"`. Add `--question` or `--state` when the decision changes. Repeating this while the round is empty is harmless. Do not edit an exploration owned by another session.

## Generate

Choose the smallest format that preserves design freedom. Read [references/fragments.md](references/fragments.md) for the shared-file and variant formats.

- **Full fragments** (`mockup-<descriptive-slug>.html`): use for independent page structures, or whenever this is simpler. Write a `<section class="mockup-section" data-mockup-id="mockup-<slug>" data-label="<human label>">…</section>`, without `<html>` or `<head>`.
- **Shared styles/data + fragments**: write or copy fixed material once under `shared/`; reference it from `exploration.json`. Each fragment inherits it.
- **Region or style variants** (`mockup-<slug>.json`): reuse a shared page, replace its named slots and add CSS/script only where needed. A style-only variant can contain just its label and CSS. There is no required component vocabulary.

Prepare shared material once before generating the variants. Copy real product content/assets with scripts or file tools rather than regenerate identical text. Do not print a large fixture merely to inspect its shape. Use `window.mockupData` for a shared JSON fixture when rendering repeated evidence; the model still chooses the actual layout.

Real copy, accurate data, intentional hierarchy, typography and spacing are required. Keep enough representative content to judge density and long labels. Use actual live images or shared local assets; no lorem ipsum or empty grey boxes. Make interactions relevant to the review work. Add optional `data-region="textbooks"` names to important sections so point-and-note feedback can identify them.

The iframe preloads Tailwind, Google Fonts, Lucide icons and baseline CSS. It is sandboxed: scripts run, but it cannot access the parent, cookies or localStorage. Full details and examples are in the fragment reference. No build or dependency installation is needed.

Render and inspect each direction before presenting it. Check the intended viewport and a narrow viewport where relevant, initial states, supplied facts and meaningful differences. Inspect screenshots as well as overflow checks: a page can fit the viewport while badges or connectors overlap text, or an open inspector covers its evidence. Exercise the controls needed to reach hidden content. Fix clipping, broken controls, missing content and accidental identity drift; put shared responsive corrections in the shared styles once. Token savings do not justify worse designs or fewer useful alternatives. Broad layout exploration can require as much output as before; choose craft over compression when the structures differ.

## Review and iterate

Run `bin/lineup --dir "<directory>"` and post this round's numbered labels with the review URL. Numbers identify designs, not carousel positions. Preserve the small number-to-design mapping in chat; do not replace it with a long walkthrough. Name the design when acting on a number from feedback.

The reviewer can navigate, like/reject or mark neutral, add notes/voice, point at an element, change viewport width, pin a revision, and compare at the same width or side by side. Notes autosave; **Submit/C** sends the round to you. Revised designs keep their number but get a new revision; previous feedback stays attached to the version reviewed.

```bash
~/.claude/skills/design-explorer/bin/feedback --dir "<directory>" --round <N> --wait-seconds 60
```

Use the printed round number. The helper waits at most 60 seconds and exits; use a background task if available and keep communicating normally. Recheck after a timeout when useful; do not leave an unbounded shell loop running. Submitted feedback includes a hash; `--after <hash>` waits for a newer submission. Chat feedback also ends a round: use it immediately and stop any pending wait. Never fabricate `feedback-round-N.md`.

Likes and rejections apply to the reviewed revision; notes identify which elements to keep or change. **No feedback is unknown, not rejection.** The reviewer distinguishes not reviewed, viewed without a verdict, and neutral. Do not guess which design an unresolved number means.

Record explicit approved constraints and exclusions in `exploration.json` (`approved`, `avoid`); keep interpretations separate from reviewer decisions. Start the next round, edit or add variants, and move rejected source files into an `archived/` subdirectory rather than erase the exploration. Snapshots remain available for comparison. Re-run the numbered lineup.

The server is one loopback-only singleton at `http://localhost:10000`; each directory has its own workspace. `bin/status` checks it and `bin/stop` stops it. Registration restarts stale installed code while preserving workspaces. On failure, report the printed error and log path.
