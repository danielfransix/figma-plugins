# Figma Plugins — Shared Design System

**Purpose:** a single reference for every plugin in this repo (`figma-linter`, `figma-selector`, `figma-relinker`, `figma-bulk-style-manipulator`, `figma-color-generator`, `figma-component-collector`, `instance-resetter`, `figma-arrow-manager`) so they look and feel like one native Figma surface, and so a new plugin can be started from a consistent baseline.

**How to use this:** plugins are self-contained (`manifest.json` + `code.js` + `ui.html`, no build step, no cross-plugin imports — Figma loads each folder independently). This is a copy-paste reference, not a runtime dependency. Copy `components.css`'s token block and whichever components you need into your plugin's `<style>` tag.

---

## 0. Dead end, confirmed — do not use Figma's `fig-*` tags

Figma's internal UI kit markup (`fig-content`, `fig-group`, `fig-field`, `fig-button`, `fig-switch`, `fig-input-color`, `fig-slider`, `fig-footer`, sometimes called "PropsKit") shows up in AI-plugin-generation output and in files exported from that surface, styled and fully functional. **It does not work in a normally-installed, normally-loaded plugin.** Confirmed by shipping it in `figma-arrow-manager`: every `fig-*` tag rendered as a bare, unstyled anonymous inline element — no button chrome, no switch, no divider, no color picker, no slider — even though the JS underneath (event listeners, `postMessage` wiring) worked fine. The custom elements themselves are simply never registered in a real plugin iframe; they're an artifact of Figma's own internal generation/preview tooling, not a documented or generally-available part of the Plugin API.

This is the second time this exact trap has bitten this repo — see `figma-arrow-manager/PLAN.md`'s changelog for the first (an MCP-mediated `use_figma` call let `connectorNode.clone()` succeed when a real installed plugin throws on it). **The pattern to internalize: anything observed only through Figma's AI-assisted tooling (MCP calls, AI-generated plugin previews) needs to be re-verified in a real, manually-installed plugin before it's trusted as a building block.** Don't reach for `fig-*` tags again without that re-verification, and don't trust a "it worked when Figma's AI generated it" result for anything else either.

Build all interactive controls (buttons, switches, sliders, color inputs) as plain HTML + CSS per Section 4 below instead.

---

## 1. Core rule: match Figma's real theme, not a guess

Every color is an alias to Figma's own injected `--figma-color-*` CSS variable:

```js
// code.js
figma.showUI(__html__, { width: 360, height: 480, title: "My Plugin", themeColors: true });
```

```css
/* ui.html */
:root {
  --color-bg: var(--figma-color-bg, #2c2c2c); /* fallback only, rarely used */
  ...
}
```

This makes the plugin automatically match whatever theme (light or dark) the user's actual Figma is running — not a fixed dark palette we picked. Confirmed working end-to-end in `figma-arrow-manager`. See `components.css` for the full token block.

**Why not keep each plugin's own hand-picked accent color?** Several plugins previously used a distinct accent (orange, purple, amber, green) so they'd be recognizable at a glance. Under this system, plugin identity comes from its name/icon in the Figma plugin menu and its window title — not a custom hue in the panel chrome — so every plugin shares Figma's own brand blue (`--figma-color-bg-brand`) for primary actions.

## 2. Typography

