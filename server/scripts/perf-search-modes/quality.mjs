// node quality.mjs <corpus queries json> <run.json...>: recall@10 (chunk), doc recall@10, MRR, mean results per query.
import { readFileSync } from "node:fs";
const [qfile, ...runs] = process.argv.slice(2);
const byId = new Map(JSON.parse(readFileSync(qfile, "utf8")).map((q) => [q.id, q]));
for (const f of runs) {
  const r = JSON.parse(readFileSync(f, "utf8"));
  let hit = 0, dhit = 0, mrr = 0, n = 0, len = 0;
  for (const x of r.runs) { const q = byId.get(x.id); if (!q) continue; n++; len += x.ids.length;
    const k = x.ids.findIndex((id) => id === q.chunkId || String(id).endsWith(q.chunkId)); const dk = x.docs.indexOf(q.documentId);
    if (k >= 0) { hit++; mrr += 1 / (k + 1); } if (dk >= 0) dhit++; }
  console.log(f.split("/").pop(), `n=${n} chunkR@10=${(hit / n).toFixed(3)} docR@10=${(dhit / n).toFixed(3)} MRR=${(mrr / n).toFixed(3)} results/q=${(len / n).toFixed(1)}`);
}
