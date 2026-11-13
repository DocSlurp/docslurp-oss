// node identity.mjs <a.json> <b.json>: per-query result id lists identical?
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => new Map(JSON.parse(readFileSync(f, "utf8")).runs.map((r) => [r.id, r.ids.join(",")])));
let same = 0, diff = 0; for (const [id, ids] of a) { if (!b.has(id)) continue; if (b.get(id) === ids) same++; else diff++; }
console.log(`identical=${same} different=${diff}`);
