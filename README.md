# Design Explorer

A [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) for iterative design exploration. Generate diverse HTML mockups, review them in a full-screen carousel, and give structured feedback with keyboard shortcuts.

https://github.com/user-attachments/assets/placeholder — TODO: add demo gif

## How it works

1. You describe what you want designed (a landing page, a dashboard, a component)
2. Claude registers a workspace with the global singleton server (starts it if needed)
3. Claude generates 5-10+ diverse HTML mockups as separate files
4. A local server serves them in a full-screen carousel with live updates
5. You review with keyboard shortcuts: arrow keys to navigate, ↑/↓ to vote, notes, optional voice
6. Press `C` to submit feedback — it's written to `feedback.md` and Claude picks it up automatically
7. Claude iterates — editing liked mockups, removing disliked ones, adding new variants
8. Repeat until you're happy

**Global singleton**: One server on port 10000 serves all projects. Multiple Claude instances in different projects each register a workspace and get their own tab in the browser UI — no port conflicts, no confusion.

**Auto-sessions**: The server detects batches of new mockup files and creates session boundaries automatically. No manual session management needed.

**Feedback file**: When you submit feedback, it's written to `{mockupDir}/feedback.md` AND copied to clipboard. Claude watches the file — no need to paste.

## Install

```bash
# Clone into your Claude Code skills directory
git clone https://github.com/houshuang/design-explorer.git ~/.claude/skills/design-explorer
```

That's it. The skill is now available as `/design-explorer` in Claude Code.

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
3. `.env` files walking up from the mockup directory

If no key is found, voice is silently disabled and the mic button is hidden. Everything else works normally.

## Architecture

```
~/.claude/skills/design-explorer/
├── SKILL.md                    # Claude Code skill definition (workflow for Claude)
├── README.md                   # This file
├── CHANGELOG.md                # Version history
├── bin/
│   ├── register                # Register workspace (starts server if needed)
│   ├── status                  # Show server status and workspaces
│   └── stop                    # Stop the server
└── assets/
    ├── server.js               # Node server (~280 lines, zero deps)
    └── harness-template.html   # Full-screen carousel UI with workspace tabs
```

**Global singleton server**: One server on port 10000 serves all projects. Each Claude instance registers a workspace (project path + optional branch). The browser shows a tab bar for switching between workspaces.

**Fragment architecture**: Each mockup is a standalone HTML file (`<section>` with scoped styles). Each mockup renders inside an **isolated iframe** with pre-loaded resources (Tailwind CSS, 11 Google Fonts, Lucide icons). Claude writes small focused fragments, not monolithic pages.

**Iframe isolation**: CSS and JS cannot leak between mockups or break the carousel. A broken mockup cannot crash the page.

**Pre-loaded harness**: Every iframe includes Tailwind CSS (full JIT), 11 Google Fonts (Inter, DM Sans, Space Grotesk, Syne, Cormorant Garamond, EB Garamond, Crimson Pro, Playfair Display, Instrument Serif, JetBrains Mono, Space Mono), and Lucide icons — so mockups stay compact and token-efficient.

**Auto-sessions**: The server watches for new mockup files and creates session boundaries automatically (60s debounce — the timer resets with each new file, so it only fires 60s after the last file in a batch). This handles both parallel and sequential mockup generation.

**Feedback file**: When the user presses `C` (Submit), feedback for the current session is POSTed to the server, which writes it to `{mockupDir}/feedback.md`. Claude watches this file — no clipboard paste needed.

**PID management**: Server writes `~/.claude/design-explorer.pid`. Idle shutdown after 30 min with no registered workspaces.

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
1. Checks if the server is running (health check on port 10000)
2. Starts the server if not running (cleans stale PID files)
3. Registers the workspace via `POST /workspace/register`
4. Opens the browser on first registration only
5. Outputs the workspace ID to stdout

### Legacy mode

The server still accepts `--dir <path>` for backwards compatibility, which auto-registers a single workspace:

```bash
node ~/.claude/skills/design-explorer/assets/server.js --dir ./mockups
```

## License

MIT
