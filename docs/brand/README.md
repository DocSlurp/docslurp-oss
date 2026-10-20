# DocSlurp brand assets

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docslurp-lockup-white.svg">
  <img src="docslurp-lockup-dark.svg" height="64" alt="DocSlurp">
</picture>

The DocSlurp mark is a cup that is also a page: a folded corner, Markdown lines for contents and an orange straw. The cup is paper on dark backgrounds and ink on light ones; the straw is always Straw Orange. These files are DocSlurp trademarks; use them only as described in the [trademark policy](../../TRADEMARK.md). Use them unaltered.

## Files

| File | Use |
| --- | --- |
| `docslurp-mark.svg` | Primary mark. Follows the viewer's colour scheme: ink cup on light, paper cup on dark |
| `docslurp-mark-dark.svg` | Fixed ink cup, for light backgrounds |
| `docslurp-mark-inverse.svg` | Fixed paper cup, for dark backgrounds |
| `docslurp-mark-mono.svg`, `docslurp-mark-mono-white.svg` | Single colour (Ink or white) for print, embossing and monochrome UI |
| `docslurp-lockup.svg` | Mark with the “DocSlurp” wordmark; follows the viewer's colour scheme like the mark |
| `docslurp-lockup-dark.svg`, `docslurp-lockup-white.svg` | Fixed ink or paper-and-white lockup, for when you know the background |
| `favicon.svg` | Browser tab icon; follows the browser's colour scheme |
| `favicon.ico`, `favicon-16.png`, `favicon-32.png` | Raster tab icons (`.ico` holds 16, 32 and 48 px), drawn from the rounded app icon so they read on light and dark tab strips |
| `apple-touch-icon.png` | iOS home screen, 180 px |
| `icon-192.png`, `icon-512.png`, `docslurp-app-icon.svg` | App and PWA icons: the paper cup on a full-bleed Deck square |
| `docslurp-app-icon-rounded.svg` | The same icon with rounded corners, for avatars and the raster favicons |
| `icon-maskable-512.png`, `docslurp-app-icon-maskable.svg` | PWA `maskable` icon, with the mark inside the 80% safe zone |
| `palette.json` | Brand colours |

On GitHub, where the page theme can differ from the system setting, pick the variant with `<picture>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/docslurp-lockup-white.svg">
  <img src="docs/brand/docslurp-lockup-dark.svg" height="64" alt="DocSlurp">
</picture>
```

The wordmark is “Doc” in Schibsted Grotesk Medium and “Slurp” in Schibsted Grotesk ExtraBold, outlined, so the lockups render identically everywhere and are print-ready. Schibsted Grotesk is licensed under the SIL Open Font License 1.1.

## Palette

| Name | Hex | Role |
| --- | --- | --- |
| Paper | `#ECE7DB` | Cup on dark backgrounds; the product's cited-page surface |
| Crease | `#CFC7B4` | Folded corner on the paper cup |
| Ink | `#1A2130` | Cup on light backgrounds, Markdown lines on the paper cup, wordmark on light |
| Slate | `#4A5568` | Folded corner on the ink cup |
| Straw Orange | `#F97316` | Straw; use sparingly as the accent |
| Deck | `#0F151D` | App icon background, dark surfaces |

## Usage

- Keep clear space around the mark of at least a quarter of its width.
- Do not use the mark below 16 px. Use the favicon files at small sizes; they are rasterized from the same artwork.
- Do not recolour, stretch, rotate, outline or add effects, and do not place the colour mark on busy images. Use a mono version instead.

## Regenerating

`generate.mjs` is the source of truth for the artwork. Edit it, then rebuild the SVGs and rasters (requires `rsvg-convert` and ImageMagick):

```sh
cd docs/brand
node generate.mjs
for n in 16 32 48; do rsvg-convert -w $n -h $n docslurp-app-icon-rounded.svg -o favicon-$n.png; done
magick favicon-16.png favicon-32.png favicon-48.png favicon.ico && rm favicon-48.png
rsvg-convert -w 180 -h 180 docslurp-app-icon.svg -o apple-touch-icon.png
rsvg-convert -w 192 -h 192 docslurp-app-icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 docslurp-app-icon.svg -o icon-512.png
rsvg-convert -w 512 -h 512 docslurp-app-icon-maskable.svg -o icon-maskable-512.png
```

To change the wordmark, re-outline it with `outline-wordmark.py` (needs Python with `fonttools`, `brotli` and `uharfbuzz`) from the variable Schibsted Grotesk font in `@fontsource-variable/schibsted-grotesk`:

```sh
python outline-wordmark.py path/to/schibsted-grotesk-latin-wght-normal.woff2 > wordmark.json
```
