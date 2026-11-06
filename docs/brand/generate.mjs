import fs from "node:fs";
import path from "node:path";

// Writes the DocSlurp brand SVGs next to this file. Raster exports: see README.md.
// The wordmark outlines in wordmark.json come from outline-wordmark.py.
const out = import.meta.dirname;
const word = JSON.parse(fs.readFileSync(path.join(out, "wordmark.json"), "utf8"));

const P = { paper: "#ECE7DB", crease: "#CFC7B4", ink: "#1A2130", slate: "#4A5568", straw: "#F97316", deck: "#0F151D" };
const STRAW = "M30 30l6-24a3 3 0 0 1 2.9-2.2H48";
const BODY = "M14 18h26l10 10-3.6 28.4a4 4 0 0 1-4 3.6H21.6a4 4 0 0 1-4-3.6z";
const FOLD = "M40 18v7a3 3 0 0 0 3 3h7z";
const H = `<rect x="21" y="32" width="18" height="5" rx="2.5"/>`;
const L = `<rect x="22" y="42" width="20" height="3.5" rx="1.75"/><rect x="23" y="49" width="13" height="3.5" rx="1.75"/>`;

// Paper cup for dark backgrounds, ink cup for light ones. The straw never changes.
const PAPER = { body: P.paper, fold: P.crease, text: P.ink };
const INK = { body: P.ink, fold: P.slate, text: P.paper };

const straw = (c, w = 4.5) => `<path d="${STRAW}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
// `strawWidth` is only raised for the favicon, where the 4.5 stroke drops to about one pixel.
const cup = (c, strawWidth) =>
  `${straw(P.straw, strawWidth)}<path class="b" d="${BODY}" fill="${c.body}"/><path class="f" d="${FOLD}" fill="${c.fold}"/><g class="t" fill="${c.text}">${H}${L}</g>`;
// Single colour: text lines are knocked out, the fold is split off by a hairline gap,
// and the straw stops short of the cup so the two shapes stay distinct.
const mono = (fill, id) =>
  `<defs><mask id="${id}s"><rect width="64" height="64" fill="#fff"/><path d="${BODY}" stroke="#000" stroke-width="5" stroke-linejoin="round"/></mask>` +
  `<mask id="${id}b"><rect width="64" height="64" fill="#fff"/><g fill="#000">${H}${L}</g><path d="M40 18v7a3 3 0 0 0 3 3h7" fill="none" stroke="#000" stroke-width="2.5"/></mask></defs>` +
  `<g mask="url(#${id}s)">${straw(fill)}</g><path d="${BODY}" fill="${fill}" mask="url(#${id}b)"/><path d="${FOLD}" fill="${fill}" mask="url(#${id}b)"/>`;
const svg = (inner, vb = "0 0 64 64") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${inner}</svg>\n`;

// Adaptive files follow the viewer's colour scheme, so they stay readable when
// shown via <img> or as a browser tab icon. Without media query support (most
// rasterizers) they fall back to the ink cup.
const adaptive =
  `<style>.b{fill:${P.ink}}.f{fill:${P.slate}}.t{fill:${P.paper}}.w{fill:${P.ink}}` +
  `@media (prefers-color-scheme:dark){.b{fill:${P.paper}}.f{fill:${P.crease}}.t{fill:${P.ink}}.w{fill:${P.paper}}}</style>`;

// Dark rounded or full-bleed square with the paper cup scaled to `s` and centred.
const tile = (s, r = 0, strawWidth) => {
  const o = (64 - 64 * s) / 2;
  return `<rect width="64" height="64" rx="${r}" fill="${P.deck}"/><g transform="translate(${o} ${o}) scale(${s})">${cup(PAPER, strawWidth)}</g>`;
};

// Product listing images (store and agent catalogs): the mark with generous clear space.
// Plans use the paper cup on Deck, credit packs the ink cup on Paper, so the two read apart.
const product = (bg, c) => `<rect width="64" height="64" fill="${bg}"/><g transform="translate(12.8 12.8) scale(0.6)">${cup(c)}</g>`;

// Wordmark: "Doc" in Schibsted Grotesk 500, "Slurp" in 800, outlined so it renders
// identically everywhere.
const WX = 62;
const WY = 44;
const LOCK_VB = `0 0 ${Math.ceil(WX + word.width + 2)} 64`;
const wordmark = (fill) =>
  `<g class="w" transform="translate(${WX} ${WY})"${fill ? ` fill="${fill}"` : ""}><path d="${word.doc}"/><path d="${word.slurp}"/></g>`;
const lock = (c, fill) => `${cup(c)}${wordmark(fill)}`;

// The primary icon: the paper cup inside the 80% maskable safe zone on a full-bleed
// Deck square. App, PWA and plugin artwork use it.
const primary = svg(tile(0.6));
// Browser tabs show the icon at 16-32 px and never mask it, so the favicon fills a rounded
// tile with a heavier straw instead of sitting inside the maskable safe zone.
const favicon = svg(tile(0.96, 14, 6));

const files = {
  "docslurp-mark.svg": svg(adaptive + cup(INK)),
  "docslurp-mark-dark.svg": svg(cup(INK)),
  "docslurp-mark-inverse.svg": svg(cup(PAPER)),
  "docslurp-mark-mono.svg": svg(mono(P.ink, "m")),
  "docslurp-mark-mono-white.svg": svg(mono("#fff", "w")),
  "docslurp-app-icon.svg": primary,
  "docslurp-app-icon-rounded.svg": svg(tile(0.92, 14)),
  "docslurp-app-icon-maskable.svg": primary,
  "docslurp-product-plan.svg": svg(product(P.deck, PAPER)),
  "docslurp-product-credits.svg": svg(product(P.paper, INK)),
  "favicon.svg": favicon,
  "docslurp-lockup.svg": svg(adaptive + lock(INK), LOCK_VB),
  "docslurp-lockup-dark.svg": svg(lock(INK, P.ink), LOCK_VB),
  "docslurp-lockup-white.svg": svg(lock(PAPER, "#fff"), LOCK_VB),
};
for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(out, f), s);
fs.writeFileSync(path.join(out, "palette.json"), `${JSON.stringify(P, null, 2)}\n`);
