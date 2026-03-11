# Changelog

## 2026-03-11 — Feedback-Driven Sessions (replaces batch signaling)

### Problem
Session management relied on Claude correctly calling `batch/start` → `batch/end` and a 5-minute debounce timer as fallback. In practice this failed often: Claude forgot `batch/end`, context compaction interrupted mid-batch, or files written minutes apart got split into separate rounds. Cross-project session IDs leaked into pill labels (e.g., "Round 12, 13, 14, 15" in a project that only had 2 rounds). Mockups appeared in "All" but not in any round pill because they had `session: 0`.

### Solution
- **Feedback closes sessions**: When the user presses C (submit feedback), the server closes the current session. All files arriving after that start a new session. No timers, no batch coordination needed.
- **Open session model**: New files always go into the "open session" (created on demand). `getOrCreateOpenSession()` replaces `autoCreateSession()`.
- **Workspace-scoped pills**: Session pills now filter by current workspace, preventing cross-project ID leakage. Display uses sequential numbering (`Round 1, 2, 3`) regardless of internal IDs.
- **Auto-focus**: Client auto-switches to the workspace/session with the most recent file additions (after initial load).
- **Auto-reset on cleanup**: When all `.html` files are deleted, sessions reset to `[]` automatically.
- **Server sends `init-complete` event**: Client distinguishes initial load from runtime file additions, preventing spurious workspace switching on connect.

### Files Changed
- `assets/server.js` — Replaced `autoCreateSession` + timers with `getOrCreateOpenSession`, feedback endpoint closes sessions, `init-complete` SSE event, workspace reset on empty
- `assets/harness-template.html` — Workspace-scoped session pills, sequential pill numbering, auto-focus on `add` events, `session-closed` + `init-complete` event handlers
- `SKILL.md` — Removed batch signaling instructions, documented feedback-driven session lifecycle

---

## 2026-03-09 — Batch Signaling to Fix Session Scattering

### Problem
Mockups got split across multiple sessions (rounds) because the 60s auto-session debounce timer fired between batches of 5 writes. Claude writes mockups in batches of 5 (to avoid token limits), but inter-batch gaps (tool approval, generation time) often exceed 60s. Evidence: petrarca had 10 rounds where rounds 3+4, and 8+9+10 should each have been single rounds.

### Solution
- **Batch signaling**: New `POST /workspace/:id/batch/start` and `batch/end` endpoints. Claude signals batch start before writing any mockups, and batch end after all are written. During batching, auto-session timer is suppressed.
- **`batch/end` creates session immediately** — no waiting for debounce. All unassigned mockups are grouped into one session.
- **Fallback debounce increased to 5 minutes** (was 60s) — only fires if Claude forgets to signal batch end.
- **SKILL.md updated** with batch signaling instructions around mockup writes and during iteration.

### Files Changed
- `assets/server.js` — `batching` flag on workspace, `batch/start` + `batch/end` endpoints, 5-min fallback debounce
- `SKILL.md` — Batch signal workflow, workspace ID capture from register, updated iteration + technical notes

---

## 2026-03-09 — Descriptive Mockup Names + Clean-Slate Default

### Problem
Mockups used generic sequential names (`mockup-1.html`, `mockup-2.html`) that collided across sessions, causing write errors. Claude then had to read old files to find available names, wasting time. Old mockups accumulated in the carousel across sessions, making review noisy.

### Solution
- **Descriptive slug names**: `mockup-warm-editorial.html`, `mockup-dense-dashboard.html` — inherently unique and self-documenting
- **Clean-slate default**: Before generating, delete old mockups + reset sessions.json. Previous mockups are kept only if the user explicitly asks
- **Scan before generating**: `ls` the mockups directory before writing to avoid collisions even when cleanup is skipped

### Files Changed
- `SKILL.md` — New naming convention, cleanup step, updated examples throughout

---

## 2026-03-08 — Global Singleton Server + Workspace Model

### Problem
Multiple Claude instances in different projects each started their own server on different ports (10000, 10001, etc.), causing confusion and port conflicts. Claude often forgot to POST /session, so new mockups landed in old sessions. The feedback loop required clipboard paste — Claude couldn't watch for feedback automatically.

### Solution: Global Singleton + Workspaces

**One server, one port, many workspaces.** A single server on port 10000 serves all projects. Each Claude instance registers a workspace (project path + optional branch) and gets its own tab in the browser UI.

