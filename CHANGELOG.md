# Changelog

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
