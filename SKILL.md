---
name: design-explorer
description: Generate diverse design mockups and collect structured feedback via full-screen carousel with keyboard voting, notes, and optional voice
user_invocable: true
---

# Design Explorer

Generate many diverse design mockups as HTML fragments. A global singleton server serves a full-screen keyboard-driven carousel with thumbs voting, notes, and optional voice recording. User submits feedback (copied to clipboard) and pastes it back.

## Trigger

User says: `/design-explorer [description]` or "explore designs for [thing]"

## Workflow

### 0. Preparation

Before generating mockups, check for design context in the project:
- Read any `DESIGN_GUIDE.md`, design tokens, or existing mockups in the project
- Check `CLAUDE.md` for design system references
- If the project has an established visual language, use it by default — unless the user explicitly asks to explore alternative designs. In that case, still read the existing design as a baseline to riff from, but feel free to diverge.
- If no design system exists, explore freely across the full aesthetic spectrum

### 1. Register with the server

```bash
mkdir -p {working_dir}/mockups
WORKSPACE_ID=$(~/.claude/skills/design-explorer/bin/register \
  --project "{working_dir}" --dir "{working_dir}/mockups")
```

This starts the server if not running (always port 10000), registers a workspace, and opens the browser on first registration. If another project is already using the server, this project gets a separate tab in the UI.

The server URL is always `http://localhost:10000`.

### 2. Clean up and generate mockups

**Before generating, check for existing mockup files:**
```bash
ls {working_dir}/mockups/*.html 2>/dev/null
```

If there are old mockups from previous sessions, **remove them** so the carousel starts clean. Don't read them — just delete them. Also reset sessions.json:
```bash
rm -f {working_dir}/mockups/*.html
echo '[]' > {working_dir}/mockups/sessions.json
rm -f {working_dir}/mockups/feedback.md
```

If the user explicitly asks to keep previous mockups (e.g., to iterate on them), skip the cleanup. But the default is a clean slate — old mockups clutter the carousel and slow down review.

Each mockup is a **separate HTML fragment file** with a **descriptive slug name**: `mockup-dark-sidebar.html`, `mockup-minimal-cards.html`, `mockup-retro-brutalist.html`, etc.

**Naming rules:**
- Use `mockup-{descriptive-slug}.html` — the slug should capture the design's distinctive character in 2-4 words
- NEVER use generic sequential names like `mockup-1.html` — these collide across sessions and tell you nothing about the content
- Good examples: `mockup-warm-editorial.html`, `mockup-dense-dashboard.html`, `mockup-organic-cards.html`
- Bad examples: `mockup-1.html`, `mockup-new.html`, `mockup-v2.html`
- The `data-mockup-id` must match the filename (without `.html`)

A mockup file is a `<section>` wrapper — no `<html>`, `<head>`, or boilerplate needed. Each mockup renders inside an **isolated iframe** with pre-loaded resources (see "What's available inside each mockup" below).

```html
<section class="mockup-section" data-mockup-id="mockup-warm-editorial" data-label="Warm Editorial">
  <!-- Your design HTML goes directly here -->
  <!-- Tailwind classes, custom <style> blocks, Lucide icons, Google Fonts all available -->
</section>
```

**Write mockups in batches of 5** — each is an independent file. Write 5 in parallel, then another 5. Writing all 10 in one parallel blast can exceed output token limits and crash the response.

**Sessions are automatic.** The server detects new file batches and creates sessions (rounds) automatically. No need to call any session endpoint.

### What's available inside each mockup

Every mockup renders inside an isolated iframe with these resources pre-loaded. Use them freely without adding imports or boilerplate:

**Tailwind CSS** (full JIT compiler via CDN)
- Use any Tailwind utility class directly: `class="flex items-center gap-4 bg-zinc-900 p-8"`
- Custom `<style>` blocks work alongside Tailwind for anything beyond utilities
- Customize Tailwind config inline if needed: `<script>tailwind.config = { theme: { extend: { colors: { parchment: '#f7f4ec' } } } }</script>`

**Google Fonts** — 11 diverse families pre-loaded, spanning the full aesthetic range:

| Font | Character | Good for |
|------|-----------|----------|
| **Inter** | Clean, neutral sans | Modern UI, dashboards, apps |
| **DM Sans** | Geometric, warm | Friendly brands, marketing |
| **Space Grotesk** | Techy, distinctive | Developer tools, tech products |
| **Syne** | Futuristic geometric | Experimental, avant-garde, kinetic |
| **Cormorant Garamond** | Elegant display serif | Editorial, luxury, scholarly |
| **EB Garamond** | Classical body serif | Books, manuscripts, traditional |
| **Crimson Pro** | Readable body serif | Long-form reading, articles |
| **Playfair Display** | Bold editorial serif | Headlines, magazines, drama |
| **Instrument Serif** | Contemporary serif | Fashion, art, distinctive branding |
| **JetBrains Mono** | Coding monospace | Technical UI, terminals, data |
| **Space Mono** | Quirky monospace | Retro-tech, brutalist, playful |

