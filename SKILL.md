---
name: design-explorer
description: Rapid visual design iteration with voice critique, drawing annotations, and structured feedback
user_invocable: true
---

# Design Explorer

Launch a design exploration session with auto-reloading mockups, voice critique, drawing annotations, and structured feedback.

## Trigger

User says: `/design-explorer [description]` or "explore designs for [thing]"

## Workflow

### 1. Start the server (background)

```bash
mkdir -p {working_dir}/mockups
node ~/.claude/skills/design-explorer/assets/server.js --dir {working_dir}/mockups --port 8000 &
```

The server auto-opens the browser. It watches the mockup directory and auto-reloads when files change.

### 2. Write mockup files

Each mockup is a **separate HTML fragment file**: `mockup-1.html`, `mockup-2.html`, etc. The server automatically assembles them into a page using the harness template.

A mockup file is just the `<section>` element — no `<html>`, `<head>`, or harness code:

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
      <div class="annotation-thumbnails"></div>
      <div class="voice-transcripts"></div>
    </div>
  </div>
</section>
```

**Write mockups in parallel** — each is an independent file:

```
Write mockup-1.html  (Design A)
Write mockup-2.html  (Design B)  — can be parallel
Write mockup-3.html  (Design C)  — can be parallel
```

The browser auto-reloads on each write. Files are sorted numerically (`mockup-1`, `mockup-2`, ...).

### 3. Wait for user feedback

After telling the user mockups are ready, block on the long-poll endpoint:

```bash
curl -s http://localhost:8000/feedback/wait?since=0&timeout=120000
```

This blocks until the user clicks Submit or times out. On timeout, re-poll.

Once notified, read the full feedback:

```bash
curl -s http://localhost:8000/feedback
```

### 4. Read and act on feedback

The feedback JSON contains:
- **ratings**: "up" or "down" per mockup (thumbs up/down)
- **notes**: Free text per mockup
- **critiqueSessions**: Voice transcripts with `[Mockup N: "Label"]` headers
- **annotations**: PNG files + **strokeRegions** (percentage bounding boxes of what user circled)
- Each mockup entry includes `strokeRegions: [{xPct, yPct, wPct, hPct}, ...]` so you can map annotations back to elements in the HTML you wrote

### 5. Iterate

Based on feedback:
- **Edit** a specific mockup: just read + edit its file (e.g., `mockup-3.html`)
- **Remove** a thumbs-down mockup: delete its file
- **Add** new variants: write new `mockup-N.html` files
- The browser auto-reloads on every file change
- Go back to step 3

For subsequent polls, use `since=N`:
```bash
curl -s http://localhost:8000/feedback/wait?since=1&timeout=120000
```

## Key Benefits of Fragment Architecture

- **Write**: Each mockup is 20-40 lines, not a 500-line monolith
- **Edit**: Read + edit one small file, not search through a huge page
- **Delete**: Just delete the file
- **Parallel writes**: Write 5 mockups in 5 parallel tool calls
- **No harness duplication**: CSS/JS lives in the template, never in your output

## User Controls

| Control | Action |
|---------|--------|
| `R` / Record button | Start/stop voice critique with live waveform |
| `D` / Draw button | Toggle draw mode — draw on mockup content areas |
| `Ctrl+Z` | Undo last stroke |
| `Esc` | Cancel recording or draw mode |
| 👍 / 👎 | Thumbs up/down per mockup (click to toggle) |
| Notes panel | Free text per mockup |
| Audio device dropdown | Select which microphone to use |
| Submit | Send all feedback to server |

## Voice Setup

Transcription uses Soniox cloud API (fast, multilingual). Ensure `SONIOX_API_KEY` or `SONIX_KEY` is set in environment, or in a `.env` file in the working directory, `~/src/petrarca/.env`, or `~/src/alignment/.env`.

## Health Check

```bash
curl http://localhost:8000/health
```

Returns: transcription backend, mockup count + filenames, feedback count.
