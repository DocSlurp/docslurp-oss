// node cpuprof-top.mjs <file.cpuprofile> [n]: self and inclusive time by function, and self time by file.
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const N = Number(process.argv[3] ?? 40);
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = new Map(); p.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
const parent = new Map(); for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const key = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.replace(/^.*node_modules\/\.pnpm\/([^/]+)\/.*$/, "$1").replace(/^.*\/(server|packages|worker)\//, "$1/")}:${n.callFrame.lineNumber + 1}`;
const self = new Map(), incl = new Map(), file = new Map();
let total = 0;
for (const [id, t] of dt) {
  total += t; const n = byId.get(id); self.set(key(n), (self.get(key(n)) ?? 0) + t);
  const f = n.callFrame.url.replace(/^.*node_modules\/\.pnpm\/([^/]+)\/.*$/, "$1").replace(/^.*\/(server|packages|worker)\//, "$1/") || n.callFrame.functionName;
  file.set(f, (file.get(f) ?? 0) + t);
  const seen = new Set(); let cur = id; while (cur !== undefined) { const k = key(byId.get(cur)); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + t); } cur = parent.get(cur); }
}
const show = (m, title) => { console.log(`\n== ${title} (total ${(total / 1000).toFixed(0)} ms)`); [...m].sort((a, b) => b[1] - a[1]).slice(0, N).forEach(([k, v]) => console.log(`${(v / 1000).toFixed(0).padStart(7)} ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`)); };
show(self, "self"); show(file, "self by file"); show(incl, "inclusive");
