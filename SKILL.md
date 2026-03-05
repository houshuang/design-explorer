---
name: design-explorer
description: Generate diverse design mockups and collect structured feedback via thumbs voting and notes
user_invocable: true
---

# Design Explorer

Generate many diverse design mockups as HTML fragments. The server assembles them into a single feedback page with thumbs up/down voting and notes. User copies compiled feedback text to clipboard and pastes it back.

## Trigger

User says: `/design-explorer [description]` or "explore designs for [thing]"

## Workflow

### 1. Start the server (background)

```bash
mkdir -p {working_dir}/mockups
node ~/.claude/skills/design-explorer/assets/server.js --dir {working_dir}/mockups --port 8000 &
```

The server auto-opens the browser. It watches the mockup directory and auto-reloads when files change.

### 2. Generate mockups

Each mockup is a **separate HTML fragment file**: `mockup-1.html`, `mockup-2.html`, etc. The server assembles them into a page.

A mockup file is just a `<section>` element — no `<html>`, `<head>`, or harness code:

```html
<section class="mockup-section" data-mockup-id="mockup-1">
  <div class="mockup-header">
    <h2 class="mockup-label">1. Design Name</h2>
    <div class="rating-buttons">
      <button data-rating="down">👎</button>
      <button data-rating="up">👍</button>
    </div>
  </div>
  <div class="mockup-content">
    <!-- DESIGN HTML HERE — use inline styles or scoped <style> -->
  </div>
  <div class="feedback-panel">
    <button class="feedback-toggle">▸ Notes</button>
    <div class="feedback-body">
      <textarea placeholder="Notes about this design..."></textarea>
    </div>
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

Tell the user the mockups are ready and to paste their feedback when done. The user:
1. Views all mockups in the browser
2. Clicks 👍/👎 on each
3. Optionally writes notes per mockup
4. Clicks "Copy Feedback" at the bottom — this copies a text summary to clipboard
5. Pastes the text back into the chat

### 4. Iterate

Based on feedback:
- **Edit** a specific mockup: read + edit its file (e.g., `mockup-3.html`)
- **Remove** a thumbs-down mockup: delete its file
- **Add** new variants: write new `mockup-N.html` files
- The browser auto-reloads on every file change
- Go back to step 3

## Key Benefits of Fragment Architecture

- **Write**: Each mockup is 20-40 lines, not a 500-line monolith
- **Edit**: Read + edit one small file, not search through a huge page
- **Delete**: Just delete the file
- **Parallel writes**: Write 5 mockups in 5 parallel tool calls
- **No harness duplication**: CSS/JS lives in the template, never in your output
