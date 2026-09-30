# Fragment and shared-file formats

Raw HTML fragments remain the simplest escape hatch. Reuse only what the decision holds fixed. Do not force fundamentally different page structures into a restrictive shared shell.

## Shared context

Write `exploration.json` in the exploration directory. Every field is optional:

```json
{
  "question": "Which grouping makes textbook appearances easiest to scan?",
  "state": "Matching evidence visible; expansion controls work",
  "approved": ["Use the approved front-page identity", "Curricula remain primary"],
  "avoid": ["Decorative bar charts"],
  "base": "shared/page.html",
  "styles": ["shared/product.css"],
  "data": "shared/evidence.json",
  "viewport": {"width": 1280, "height": 800}
}
```

Paths are relative files within this workspace, including after symlink resolution. Prepare fixed files once, preferably by copying the real product assets. Shared HTML lives under `shared/`, not beside the mockups. Styles are injected before variant CSS. The JSON fixture becomes `window.mockupData` in each isolated iframe. It is data, not automatically rendered content.

The viewport supplies an actual iframe width/height, including its internal scrolling; the reviewer can change width. Omit height for a long page that should grow to its full content height.

Raw `mockup-*.html` files also inherit shared styles/data, but do not use the shared base. This makes independent layouts easy without repeating their design tokens. A JSON variant's `html` similarly supplies a complete fragment body; it ignores the base and cannot be combined with `slots`.

## Region variants

Give the shared page named slots with sensible initial content:

```html
<header>Existing product header</header>
<main>
  <h1>Ludvig Holberg</h1>
  <section data-region="curricula">Existing curriculum evidence</section>
  <!--slot:readers--><p>Existing textbook presentation</p><!--/slot:readers-->
</main>
```

Write `mockup-by-work.json`:

```json
{
  "label": "Grouped by work",
  "slots": {
    "readers": "<section data-region=\"textbooks\"><h2>In textbooks</h2><div id=\"works\"></div></section>"
  },
  "css": "#works { display: grid; gap: 12px; }",
  "script": "/* Render the supplied fixture into the chosen grouping. */"
}
```

`label` is required. `slots`, `css`, `script`, `base`, and `html` are optional. A variant can override `base` with another relative page. Every replaced slot must occur exactly once; missing or duplicate names are reported rather than silently dropped. Slot names use lowercase letters, digits and hyphens, starting with a letter. Untouched slots retain their original content. Choose meaningful filenames rather than numbers or versions; do not create both `.html` and `.json` for one slug.

HTML, CSS and script strings are unrestricted design code. The example's render script is only illustrative: produce the working content or code for the actual task, with no placeholders. Native `<details>` and buttons with small scripts are often sufficient. `<dialog>` can be opened with `showModal()`; the harness closes `method="dialog"` forms locally, respecting validation, without enabling general form submission. JSON is optional; use raw HTML when escaping strings becomes cumbersome.

For palette, typography or spacing exploration on fixed markup, a variant can contain only `label` and `css`. CSS variables keep these changes compact when the product already uses them. For broader layout exploration, generate the HTML you need; shared styles and fixture data are still available.

Changes to shared files recompose affected variants and save new revisions. Establish shared material before the round's variants; later shared edits intentionally affect every variant that references it.

## Resources and assets

The harness supplies:

- Tailwind CSS JIT; inline `tailwind.config` can extend the theme.
- Google Fonts: Inter, DM Sans, Space Grotesk, Syne, Cormorant Garamond, EB Garamond, Crimson Pro, Playfair Display, Instrument Serif, JetBrains Mono, Space Mono. Import another font when it fits the product.
- Lucide: `<i data-lucide="search" class="w-5 h-5"></i>`.
- Border-box sizing, zero body margin and Inter fallback.

Images can use the product's full-resolution HTTPS URLs or data URIs. To reuse local assets, copy them under `shared/` and use a relative image source such as `<img src="shared/screenshot.png">`. The composer embeds these bytes automatically. Do not regenerate base64 image bytes through the model. Keep assets inside the workspace; project file paths do not load in the iframe.

Mockups run in `sandbox="allow-scripts"` without same-origin access. Feedback and persistence belong to the outer reviewer. Alt+arrow shortcuts work from inside a mockup without taking its ordinary arrow-key interactions. Optional `data-region` names improve anchored notes; no annotation is required for every element.
