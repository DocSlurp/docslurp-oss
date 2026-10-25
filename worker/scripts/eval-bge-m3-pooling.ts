/**
 * Retrieval quality of bge-m3 dense pooling choices on a BEIR dataset:
 * local transformers.js (production dtype) with mean and CLS pooling from one
 * forward pass, and DeepInfra BAAI/bge-m3 (hosted, CLS). Reports nDCG@10,
 * Recall@10/100 and MRR@10 on the test qrels.
 * Usage: DEEPINFRA_API_KEY=... tsx scripts/eval-bge-m3-pooling.ts <beir-dir> <out.json> [--no-hosted]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AutoModel, AutoTokenizer } from "@huggingface/transformers";
import { resolveLocalTransformersJsDtype } from "../src/stages/embedding-runtime.js";

const [dir, out] = [process.argv[2]!, process.argv[3]!];
const hostedOn = !process.argv.includes("--no-hosted");
const readJsonl = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const corpus = readJsonl(join(dir, "corpus.jsonl")) as Array<{ _id: string; title?: string; text: string }>;
const qrels = new Map<string, Map<string, number>>();
for (const line of readFileSync(join(dir, "qrels", "test.tsv"), "utf8").split("\n").slice(1).filter(Boolean)) {
  const [qid, did, score] = line.split("\t");
  if (Number(score) <= 0) continue;
  if (!qrels.has(qid!)) qrels.set(qid!, new Map());
  qrels.get(qid!)!.set(did!, Number(score));
}
const queries = (readJsonl(join(dir, "queries.jsonl")) as Array<{ _id: string; text: string }>).filter((q) => qrels.has(q._id));
const docTexts = corpus.map((d) => `${d.title ? `${d.title} ` : ""}${d.text}`.trim());

const dtype = resolveLocalTransformersJsDtype();
const cache_dir = join(homedir(), ".cache", "docslurp", "transformers");
const tokenizer = await AutoTokenizer.from_pretrained("Xenova/bge-m3", { cache_dir });
const model = await AutoModel.from_pretrained("Xenova/bge-m3", { dtype: dtype as never, cache_dir });

const normalize = (v: Float32Array) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
async function localBoth(texts: string[], batch = 16) {
  const mean: Float32Array[] = []; const cls: Float32Array[] = [];
  const started = performance.now();
  for (let i = 0; i < texts.length; i += batch) {
    const inputs = await tokenizer(texts.slice(i, i + batch), { padding: true, truncation: true, max_length: 512 });
    const { last_hidden_state } = await model(inputs);
    const [b, t, h] = last_hidden_state.dims as [number, number, number];
    const data = last_hidden_state.data as Float32Array;
    const mask = inputs.attention_mask.data as BigInt64Array;
    for (let row = 0; row < b; row++) {
      const c = new Float32Array(h); const m = new Float32Array(h); let count = 0;
      for (let k = 0; k < h; k++) c[k] = data[row * t * h + k]!;
      for (let tok = 0; tok < t; tok++) {
        if (!mask[row * t + tok]) continue;
        count++;
        const base = row * t * h + tok * h;
        for (let k = 0; k < h; k++) m[k] += data[base + k]!;
      }
      for (let k = 0; k < h; k++) m[k] /= count || 1;
      cls.push(normalize(c)); mean.push(normalize(m));
    }
    if (i % (batch * 20) === 0) console.error(`local ${i}/${texts.length} ${((performance.now() - started) / 1000).toFixed(0)}s`);
  }
  return { mean, cls };
}

let hostedTokens = 0;
async function hosted(texts: string[]): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch("https://api.deepinfra.com/v1/openai/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.DEEPINFRA_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "BAAI/bge-m3", input: texts.slice(i, i + 64).map((t) => t.slice(0, 8000)), encoding_format: "float" }),
      });
      if (response.ok) {
        const body = await response.json() as { data: Array<{ embedding: number[]; index: number }>; usage: { prompt_tokens: number } };
        hostedTokens += body.usage.prompt_tokens;
        for (const d of body.data.sort((a, b) => a.index - b.index)) vectors.push(normalize(Float32Array.from(d.embedding)));
        break;
      }
      if (attempt >= 3) throw new Error(`DeepInfra ${response.status}: ${(await response.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  console.log(`[ai-usage] embedding-pooling-eval model=BAAI/bge-m3 input_tokens=${hostedTokens}`);
  return vectors;
}

function evaluate(queryVecs: Float32Array[], docVecs: Float32Array[]) {
  let ndcg = 0, r10 = 0, r100 = 0, mrr = 0;
  queries.forEach((q, qi) => {
    const qv = queryVecs[qi]!;
    const scores = docVecs.map((dv, di) => { let s = 0; for (let k = 0; k < qv.length; k++) s += qv[k]! * dv[k]!; return [s, di] as const; });
    scores.sort((a, b) => b[0] - a[0]);
    const rel = qrels.get(q._id)!;
    const ranked = scores.slice(0, 100).map(([, di]) => corpus[di]!._id);
    let dcg = 0; ranked.slice(0, 10).forEach((id, i) => { const g = rel.get(id) ?? 0; dcg += (2 ** g - 1) / Math.log2(i + 2); });
    const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, 10).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
    ndcg += ideal ? dcg / ideal : 0;
    r10 += ranked.slice(0, 10).filter((id) => rel.has(id)).length / rel.size;
    r100 += ranked.filter((id) => rel.has(id)).length / rel.size;
    const first = ranked.slice(0, 10).findIndex((id) => rel.has(id)); mrr += first >= 0 ? 1 / (first + 1) : 0;
  });
  const n = queries.length;
  return { ndcg10: +(ndcg / n).toFixed(4), recall10: +(r10 / n).toFixed(4), recall100: +(r100 / n).toFixed(4), mrr10: +(mrr / n).toFixed(4) };
}

const t0 = performance.now();
const localDocs = await localBoth(docTexts);
const localQueries = await localBoth(queries.map((q) => q.text));
const localSeconds = (performance.now() - t0) / 1000;
const result: Record<string, unknown> = { dataset: dir.split("/").pop(), documents: corpus.length, queries: queries.length, dtype, localSeconds: Math.round(localSeconds),
  localMean: evaluate(localQueries.mean, localDocs.mean), localCls: evaluate(localQueries.cls, localDocs.cls) };
if (hostedOn) {
  const t1 = performance.now();
  const hostedDocs = await hosted(docTexts); const hostedQueries = await hosted(queries.map((q) => q.text));
  Object.assign(result, { hostedSeconds: Math.round((performance.now() - t1) / 1000), hostedTokens, hostedCostUsd: +(hostedTokens / 1e6 * 0.01).toFixed(4),
    hostedCls: evaluate(hostedQueries, hostedDocs),
    // Existing local (mean) documents searched with hosted queries: the state before re-embedding.
    mixedHostedQueryLocalMeanDocs: evaluate(hostedQueries, localDocs.mean),
    mixedHostedQueryLocalClsDocs: evaluate(hostedQueries, localDocs.cls) });
}
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
