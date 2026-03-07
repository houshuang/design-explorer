# Design Explorer

A [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) for iterative design exploration. Generate diverse HTML mockups, review them in a full-screen carousel, and give structured feedback with keyboard shortcuts.

https://github.com/user-attachments/assets/placeholder — TODO: add demo gif

## How it works

1. You describe what you want designed (a landing page, a dashboard, a component)
2. Claude generates 5-10+ diverse HTML mockups as separate files
3. A local server serves them in a full-screen carousel with live updates
4. You review with keyboard shortcuts: arrow keys to navigate, ↑/↓ to vote, notes, optional voice
5. Press `C` to copy structured feedback, paste it back to Claude
6. Claude iterates — editing liked mockups, removing disliked ones, adding new variants
7. Repeat until you're happy

Each round uses sessions to track history. The browser updates live as Claude writes files — no page reloads.

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
| `C` | Copy all feedback to clipboard |
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
├── SKILL.md                    # Claude Code skill definition
├── README.md                   # This file
└── assets/
    ├── server.js               # Node server (~190 lines, zero deps)
    └── harness-template.html   # Full-screen carousel UI (~770 lines)
```

**Fragment architecture**: Each mockup is a standalone HTML file (`<section>` with scoped styles). Each mockup renders inside an **isolated iframe** with pre-loaded resources (Tailwind CSS, 11 Google Fonts, Lucide icons). Claude writes small focused fragments, not monolithic pages.

**Iframe isolation**: CSS and JS cannot leak between mockups or break the carousel. A broken mockup cannot crash the page.

**Pre-loaded harness**: Every iframe includes Tailwind CSS (full JIT), 11 Google Fonts (Inter, DM Sans, Space Grotesk, Syne, Cormorant Garamond, EB Garamond, Crimson Pro, Playfair Display, Instrument Serif, JetBrains Mono, Space Mono), and Lucide icons — so mockups stay compact and token-efficient.

**Server**: Watches the mockup directory, diffs file changes, pushes granular SSE events (`add`/`update`/`remove`). Supports sessions for tracking iteration rounds.

**No build step, no npm install, no dependencies.**

## Server CLI

```bash
node ~/.claude/skills/design-explorer/assets/server.js [options]

  --dir <path>     Mockup directory (default: current directory)
  --port <number>  Port (default: 8000)
  --no-open        Don't auto-open browser
  --harness <path> Custom harness template
```

## License

MIT