Use via CSS (`font-family: 'Cormorant Garamond'`) or Tailwind (`class="font-['Cormorant_Garamond']"`).
Additional fonts: add `@import` in a `<style>` block for any Google Font not in this list.

**Lucide Icons** — 1500+ icons, no SVG code needed:
```html
<i data-lucide="search"></i>
<i data-lucide="menu"></i>
<i data-lucide="heart" class="w-5 h-5 text-red-500"></i>
```
Browse the full set at https://lucide.dev/icons

**CSS baseline:**
- `box-sizing: border-box` on all elements
- `body { margin: 0; padding: 0 }` — you control all spacing
- Font smoothing and optimized text rendering enabled
- Default font: Inter (override freely — this is just a fallback, not a recommendation)

### Design generation principles

- **Be radically diverse**: Don't generate variations of the same idea. Explore fundamentally different visual languages, layouts, color palettes, typography pairings, and interaction models.
- **Push beyond defaults**: Include unconventional, surprising, even provocative approaches. Brutalist, maximalist, kinetic, editorial, retro-futuristic, organic, neo-classical, deconstructed — go well beyond safe corporate UI patterns.
- **Binary search the design space**: Cover extremes — minimal vs. maximal, dark vs. light, dense vs. spacious, serif vs. sans, geometric vs. organic, structured vs. freeform, warm vs. cool, quiet vs. bold.
- **Unique functionality**: Each mockup should showcase different feature ideas or interaction patterns, not just visual restyling of the same layout.
- **Full creative range**: The pre-loaded resources support everything from Renaissance-folio aesthetics (Cormorant Garamond, warm parchment palettes, structural ornaments, hairline rules) to brutalist tech (Space Mono, raw CSS grid, high contrast, no border-radius) to futuristic experimental (Syne, gradients, glassmorphism, asymmetric layouts). Use the full spectrum.
- **Bespoke over generic**: Each design should feel like it was made for this specific product, not assembled from a component library. Invent custom visual metaphors, unique color relationships, and distinctive spatial rhythms.
- **Self-contained**: Each mockup uses Tailwind classes, inline styles, or scoped `<style>` tags. No external dependencies needed beyond what the harness provides.

### 3. Wait for feedback

Tell the user:
1. The mockups are live at `http://localhost:10000` (always the same URL)
2. Use arrow keys to navigate, up/down to vote, Tab for notes, C to submit feedback (copies to clipboard)
3. Paste the feedback back here when ready

Wait for the user to paste their feedback before proceeding.

### 4. Iterate

Based on feedback:
- **Edit** a specific mockup: read + edit its file (e.g., `mockup-warm-editorial.html`)
- **Remove** a thumbs-down mockup: delete its file
- **Add** new variants: write new `mockup-{descriptive-slug}.html` files (scan existing files first to avoid name collisions)
- The browser updates live on every file change — no reload
- Sessions are created automatically for each new batch
- Go back to step 3

### Interpreting feedback

Feedback is proposal-centric — each mockup with feedback gets its own section:

```
### Warm Editorial  [👍]
Love the dark palette, serif typography works well

### Dense Dashboard  [👎]
Too busy, hard to read

### No feedback
- Minimal Cards
- Retro Brutalist
```

- **👍 = strong positive** — build on these directions
- **👎 = clear rejection** — don't iterate on these
- **No feedback = not interesting enough to comment on** — move away
- **Notes are the richest signal** — read carefully for nuance and specific elements called out
- Focus on what the user LIKED and amplify those qualities in next round

## Technical notes

- **Global singleton**: One server on port 10000 serves all projects. Each project registers as a workspace with its own tab in the UI.
- **Auto-sessions**: The server automatically creates session boundaries when it detects batches of new files. No need to manually mark sessions.
- **Feedback**: When the user presses C (or clicks Submit), feedback is copied to clipboard. The user pastes it back into the conversation.
- **Isolation**: Each mockup renders in its own iframe. CSS and JS cannot leak between mockups or break the carousel UI.
- **Auto-height**: Iframes auto-resize to match their content height.
- **Live updates**: When you edit a mockup file, the iframe reloads with updated content.
- **PID management**: Server writes `~/.claude/design-explorer.pid`. Idle shutdown after 30 min with no workspaces.
- **Legacy compat**: The old `--dir` flag still works for single-workspace mode.

## CLI tools

```bash
# Register workspace (starts server if needed)
~/.claude/skills/design-explorer/bin/register --project /path --dir /path/mockups [--branch main]

# Check server status
~/.claude/skills/design-explorer/bin/status

# Stop server
~/.claude/skills/design-explorer/bin/stop
```

## Key benefits of fragment architecture

- **Write**: Each mockup is 20-50 lines, not a 500-line monolith
- **Edit**: Read + edit one small file, not search through a huge page
- **Delete**: Just delete the file
- **Parallel writes**: Write 5 mockups in 5 parallel tool calls
- **No boilerplate**: Tailwind, fonts, icons, and CSS reset are provided by the harness — never write these
- **No CSS conflicts**: iframe isolation means mockup styles can't break other mockups or the carousel
- **Live updates**: SSE pushes add/update/remove — no full page reloads
