import { VISUAL_SPEC_LIMITS } from "@docslurp/shared/chart-export";

/**
 * Labels from customer files are data: strip control and bidi-override characters, collapse whitespace and cap the
 * length. Markup-looking text stays as literal characters; renderers escape for their own target.
 */
export function cleanLabel(value: unknown, max: number = VISUAL_SPEC_LIMITS.maxLabelChars): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  // Cut before any regex or copy: the cost is O(max), not O(input) (council r6 H1). 4 code units per kept character
  // leaves room for the stripped controls and collapsed whitespace of any real label.
  const raw = String(value);
  const s = (raw.length > 4 * max ? raw.slice(0, 4 * max) : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...s].slice(0, max).join("");
}

export function cleanLabelOrNull(value: unknown): string | null {
  const s = cleanLabel(value);
  return s === "" ? null : s;
}

/** Finite number or null (NaN, ±Infinity, empty and non-numeric strings are null). */
export function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // No finite number needs this many characters; the cap and the unambiguous pattern (same language as
  // /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/, which split a digit run every possible way) keep this O(n) (council r8 H1).
  if (value.length > 512) return null;
  const t = value.trim();
  if (t === "" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

const SUFFIX: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, G: 1e9, T: 1e12, m: 1e-3, "µ": 1e-6, u: 1e-6, n: 1e-9 };

/**
 * A tick label as a number: thousands separators, unicode minus, currency prefixes, a `%` suffix, SI suffixes (k, M, B)
 * and `10^n` / `1e3` forms. Returns null for anything else (category text).
 */
export function parseTickNumber(raw: string): { value: number; unit: string | null } | null {
  let t = raw.replace(/[−‒–—﹣－]/g, "-").replace(/ | | /g, " ").trim();
  if (t === "" || t.length > 32) return null;
  let unit: string | null = null;
  const cur = /^([-+]?)\s*([$€£¥₹])\s*/.exec(t);
  if (cur) { unit = cur[2]!; t = cur[1]! + t.slice(cur[0].length); }
  if (t.endsWith("%")) { unit = "%"; t = t.slice(0, -1).trim(); }
  const SUP: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-" };
  t = t.replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)$/, (_m, sup: string) => `10^${[...sup].map((c) => SUP[c]).join("")}`);
  const pow = /^([-+]?\d+(?:\.\d+)?)\s*[x×·]\s*10\^\{?([-+]?\d+)\}?$/.exec(t) ?? /^10\^\{?([-+]?\d+)\}?$/.exec(t);
  if (pow) {
    const v = pow.length === 3 ? Number(pow[1]) * 10 ** Number(pow[2]) : 10 ** Number(pow[1]);
    return Number.isFinite(v) ? { value: v, unit } : null;
  }
  let mult = 1;
  const suf = /^(.*?\d)\s*([kKMBGTmµun])$/.exec(t);
  if (suf) { mult = SUFFIX[suf[2]!]!; t = suf[1]!; }
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  const v = finiteOrNull(t);
  if (v === null) return null;
  const out = v * mult;
  return Number.isFinite(out) ? { value: out, unit } : null;
}

/** Normalise a CSS/SVG colour to `#rrggbb` (or null for none/transparent/url()). */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // No real colour is longer than this; the rgb() regex below backtracks quadratically on long hostile values.
  if (raw.length > 64) return null;
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "none" || t === "transparent" || t.startsWith("url(")) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (hex) {
    const h = hex[1]!;
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(t);
  if (rgb) {
    if (rgb[4] !== undefined && Number.parseFloat(rgb[4]) === 0) return null;
    const c = [rgb[1], rgb[2], rgb[3]].map((x) => Math.max(0, Math.min(255, Math.round(Number(x)))));
    return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  const named: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", gray: "#808080", grey: "#808080", orange: "#ffa500", purple: "#800080", steelblue: "#4682b4" };
  return named[t] ?? (/^[a-z]{3,20}$/.test(t) ? t : null);
}
