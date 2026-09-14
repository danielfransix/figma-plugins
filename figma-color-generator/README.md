# Color Generator — Figma Plugin

Give the plugin a hex color, name it, and hit Generate. It builds a full 13-shade palette and saves all the shades as color variables in your Figma file.

The shades are generated using the OKLCH color space — the same approach as the Tailwind CSS color generator — so the palette looks balanced from lightest to darkest.

---

## What it does

- Uses your hex color as the middle shade (500) and generates 13 shades from 50 to 1100
- Saves all shades as **color variables** inside a named folder in a variable collection
- Adds a **swatch frame** to your canvas so you can see the full palette at a glance
- Supports **multiple colors in one run**

---

## How to install

1. In Figma, go to **Plugins → Browse plugins in Community**
2. Search for **Color Generator** by Daniel Fransix
3. Click **Run**

> To load it locally: go to **Plugins → Development → Import plugin from manifest** and select the `manifest.json` file from this folder.

---

## How to use

### Create a palette

1. Open the plugin via **Plugins → Color Generator**
2. Under **Collection**, select an existing variable collection or choose **+ Create new collection** and type a name
3. Click the color swatch or type a hex value (e.g. `7655FD`) to set your color
4. Type a folder name — this is what the variable folder will be called in Figma (e.g. `Purple`)
5. Click **Generate**

You'll get 13 color variables (`Purple/50`, `Purple/100` … `Purple/1100`) and a swatch frame on your canvas.

---

### Generate multiple palettes at once

Click **+ Add color** to add another row. Each row is its own color with its own hex value and folder name. Hit Generate once and all of them are created together.

Example:

| Hex | Folder name |
|-----|-------------|
| `7655FD` | Purple |
| `2ECC71` | Emerald |
| `FF5A5A` | Coral |

This creates three variable folders and three swatch frames on the canvas, side by side.

---

### Add a palette to an existing collection

1. Select your collection from the dropdown — it lists all collections in your current file
2. If the collection already has folders, an **Inside folder** dropdown will appear. Use it to nest the new palette inside an existing folder, or leave it set to root
3. Add your colors and click **Generate**

---

## Ways to use it

**Setting up a design system**
Add a row for each brand color, create a new collection, and generate everything in one go. All your color variables are ready to use straight away.

**Adding a color to an existing design system**
Select your existing collection, add the new color, and generate. Nothing already in the collection will be changed.

**Exploring palette options**
Type in a few hex values and generate. The swatch frames on the canvas let you compare palettes side by side before you commit to anything.

**Matching Tailwind CSS colors**
The shades this plugin generates align with Tailwind's color palette numbering. If your project uses Tailwind, the same hex values will produce matching shade weights.

---

## Shade scale

| Shade | |
|-------|-|
| 50 | Lightest |
| 100 | |
| 200 | |
| 300 | |
| 400 | |
| **500** | **Your input color** |
| 600 | |
| 700 | |
| 800 | |
| 900 | |
| 950 | |
| 1000 | |
| 1100 | Darkest |

---

## Errors

- **Same folder name used twice in one run** — the plugin stops and shows an error before creating anything
- **Folder already exists in the collection** — the plugin stops and shows an error. Existing variables are never overwritten
- **Invalid hex value** — the input turns red and the Generate button stays disabled until it's corrected

---

## Notes

- Variables are always written to the default mode of the collection
- Swatch frames are placed on whichever page is currently open
- The plugin cannot edit or delete variables that already exist
- Only works in Figma design files — not FigJam

---

## Author

Made by **Daniel Fransix** — [x.com/danielfransix](https://x.com/danielfransix)

If this saves you time, [buy me a coffee ☕](https://danielfransix.short.gy/buy-coffee)