**Key changes:**
- **Workspace registry**: `POST /workspace/register` creates a workspace with its own file watcher, sessions, and mockup directory. `DELETE /workspace/:id` removes it.
- **Auto-sessions**: Server detects batches of new files (60s debounce, resets on each new file) and creates session boundaries automatically — no manual `POST /session` needed.
- **Feedback file**: `POST /workspace/:id/feedback` writes `feedback.md` to the mockup directory AND copies to clipboard. Claude watches the file instead of waiting for paste.
- **Workspace tab bar**: Browser UI shows tabs for all registered workspaces with mockup count badges. Subtle notification dot when other workspaces get new mockups.
- **bin/ scripts**: `register`, `status`, `stop` — replaces inline curl/node commands in SKILL.md.
- **PID management**: Server writes `~/.claude/design-explorer.pid`. Idle shutdown after 30 min with no workspaces.
- **Browser auto-open**: Only on first workspace registration, not on subsequent ones.
- **Legacy compat**: `--dir` flag still works, auto-registers a single workspace.

### Files Changed
- `assets/server.js` — Rewritten with workspace registry, auto-sessions, feedback endpoint, PID lifecycle
- `assets/harness-template.html` — Workspace tab bar, Submit button (was Copy), scoped feedback to current session
- `bin/register` — New: register workspace, start server if needed
- `bin/status` — New: show server status and workspaces
- `bin/stop` — New: graceful shutdown
- `SKILL.md` — Rewritten workflow: register → generate → watch feedback.md → iterate
- `README.md` — Updated architecture, CLI tools, keyboard shortcuts

---

## 2026-03-07 — Iframe Sandbox + Pre-loaded Harness

### Problem
Bad HTML in mockups could break the entire carousel UI or crash Chrome. CSS from one mockup could leak into others or override carousel controls. Inline event handlers like `<img onerror="while(true){}" src="x">` could freeze the browser. `position: fixed` elements could escape the slide container.

### Solution: Iframe Isolation
Each mockup now renders in its own `<iframe srcdoc="...">` instead of being injected via `innerHTML` into the shared DOM. This provides complete CSS, JS, and DOM isolation. If one mockup crashes, only that iframe dies — the carousel keeps working.

**Key implementation details:**
- `buildIframeSrc()` wraps mockup content in a full HTML document with pre-loaded resources
- Uses `const scr = 'script'` trick to avoid premature `</script>` closure in the template literal
- Auto-height via `ResizeObserver` + `postMessage` — iframe reports `scrollHeight` to parent
- Polling fallback (20 intervals at 200ms) catches font loading and Tailwind JIT reflows
- Card padding removed (`overflow: hidden` added) — mockups control their own spacing

### Pre-loaded Harness (in each iframe)
To minimize token usage and enable richer designs without boilerplate:
- **Tailwind CSS** via CDN (full JIT compiler)
- **11 Google Fonts** spanning modern → classical → experimental → monospace
- **Lucide Icons** (1500+, `<i data-lucide="name">` — auto-initialized)
- CSS reset + font smoothing

### Mockup Format Simplified
New format uses `data-label` attribute instead of nested header divs:
```html
<section class="mockup-section" data-mockup-id="mockup-1" data-label="1. Design Name">
  <!-- Design HTML — full card width, you control padding -->
</section>
```
Old `.mockup-header` + `.mockup-content` format still works (backwards compatible).

### Workflow Fixes (from chat history analysis)
Searched past conversations with `claude-chat-search` and found 5 recurring issues:

1. **Output token crash**: Writing 10 mockups in one parallel blast hit 32K token limit → Added "batch writes to 5" guidance
2. **Design guide ignored**: Mockups didn't match project's design system → Added Step 0: read design guides before generating
3. **Port already in use**: Wasted turns on port conflicts → Added health-check-first startup pattern
4. **Sessions never marked**: Round navigation pills never appeared → Made `POST /session` the first step of iteration
5. **Feedback loop unclear**: Sessions ended without iteration → Added explicit "wait for feedback" instruction with URL

### Files Changed
- `assets/harness-template.html` — iframe sandboxing, `buildIframeSrc()`, height sync, updated CSS
- `SKILL.md` — complete rewrite with available resources, workflow fixes, design principles
- `README.md` — updated architecture description
