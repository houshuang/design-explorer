# Design Explorer

A Claude Code and Codex skill for generating useful UI design variations, reviewing them in a local browser, and iterating from feedback. Models write the design differences; the reviewer supplies resources, comparison and persistence. Raw HTML remains available for bespoke layouts.

## Start an exploration

Invoke `/design-explorer` with the screen or decision to explore. The model reads the product identity and real content, states the decision and initial state, and chooses an appropriate number of directions. A broad exploration usually needs 4–5; a narrow decision needs 2–3; specific feedback may need one revision.

```bash
~/.claude/skills/design-explorer/bin/begin --project /path/to/project --topic report-placement --label "Entry points" --question "Where should reporting live?" --state "Dialog closed"
```

The helper creates a private directory inside `/tmp/claude/design-explorer`, registers it, starts a round and prints the directory, review URL and feedback file. Each exploration has its own workspace. One loopback server on port 10000 serves them all.

## Author only what varies

Choose freely between full `mockup-*.html` fragments and `mockup-*.json` variants. Reuse approved styles, fixture data, local images or a shared page once. JSON variants can replace named page slots, override CSS, or supply independent HTML. No component library or layout vocabulary is required.

See [the fragment reference](references/fragments.md) for the exact formats and examples. `exploration.json` holds the question, initial state, viewport, approved constraints, exclusions and optional shared files. Changes to shared files recompose dependent designs. Keep meaningful typography, spacing, representative content and working controls; inspect desktop and mobile renderings before presenting a round.

The paired real-model evaluation saved about 49–56% of output tokens for two narrow decisions. Broad layouts needed substantially more bespoke output; after equal repair passes they cost about 5% more output than the original workflow. Blind screenshot review preferred the revised narrow designs and, after repairs, modestly preferred the revised broad set. This small sample is evidence of useful reuse, not a universal quality or speed guarantee. See [evaluation methodology and results](eval/README.md).

## Review and iterate

Each design has a permanent number; edits keep the number and save an immutable revision. Notes and votes belong to the revision reviewed. The reviewer can:

- Navigate, like/reject, mark neutral, and add text or optional voice notes.
- Point at an element to anchor a note.
- Select the product width, window width, or 390/768/1280px.
- Pin a design, select a previous revision or archived design, and compare with A/B or side by side at equal widths.
- Reload without losing autosaved drafts. Drafts also have a browser fallback if saving fails.
- Submit feedback with `C` or the button. Success appears only after the server saves it; errors retain the notes for retry.

New activity in another workspace shows a badge without taking focus. Not reviewed, viewed without a verdict, and neutral are distinct states. Voice notes stay attached to the design and revision where recording began.

```bash
# Resume: register, then read the compact brief and numbered lineup.
~/.claude/skills/design-explorer/bin/register --project /path/to/project --dir /tmp/claude/design-explorer/mockups/example
~/.claude/skills/design-explorer/bin/context --dir /tmp/claude/design-explorer/mockups/example

# Start a round before adding or editing variants.
~/.claude/skills/design-explorer/bin/round --dir /tmp/claude/design-explorer/mockups/example --label "Refinements"
~/.claude/skills/design-explorer/bin/lineup --dir /tmp/claude/design-explorer/mockups/example

# Wait at most 60 seconds; a submission hash can exclude an older result.
~/.claude/skills/design-explorer/bin/feedback --dir /tmp/claude/design-explorer/mockups/example --round 2 --wait-seconds 60
# Add --after HASH to wait for a later submission.
```

Submitted feedback is written to `feedback-round-N.md`, with numbers, revision references and a lineup. Chat feedback can also end a round. Preserve explicit decisions in the brief and move rejected sources into `archived/`; snapshot history remains available. Never write reviewer feedback on the reviewer's behalf.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Left / right | Navigate |
| Up / down | Like / reject |
| Tab / Esc | Focus / blur notes |
| F | Fit to window |
| A | Switch current/reference |
| Alt + arrows | Navigate/vote from inside a preview |
| C | Submit feedback |
| Hold Space | Dictate, when voice is enabled |
| ? | Shortcut help |

## Install

```bash
git clone https://github.com/houshuang/design-explorer.git ~/.claude/skills/design-explorer
# Optional: expose the same installation to Codex.
ln -s ~/.claude/skills/design-explorer ~/.agents/skills/design-explorer
```

Node.js 18+ and a modern browser are required. The server has no npm dependencies or build step. Keep the installation at this path because the skill calls its helpers there. For voice, set `SONIOX_KEY` (or legacy `SONIX_KEY`) in the server environment or the installation's `.env`; otherwise voice is disabled.

## Runtime and verification

`assets/server.js` watches workspaces and handles rounds, feedback and revisions. `assets/workspace.js` composes files, embeds local image bytes, snapshots revisions and saves drafts. `assets/harness-template.html` renders isolated previews with Tailwind, Google Fonts and Lucide. Raw fragments and the legacy mockup-content wrapper remain supported.

The server binds only to 127.0.0.1, rejects foreign hosts/origins and non-JSON POSTs, and confines workspace/shared paths after symlink resolution. Previews use `sandbox="allow-scripts"` without same-origin access. They cannot read the parent's voice key or persistence. Shared inputs are trusted design code, not a sanitised template language.

Registration checks a hash of all three runtime files and restarts stale code while preserving registrations. Default registry, PID and logs live under `~/.claude`; `--state-dir` on begin/register/server isolates test state, and `--port` selects a private test port. `bin/status` and `bin/stop` operate on the default singleton.

```bash
node --test test/server.test.js test/workspace.test.js
# Browser tests require an existing Playwright installation and Chromium.
DE_PLAYWRIGHT=/absolute/path/to/playwright node --test test/browser.test.js
```

Tests use private servers and temporary directories. The browser suite covers workspace collisions, revision drafts, archived comparisons, point notes, equal widths, submission retry and delayed voice finalisation. Paid/subscription-backed model evaluations are separate and opt-in; see `eval/README.md`.

## License

MIT