- **Body/headers:** `Plus Jakarta Sans` (weights 400/500/600/700), loaded from Google Fonts.
- **Log/code text only:** `JetBrains Mono`.
- **Exactly 2 font sizes, everywhere:** a title size and a body size (see `--font-title-size` / `--font-body-size` in `components.css`, 12px/11px). Do not introduce a third size — status text, buttons, chips, log entries all use the body size.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
```

## 3. Spacing & shape

- Border radius: 4px (small controls like color swatches), 6px (buttons, inputs, boxes), 999px (pills, toggle track).
- Section padding: `10px 16px 12px`. Container padding: `12px 16px 6px` for headers.
- No italics anywhere in plugin UI.

## 4. Component catalog

All of these are in `components.css`, ready to paste. Class names are consistent across plugins so a developer moving between them recognizes the pattern immediately. All of them are plain HTML + CSS — see Section 0 for why `fig-*` tags are off the table.

| Component | Class(es) | Notes |
|---|---|---|
| Primary button | `.btn-primary` | Solid brand fill, disabled state at 0.4 opacity |
| Secondary button | `.btn-secondary` | Outlined, transparent background |
| Danger button | `.btn-secondary.btn-danger` | For destructive actions |
| Toggle switch | `.switch` / `.switch-track` / `.switch-thumb` | Real `<input type="checkbox">` under the hood — accessible, no custom ARIA needed |
| Chip group | `.chip-group` / `.chip` / `.chip.active` | Single or multi-select filters |
| Status/feedback box | `.status-box` / `.ready` / `.warn` | Inline state feedback, replaces ad-hoc toasts where possible |
| Progress bar | `.progress-bar` / `.progress-bar-fill` | Set `.progress-bar-fill`'s `width` from JS |
| Step indicator | `.steps` / `.step.active` / `.step.done` | For multi-step wizards (see `figma-relinker`) |
| Section label | `.section-label` | Small uppercase heading above a group of controls |
| Brand footer | `.brand-footer` / `.brand-link` | Plugin name · version · links, consistent across all plugins |
| **Log panel** | `.log-section` / `.log-list` / `.log-entry` | See below — this is the newest, most important addition |
| Color input | native `<input type="color">`, styled `.color-input` | A real browser color input — no Figma-native picker is reachable from a plugin iframe |
| Range slider | native `<input type="range">`, styled `.weight-slider` + a synced numeric `<span>`/`<input>` | Pair with a JS `input` listener to mirror the value into a visible number |

Two components are distinctive enough to be worth lifting wholesale from where they were pioneered rather than re-described here — go read the source directly:
- **Custom dropdown/select** (positions itself, flips up when out of space, icon + label rows) — `figma-selector/ui.html`, search for `.select-trigger`/`.select-dropdown`.
- **Inline search-picker under a row** (for "no match, pick one manually" flows) — `figma-relinker/ui.html`, search for `.inline-picker`.

## 5. Log Panel — the standard activity/error log

Every plugin should surface what it did and any errors in one place, with a one-click copy button. This replaces silent `figma.notify()`-only feedback and gives users something they can paste into a bug report.

### HTML (place near the end of the panel, above or below a brand footer)

```html
<div class="log-section">
  <div class="log-header">
    <span class="section-label">Log</span>
    <button type="button" class="copy-btn" id="copy-log-btn">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="4" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.1"/>
        <path d="M2.5 8V2.5C2.5 1.94772 2.94772 1.5 3.5 1.5H8" stroke="currentColor" stroke-width="1.1"/>
      </svg>
      <span id="copy-log-label">Copy</span>
    </button>
  </div>
  <div class="log-list" id="log-list">
    <div class="log-empty">No actions yet.</div>
  </div>
</div>
```

### JS (ui.html `<script>`)

```js
var logList = document.getElementById('log-list');
var copyLogBtn = document.getElementById('copy-log-btn');
var copyLogLabel = document.getElementById('copy-log-label');
var logEntries = []; // { time, level, message }

copyLogBtn.addEventListener('click', copyLogs);

// Merge into your existing window.onmessage handler:
// if (msg.type === 'log') addLogEntry(msg);

function addLogEntry(entry) {
  logEntries.push(entry);
  var row = document.createElement('div');
  row.className = 'log-entry' + (entry.level === 'error' ? ' error' : '');
  var timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = entry.time;
  row.appendChild(timeSpan);
  row.appendChild(document.createTextNode(entry.message));
  if (logList.querySelector('.log-empty')) logList.innerHTML = '';
  logList.appendChild(row);
  logList.scrollTop = logList.scrollHeight;
}

function copyLogs() {
  var text = logEntries.length
    ? logEntries.map(function (e) { return '[' + e.time + '] ' + (e.level === 'error' ? 'ERROR: ' : '') + e.message; }).join('\n')
    : 'No actions yet.';
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy'); // more reliable than navigator.clipboard inside Figma's plugin iframe sandbox
    copyLogLabel.textContent = 'Copied';
    copyLogBtn.classList.add('copied');
    setTimeout(function () { copyLogLabel.textContent = 'Copy'; copyLogBtn.classList.remove('copied'); }, 1200);
  } catch (e) {
    copyLogLabel.textContent = 'Failed';
  }
  document.body.removeChild(ta);
}
```

### code.js contract

```js
function log(level, message) {
  figma.ui.postMessage({ type: 'log', level, message, time: formatTime() });
}
function formatTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

Call `log('info', ...)` or `log('error', ...)` at every point the plugin already calls `figma.notify(...)` or posts a result/toast message to the UI — mirror the same text so the log is a complete history of what the toast stream showed.

## 6. Per-plugin status

| Plugin | themeColors | Font | Log panel |
|---|---|---|---|
| figma-arrow-manager | ✅ | Plus Jakarta Sans / JetBrains Mono | ✅ (pioneered here) |
| figma-linter | migrated | migrated | added |
| figma-selector | migrated | migrated | added |
| figma-relinker | migrated | migrated | added |
| figma-bulk-style-manipulator | migrated | migrated | added |
| figma-color-generator | migrated | migrated | added |
| figma-component-collector | migrated | migrated | added, alongside its existing `.diag-log` panel |
| instance-resetter | migrated | migrated | added |

Origin note: the standard Log Panel format was inspired by `figma-component-collector`'s pre-existing `.diag-log` diagnostics panel — but that panel is purpose-built for a specific perf-debugging workflow (yield-throttling method, slow-yield timing, window focus state) and was kept as-is rather than merged, since it isn't a general activity/error log. The new standard Log Panel was added there as a separate section for the general "what did this run do, what errored" history every other plugin now has.
