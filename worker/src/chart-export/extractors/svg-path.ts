import { CHART_EXTRACT_LIMITS, ExtractLimitError } from "./limits.js";

/** Affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Parse an SVG `transform` list. Unknown functions make the whole transform invalid (null). */
export function parseTransform(raw: string | undefined | null): Matrix | null {
  if (!raw) return IDENTITY;
  if (raw.length > 4096) return null;
  let m: Matrix = IDENTITY;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let consumed = 0;
  for (const part of raw.matchAll(re)) {
    consumed += part[0].length;
    const args = (part[2]!.match(NUM) ?? []).map(Number);
    if (args.some((a) => !Number.isFinite(a))) return null;
    let t: Matrix;
    switch (part[1]) {
      case "matrix": if (args.length !== 6) return null; t = args as unknown as Matrix; break;
      case "translate": t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]; break;
      case "scale": t = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const r = ((args[0] ?? 0) * Math.PI) / 180;
        const [cx, cy] = [args[1] ?? 0, args[2] ?? 0];
        t = multiply(multiply([1, 0, 0, 1, cx, cy], [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX": t = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": t = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      default: return null;
    }
    m = multiply(m, t);
  }
  if (consumed === 0 && raw.trim() !== "") return null;
  return m;
}

export interface Subpath {
  points: Array<[number, number]>;
  closed: boolean;
  /** Curve / arc segments (only their end points are kept). */
  curves: number;
}

export interface PathBudget { commands: number }
export const newPathBudget = (): PathBudget => ({ commands: 0 });

/** Parse path data into absolute (untransformed) subpaths. Curves keep their end points; work is charged to `budget`. */
export function parsePathData(d: string, budget: PathBudget): Subpath[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  budget.commands += tokens.length;
  if (budget.commands > CHART_EXTRACT_LIMITS.maxPathCommands * 7) throw new ExtractLimitError("svg-path-command-limit");
  const out: Subpath[] = [];
  let cur: Subpath | null = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let cmd = "";
  let i = 0;
  const num = (): number => {
    const t = tokens[i++];
    const v = t === undefined ? NaN : Number(t);
    if (!Number.isFinite(v)) throw new ExtractLimitError("svg-path-bad-number");
    return v;
  };
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]!);
  const push = (px: number, py: number) => {
    if (!cur) { cur = { points: [[x, y]], closed: false, curves: 0 }; out.push(cur); }
    if (cur.points.length >= CHART_EXTRACT_LIMITS.maxPathVertices) throw new ExtractLimitError("svg-path-vertex-limit");
    cur.points.push([px, py]);
  };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (!cmd) throw new ExtractLimitError("svg-path-bad-command");
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        x = ox + num(); y = oy + num();
        cur = { points: [[x, y]], closed: false, curves: 0 };
        out.push(cur);
        sx = x; sy = y;
        cmd = rel ? "l" : "L";
        break;
      }
      case "L": x = ox + num(); y = oy + num(); push(x, y); break;
      case "H": x = ox + num(); push(x, y); break;
      case "V": y = oy + num(); push(x, y); break;
      case "C": num(); num(); num(); num(); x = ox + num(); y = oy + num(); push(x, y); cur!.curves++; break;
      case "S": case "Q": num(); num(); x = ox + num(); y = oy + num(); push(x, y); cur!.curves++; break;
      case "T": x = ox + num(); y = oy + num(); push(x, y); cur!.curves++; break;
      case "A": num(); num(); num(); num(); num(); x = ox + num(); y = oy + num(); push(x, y); cur!.curves++; break;
      case "Z":
        if (cur) cur.closed = true;
        x = sx; y = sy;
        cur = null;
        if (isNum()) throw new ExtractLimitError("svg-path-bad-command");
        continue;
      default: throw new ExtractLimitError("svg-path-bad-command");
    }
    if (!isNum() && i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]!)) throw new ExtractLimitError("svg-path-bad-command");
  }
  return out;
}
