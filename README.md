# Design Explorer

A [Claude Code skill](https://code.claude.com/docs/en/skills) for iterative design exploration. Generate diverse HTML mockups, review them in a full-screen carousel, and give structured feedback with keyboard shortcuts.

## How it works

1. You describe what you want designed (a landing page, a dashboard, a component)
2. Claude registers a workspace with the global singleton server (starts it if needed)
3. Claude writes down fixed constraints and variation axes, then generates 5 mockups (3–4 when converging) as separate files
4. A local server serves them in a full-screen carousel with live updates
5. You review with keyboard shortcuts: arrow keys to navigate, ↑/↓ to vote, notes, optional voice
6. Press `C` to submit feedback — it's written to `feedback-round-N.md` and Claude, waiting on that file, picks it up automatically
7. Claude iterates — editing liked mockups, removing disliked ones, adding new variants
8. Repeat until you're happy

**Global singleton**: One server on `127.0.0.1:10000` serves all projects. Each exploration uses its own mockup directory (`/tmp/claude/design-explorer/mockups/<repo>-<topic>-<time>`) and gets its own tab in the browser UI, so two sessions in the same repo never clobber each other.

**Feedback-driven sessions**: All mockups written before you submit feedback belong to one round. When you press `C` (submit), the session closes — any new mockups from Claude's next iteration automatically start a new round. No manual session management needed.

**Auto-focus**: The browser automatically switches to the workspace and session with the most recent file additions.

**Feedback file**: When you submit feedback, it's written to `{mockupDir}/feedback-round-N.md` (one file per round, each heading naming the mockup file) AND copied to clipboard. Claude waits for the file — no need to paste.

## Install

```bash
# Clone into your Claude Code skills directory
git clone https://github.com/houshuang/design-explorer.git ~/.claude/skills/design-explorer
```

That's it. The skill is now available as `/design-explorer` in Claude Code. A running session picks it up without a restart (unless `~/.claude/skills` itself is new, in which case restart once); run `/skills` to check that it is listed.

Keep it in `~/.claude/skills/design-explorer`: the skill's instructions call its helper scripts at that path.

### Requirements

- Node.js (for the local preview server — zero npm dependencies)
- A modern browser

## Usage

In Claude Code:

```
/design-explorer a landing page for my SaaS product
/design-explorer redesign the settings page with better UX
/design-explorer explore dashboard layouts for analytics data
```

Or just describe what you want and mention "design" or "mockup" — Claude will use the skill.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `←` `→` | Navigate between mockups |
| `↑` | Like (toggle) |
| `↓` | Dislike (toggle) |
| `Tab` | Focus notes textarea |
| `Esc` | Blur notes |
| `F` | Toggle fit-to-window |
| `C` | Submit feedback (writes to file + clipboard) |
| `?` | Show/hide shortcut help |
| Hold `Space` | Voice note (requires Soniox) |

## Voice notes (optional)

Voice-to-text via [Soniox](https://soniox.com/) streaming transcription. Words appear in real-time as you speak. This is entirely optional — the skill works fine without it.

To enable, add your key to a `.env` file in the skill directory:

```bash
echo "SONIOX_KEY=your_key_here" >> ~/.claude/skills/design-explorer/.env
```

This is the recommended approach — configure once, works automatically in every project.

The server checks for the key in this order:
1. `SONIOX_KEY` or `SONIX_KEY` environment variable
2. `~/.claude/skills/design-explorer/.env`

If no key is found, voice is silently disabled and the mic button is hidden. Everything else works normally.

## Architecture

```
~/.claude/skills/design-explorer/
├── SKILL.md                    # Claude Code skill definition (workflow for Claude)
├── README.md                   # This file
├── CHANGELOG.md                # Version history
├── test/
│   └── server.test.js          # node --test test/server.test.js
├── bin/
│   ├── register                # Register workspace (starts or restarts server if needed)
│   ├── status                  # Show server status and workspaces
│   └── stop                    # Stop the server
└── assets/
    ├── server.js               # Node server (zero deps)
    └── harness-template.html   # Full-screen carousel UI with workspace tabs
```

**Global singleton server**: One server on port 10000 serves all projects. Each Claude session registers a workspace (its mockup directory, plus project path and branch for display). The browser shows a tab bar for switching between workspaces. Registrations are kept in `~/.claude/design-explorer-workspaces.json` so they survive restarts.

**Fragment architecture**: Each mockup is a standalone HTML file with a descriptive slug name (`mockup-warm-editorial.html`, `mockup-dense-dashboard.html`). Each renders inside an **isolated iframe** with pre-loaded resources (Tailwind CSS, 11 Google Fonts, Lucide icons). Claude writes small focused fragments, not monolithic pages. Old mockups are cleaned up by default before each new session.

**Iframe isolation**: Each mockup iframe is `sandbox="allow-scripts"` without `allow-same-origin`, so mockup code runs with an opaque origin: it cannot touch the carousel, read the Soniox key or call the server. A broken mockup cannot crash the page.

**Pre-loaded harness**: Every iframe includes Tailwind CSS (full JIT), 11 Google Fonts (Inter, DM Sans, Space Grotesk, Syne, Cormorant Garamond, EB Garamond, Crimson Pro, Playfair Display, Instrument Serif, JetBrains Mono, Space Mono), and Lucide icons — so mockups stay compact and token-efficient.

**Feedback-driven sessions**: All new mockup files go into the current "open session." When the user presses `C` (Submit), the session closes and feedback is written to `{mockupDir}/feedback-round-N.md`. Any new files arriving after that automatically start a new session. No timers or batch coordination needed — the user's feedback action is the natural session boundary. The UI auto-focuses on the workspace and session with the most recent activity.

**Security**: The server binds to `127.0.0.1` only and sends no CORS headers. It refuses requests whose `Host` is not `localhost`/`127.0.0.1` on its port (DNS rebinding) and requests from any other origin (CSRF); POSTs must be `application/json`. Workspaces can only point at existing directories inside `/tmp/claude/design-explorer` (checked after resolving symlinks). The Soniox key is only embedded in the page served to same-origin loopback requests.

**Lifecycle**: `register` launches the server in its own session with stdin closed and output appended to `~/.claude/design-explorer.log`, so stopping the Claude task that ran it does not kill it. `/health` reports a SHA-256 of `server.js` + `harness-template.html`; `register` restarts the server when that differs from the installed files, and fails with the log path if the port is held by something else. PID in `~/.claude/design-explorer.pid`. Idle shutdown after 30 min with no registered workspaces.

**No build step, no npm install, no dependencies.**

## CLI Tools

```bash
# Register a workspace (starts server if not running, opens browser on first registration)
~/.claude/skills/design-explorer/bin/register --project /path --dir /path/mockups [--branch main]

# Check server status and list workspaces
~/.claude/skills/design-explorer/bin/status

# Stop the server
~/.claude/skills/design-explorer/bin/stop
```

The `register` script is the primary entry point. It:
1. Checks if the server is running and its code hash matches the installed files
2. Starts it (detached) if not running, restarts it if stale, or fails loudly if another process holds the port
3. Registers the workspace via `POST /workspace/register`
4. Outputs the workspace ID to stdout

### Legacy mode

The server still accepts `--dir <path>` for backwards compatibility, which auto-registers a single workspace (the directory must be inside `/tmp/claude/design-explorer`):

```bash
node ~/.claude/skills/design-explorer/assets/server.js --dir /tmp/claude/design-explorer/mockups/demo
```

## Tests

```bash
node --test test/server.test.js
```

The tests start a private server through `bin/register` on port 10077 (and 10078) with a temporary `HOME`, and stop it afterwards.

## License

MIT
