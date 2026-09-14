# Component Collector

A Figma plugin that scans every page in your file and gathers all local master components onto a single dedicated page — keeping your component library clean and centralized.

---

## What it does

1. **Scans all pages** for local master components and component sets (library/remote components are ignored).
2. **Creates a collection page** named `[component-collector]` (or reuses it on subsequent runs).
3. **Places everything** into a vertical auto-layout frame called `Components` on that page.
4. **Replaces in-place** — if a component is embedded inside a design (not already at the page/section level), it leaves behind an instance at the exact same position before moving the master.

---

## Options

**Filter by width** — optionally skip components outside a min/max pixel width range. Useful for targeting specific breakpoints or ignoring tiny utility components.

---

## Installation

1. In Figma, open the **Plugins** menu → **Development** → **Import plugin from manifest…**
2. Select the `manifest.json` file inside the `component-collector/` folder.
3. The plugin will appear under **Plugins → Development** in any Figma file.

---

## Usage

1. Run the plugin in any Figma file.
2. Optionally enable **Filter by width** and set a min/max range.
3. Click **Collect Components**.
4. The plugin scans page by page and reports live progress.
5. When done, a summary shows how many components were collected, replaced with instances, or skipped.

---

## Notes

- Variant components (members of a component set) are handled through their parent set — they are not moved individually.
- Running the plugin multiple times is safe; the collection page and container frame are reused.
- Only local components are collected. Linked library components are left untouched.

---

Made by [Daniel Fransix](https://x.com/danielfransix)
