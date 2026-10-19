# DocSlurp brand assets

<img src="docslurp-mark.svg" width="96" alt="DocSlurp mark">

The DocSlurp mark is a cup that is also a page: a folded corner, Markdown lines for contents and a straw. These files are DocSlurp trademarks; use them only as described in the [trademark policy](../../TRADEMARK.md). Use them unaltered.

## Files

| File | Use |
| --- | --- |
| `docslurp-mark.svg` | Primary mark, on light or dark backgrounds |
| `docslurp-mark-inverse.svg` | Mark for Slurp Blue or other saturated backgrounds |
| `docslurp-mark-mono.svg`, `docslurp-mark-mono-white.svg` | Single colour (Ink or white) for print, embossing and monochrome UI |
| `docslurp-lockup.svg` | Mark with the “DocSlurp” wordmark; the wordmark switches to Paper when the viewer prefers a dark colour scheme |
| `docslurp-lockup-dark.svg`, `docslurp-lockup-white.svg` | Fixed Ink or white wordmark, for when you know the background |
| `favicon.svg`, `favicon.ico`, `favicon-16.png`, `favicon-32.png` | Browser tab icons (`.ico` holds 16, 32 and 48 px) |
| `apple-touch-icon.png` | iOS home screen, 180 px |
| `icon-192.png`, `icon-512.png`, `docslurp-app-icon.svg` | App and PWA icons on a full-bleed blue square |
| `icon-maskable-512.png`, `docslurp-app-icon-maskable.svg` | PWA `maskable` icon, with the mark inside the 80% safe zone |
| `palette.json` | Brand colours |

On GitHub, where the page theme can differ from the system setting, pick the variant with `<picture>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/docslurp-lockup-white.svg">
  <img src="docs/brand/docslurp-lockup-dark.svg" height="64" alt="DocSlurp">
</picture>
```

The lockup sets the wordmark as live text in Inter (falling back to the system sans-serif), so it renders slightly differently where Inter is not installed. Outline the text before you use it in print.

## Palette

| Name | Hex | Role |
| --- | --- | --- |
| Slurp Blue | `#0284C7` | Cup, primary brand colour, app icon background |
| Sky | `#7DD3FC` | Folded corner |
| Mist | `#E0F2FE` | Body lines on the cup, light tints |
| Straw Orange | `#F97316` | Straw; use sparingly as the accent |
| Ink | `#0F172A` | Wordmark and text on light backgrounds |
| Paper | `#F8FAFC` | Light backgrounds |
| Deep Blue | `#075985` | Links and text in brand blue (meets 4.5:1 on white) |

## Usage

- Keep clear space around the mark of at least a quarter of its width.
- Do not use the mark below 16 px. Use the favicon files at small sizes; they are rasterized from the same artwork.
- Do not recolour, stretch, rotate, outline or add effects, and do not place the colour mark on busy images. Use a mono version instead.

## Regenerating

`generate.mjs` is the source of truth for the artwork. Edit it, then rebuild the SVGs and rasters (requires `rsvg-convert` and ImageMagick):

```sh
cd docs/brand
node generate.mjs
for n in 16 32 48; do rsvg-convert -w $n -h $n favicon.svg -o favicon-$n.png; done
magick favicon-16.png favicon-32.png favicon-48.png favicon.ico && rm favicon-48.png
rsvg-convert -w 180 -h 180 docslurp-app-icon.svg -o apple-touch-icon.png
rsvg-convert -w 192 -h 192 docslurp-app-icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 docslurp-app-icon.svg -o icon-512.png
rsvg-convert -w 512 -h 512 docslurp-app-icon-maskable.svg -o icon-maskable-512.png
```
