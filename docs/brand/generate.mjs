import fs from "node:fs";
import path from "node:path";

// Writes the DocSlurp brand SVGs next to this file. Raster exports: see README.md.
const out = import.meta.dirname;

const P = { blue: "#0284C7", sky: "#7DD3FC", mist: "#E0F2FE", orange: "#F97316", ink: "#0F172A", paper: "#F8FAFC", deep: "#075985" };
const STRAW = "M30 30l6-24a3 3 0 0 1 2.9-2.2H48";
const BODY = "M14 18h26l10 10-3.6 28.4a4 4 0 0 1-4 3.6H21.6a4 4 0 0 1-4-3.6z";
const FOLD = "M40 18v7a3 3 0 0 0 3 3h7z";
const H = `<rect x="21" y="32" width="18" height="5" rx="2.5"/>`;
const L = `<rect x="22" y="42" width="20" height="3.5" rx="1.75"/><rect x="23" y="49" width="13" height="3.5" rx="1.75"/>`;

const straw = (c) => `<path d="${STRAW}" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const color = (c) => `${straw(c.straw)}<path d="${BODY}" fill="${c.body}"/><path d="${FOLD}" fill="${c.fold}"/><g fill="${c.h}">${H}</g><g fill="${c.l}">${L}</g>`;
// Single colour: text lines are knocked out, the fold is split off by a hairline gap,
// and the straw stops short of the cup so the two shapes stay distinct.
const mono = (fill, id) =>
  `<defs><mask id="${id}s"><rect width="64" height="64" fill="#fff"/><path d="${BODY}" stroke="#000" stroke-width="5" stroke-linejoin="round"/></mask>` +
  `<mask id="${id}b"><rect width="64" height="64" fill="#fff"/><g fill="#000">${H}${L}</g><path d="M40 18v7a3 3 0 0 0 3 3h7" fill="none" stroke="#000" stroke-width="2.5"/></mask></defs>` +
  `<g mask="url(#${id}s)">${straw(fill)}</g><path d="${BODY}" fill="${fill}" mask="url(#${id}b)"/><path d="${FOLD}" fill="${fill}" mask="url(#${id}b)"/>`;
const svg = (inner, vb = "0 0 64 64") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${inner}</svg>\n`;

const primary = color({ straw: P.orange, body: P.blue, fold: P.sky, h: "#fff", l: P.mist });
const inverse = color({ straw: "#FDBA74", body: "#fff", fold: "#BAE6FD", h: P.blue, l: P.blue });
// Full-bleed blue square with the inverse mark scaled to `s` and centred.
const tile = (s) => {
  const o = (64 - 64 * s) / 2;
  return `<rect width="64" height="64" fill="${P.blue}"/><g transform="translate(${o} ${o}) scale(${s})">${inverse}</g>`;
};
const lock = (fg) =>
  `${primary}<text x="60" y="44" font-family="Inter, 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif" font-size="34" letter-spacing="-0.6" fill="${fg}"><tspan font-weight="500">Doc</tspan><tspan font-weight="800">Slurp</tspan></text>`;

const files = {
  "docslurp-mark.svg": svg(primary),
  "docslurp-mark-inverse.svg": svg(inverse),
  "docslurp-mark-mono.svg": svg(mono(P.ink, "m")),
  "docslurp-mark-mono-white.svg": svg(mono("#fff", "w")),
  "docslurp-app-icon.svg": svg(tile(0.78)),
  "docslurp-app-icon-maskable.svg": svg(tile(0.6)),
  "favicon.svg": svg(primary),
  "docslurp-lockup.svg": svg(lock(P.ink), "0 0 236 64"),
  "docslurp-lockup-white.svg": svg(lock("#fff"), "0 0 236 64"),
};
for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(out, f), s);
fs.writeFileSync(path.join(out, "palette.json"), `${JSON.stringify(P, null, 2)}\n`);
