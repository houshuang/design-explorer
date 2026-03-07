---
name: design-explorer
description: Generate diverse design mockups and collect structured feedback via full-screen carousel with keyboard voting, notes, and optional voice
user_invocable: true
---

# Design Explorer

Generate many diverse design mockups as HTML fragments. The server serves a full-screen keyboard-driven carousel with thumbs voting, notes, and optional voice recording. User copies compiled feedback to clipboard and pastes it back.

## Trigger

User says: `/design-explorer [description]` or "explore designs for [thing]"

## Workflow

### 0. Preparation

Before generating mockups, check for design context in the project:
- Read any `DESIGN_GUIDE.md`, design tokens, or existing mockups in the project
- Check `CLAUDE.md` for design system references
- If the project has an established visual language, use it by default — unless the user explicitly asks to explore alternative designs. In that case, still read the existing design as a baseline to riff from, but feel free to diverge.
- If no design system exists, explore freely across the full aesthetic spectrum

### 1. Start the server (background)

First check if a design-explorer server is already running:
```bash
curl -s http://localhost:10000/health && echo "Server already running" || {
  mkdir -p {working_dir}/mockups
  node ~/.claude/skills/design-explorer/assets/server.js --dir {working_dir}/mockups --port 10000 &
}
```

If port 10000 is taken by something else, use `--port 10001` etc. Don't waste turns debugging port conflicts.

The server auto-opens the browser. It watches the mockup directory and pushes live updates via SSE — no reload needed.

### 2. Generate mockups

Each mockup is a **separate HTML fragment file**: `mockup-1.html`, `mockup-2.html`, etc.

A mockup file is a `<section>` wrapper — no `<html>`, `<head>`, or boilerplate needed. Each mockup renders inside an **isolated iframe** with pre-loaded resources (see "What's available inside each mockup" below).

```html
<section class="mockup-section" data-mockup-id="mockup-1" data-label="1. Design Name">
  <!-- Your design HTML goes directly here -->
  <!-- Tailwind classes, custom <style> blocks, Lucide icons, Google Fonts all available -->
</section>
```

**Write mockups in batches of 5** — each is an independent file. Write 5 in parallel, then another 5. Writing all 10 in one parallel blast can exceed output token limits and crash the response.

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
1. The mockups are live at `http://localhost:10000` (include the URL)
2. Use arrow keys to navigate, up/down to vote, Tab for notes, C to copy feedback
3. Paste the copied feedback back here when done

Do NOT proceed until the user pastes feedback. Wait for it.

### 4. Iterate

**IMPORTANT**: Before generating new mockups, mark a new session so the carousel shows round navigation:
```bash
curl -s -X POST http://localhost:10000/session
```

Based on feedback:
- **Edit** a specific mockup: read + edit its file (e.g., `mockup-3.html`)
- **Remove** a thumbs-down mockup: delete its file
- **Add** new variants: write new `mockup-N.html` files
- The browser updates live on every file change — no reload
- Go back to step 3

### Interpreting feedback

Feedback is proposal-centric — each mockup with feedback gets its own section:

```
### 1. Design Name  [👍]
Love the dark palette, serif typography works well

### 3. Another Design  [👎]
Too busy, hard to read

### No feedback
- 2. Minimal Modern
- 4. Editorial Magazine
```

- **👍 = strong positive** — build on these directions
- **👎 = clear rejection** — don't iterate on these
- **No feedback = not interesting enough to comment on** — move away
- **Notes are the richest signal** — read carefully for nuance and specific elements called out
- Focus on what the user LIKED and amplify those qualities in next round

## Technical notes

- **Isolation**: Each mockup renders in its own iframe. CSS and JS cannot leak between mockups or break the carousel UI. A broken mockup cannot crash the page.
- **Auto-height**: Iframes auto-resize to match their content height. The slide container scrolls if content exceeds the viewport.
- **Live updates**: When you edit a mockup file, the iframe reloads with updated content. Resources load from browser cache, so updates appear near-instantly.
- **Backwards compatibility**: The old format with `.mockup-header` + `.mockup-content` wrapper divs still works. The simpler `data-label` format is preferred going forward.
- **Full-bleed support**: The card has no internal padding — mockups control their own spacing. Use `p-8`, `p-12`, or any padding you want. Or go edge-to-edge within the card for full-bleed layouts.

## Key benefits of fragment architecture

- **Write**: Each mockup is 20-50 lines, not a 500-line monolith
- **Edit**: Read + edit one small file, not search through a huge page
- **Delete**: Just delete the file
- **Parallel writes**: Write 5 mockups in 5 parallel tool calls
- **No boilerplate**: Tailwind, fonts, icons, and CSS reset are provided by the harness — never write these
- **No CSS conflicts**: iframe isolation means mockup styles can't break other mockups or the carousel
- **Live updates**: SSE pushes add/update/remove — no full page reloads
