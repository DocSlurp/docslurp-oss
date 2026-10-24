import { readFileSync } from "node:fs";
import { rerankBM25 } from "../../src/search/rerank.js";
import { execFileSync } from "node:child_process";
// Old implementation loaded from git for A/B on identical inputs.
const oldSrc = execFileSync("git", ["show", process.argv[3]! + ":server/src/search/rerank.ts"]).toString();
const path = process.env.TMPDIR + "/rerank-old-mod.ts"; (await import("node:fs")).writeFileSync(path, oldSrc);
const { rerankBM25: oldRerank } = await import(path);
const OUT = process.argv[2]!;
const qs = JSON.parse(readFileSync(`${OUT}/queries-dev.json`, "utf8")).slice(0, 60);
const text = readFileSync("/home/dan/worktrees/docslurp-oss/perf-search/README.md", "utf8");
const pool = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: text.slice((i * 137) % 3000, ((i * 137) % 3000) + 900), score: 1 }));
for (const n of [20, 100, 200]) {
  const chunks = pool(n);
  for (const [name, fn] of [["old", oldRerank], ["new", rerankBM25]] as const) {
    for (let w = 0; w < 5; w++) fn(qs[w].q, chunks);
    const c0 = process.cpuUsage(); for (const q of qs) fn(q.q, chunks); const c = process.cpuUsage(c0);
    console.log(`pool=${n} ${name} cpu ms/call ${((c.user + c.system) / 1000 / qs.length).toFixed(2)}`);
  }
}
