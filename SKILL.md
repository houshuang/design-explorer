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

### 1. Start the server (background)

```bash
mkdir -p {working_dir}/mockups
node ~/.claude/skills/design-explorer/assets/server.js --dir {working_dir}/mockups --port 10000 &
```

The server auto-opens the browser. It watches the mockup directory and pushes live updates via SSE — no reload needed.

### 2. Generate mockups

Each mockup is a **separate HTML fragment file**: `mockup-1.html`, `mockup-2.html`, etc.

A mockup file is just a `<section>` element — no `<html>`, `<head>`, or harness code. The harness renders voting UI — do NOT include rating buttons.

```html
<section class="mockup-section" data-mockup-id="mockup-1">
  <div class="mockup-header">
    <h2 class="mockup-label">1. Design Name</h2>
  </div>
  <div class="mockup-content">
    <!-- DESIGN HTML HERE — use inline styles or scoped <style> -->
    <!-- Max-width is ~900px, design accordingly -->
  </div>
</section>
```

**Write mockups in parallel** — each is an independent file. Generate 5-10+ mockups per round.

### Design generation principles

- **Be diverse**: Don't generate 10 variations of the same idea. Explore fundamentally different approaches, layouts, color schemes, interaction models.
- **Be innovative**: Include at least 2-3 unconventional or surprising approaches the user wouldn't have thought of.
- **Binary search the design space**: Cover the extremes — minimal vs. maximal, dark vs. light, dense vs. spacious, playful vs. serious.
- **Unique functionality**: Each mockup should showcase a different feature idea or interaction pattern, not just visual restyling.
- **Self-contained**: Each mockup uses inline styles or a scoped `<style>` tag. No external dependencies.

### 3. Wait for feedback

Tell the user the mockups are ready and to paste their feedback when done. The user reviews mockups full-screen using keyboard shortcuts, records voice notes (if configured), then presses C to copy feedback and pastes it back.

Between rounds: `curl -s -X POST http://localhost:10000/session` to mark a new session.

### 4. Iterate

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

## Key Benefits of Fragment Architecture

- **Write**: Each mockup is 20-40 lines, not a 500-line monolith
- **Edit**: Read + edit one small file, not search through a huge page
- **Delete**: Just delete the file
- **Parallel writes**: Write 5 mockups in 5 parallel tool calls
- **No harness duplication**: CSS/JS lives in the template, never in your output
- **Live updates**: SSE pushes add/update/remove — no full page reloads
