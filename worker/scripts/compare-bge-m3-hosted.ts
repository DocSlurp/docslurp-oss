/**
 * Compares local transformers.js bge-m3 (production settings: mean pooling,
 * normalized, default dtype) with DeepInfra BAAI/bge-m3 on the same texts, and
 * checks retrieval agreement when a hosted query searches local document vectors.
 * Usage: DEEPINFRA_API_KEY=... tsx scripts/compare-bge-m3-hosted.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "@huggingface/transformers";
import { resolveLocalTransformersJsDtype } from "../src/stages/embedding-runtime.js";

const documents = [
  "Edit .env.selfhost before running up. Recreate affected containers after an edit with the same up -d command.",
  "The quarterly revenue grew 14% year over year, driven by enterprise subscriptions in EMEA and APAC.",
  "Patients with type 2 diabetes should monitor fasting glucose levels and HbA1c every three months.",
  "La facture doit être réglée dans un délai de trente jours à compter de la date d'émission.",
  "Der Mietvertrag kann mit einer Frist von drei Monaten zum Monatsende gekündigt werden.",
  "函数返回一个包含所有匹配结果的数组，如果没有匹配则返回空数组。",
  "export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i + 1 >= attempts) throw e; } } }",
  "| Region | Q1 | Q2 |\n| --- | ---: | ---: |\n| EMEA | 1.2M | 1.4M |\n| APAC | 0.8M | 1.1M |",
  "Termination for convenience: either party may terminate this Agreement upon ninety (90) days' written notice.",
  "The turbine blade inspection found micro-cracks near the root fillet; replace blades exceeding 0.2 mm crack length.",
  "Our refund policy allows returns within 30 days of purchase with the original receipt.",
  "Photosynthesis converts light energy into chemical energy stored in glucose molecules.",
  "To reset your password, open Settings, choose Security and select Reset password.",
  "El sistema de frenos ABS evita el bloqueo de las ruedas durante una frenada brusca.",
  "Kubernetes pods are scheduled onto nodes based on resource requests, taints and affinity rules.",
  "The witness stated she saw the vehicle run the red light at approximately 9:40 pm.",
];
const queries = [
  ["how do I apply config changes in self-hosting", 0],
  ["revenue growth by region", 1],
  ["diabetes monitoring schedule", 2],
  ["payment terms for invoices", 3],
  ["lease termination notice period", 4],
  ["retry helper function", 6],
  ["can either side end the contract early", 8],
  ["how to change my password", 12],
] as const;

const cos = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0) / Math.sqrt(a.reduce((s, v) => s + v * v, 0) * b.reduce((s, v) => s + v * v, 0));

async function hosted(texts: string[]): Promise<number[][]> {
  const response = await fetch("https://api.deepinfra.com/v1/openai/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPINFRA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "BAAI/bge-m3", input: texts, encoding_format: "float" }),
  });
  if (!response.ok) throw new Error(`DeepInfra ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json() as { data: Array<{ embedding: number[]; index: number }>; usage: { prompt_tokens: number } };
  console.log(`[ai-usage] embedding-compare model=BAAI/bge-m3 input_tokens=${body.usage.prompt_tokens}`);
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const dtype = resolveLocalTransformersJsDtype();
const extractor = await pipeline("feature-extraction", "Xenova/bge-m3", { dtype: dtype === "auto" ? undefined : dtype as never, cache_dir: join(homedir(), ".cache", "docslurp", "transformers") });
const local = async (texts: string[], pooling: "mean" | "cls") => (await extractor(texts, { pooling, normalize: true })).tolist() as number[][];

const allTexts = [...documents, ...queries.map(([q]) => q)];
const [h, lm, lc] = [await hosted(allTexts), await local(allTexts, "mean"), await local(allTexts, "cls")];
const sims = (x: number[][], y: number[][]) => x.map((v, i) => cos(v, y[i]!));
const summary = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return { min: +s[0]!.toFixed(4), p50: +s[Math.floor(s.length / 2)]!.toFixed(4), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(4) }; };
console.log(JSON.stringify({ dtype, hostedVsLocalMean: summary(sims(h, lm)), hostedVsLocalCls: summary(sims(h, lc)), localMeanVsLocalCls: summary(sims(lm, lc)) }));

// Retrieval: rank the 16 documents for each query. Production today = local query vs local docs.
function top(queryVec: number[], docVecs: number[][]) { return docVecs.map((d, i) => [cos(queryVec, d), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i); }
const n = documents.length;
for (const [label, qv, dv] of [["local mean query / local mean docs (today)", lm, lm], ["hosted query / local mean docs (mixed, after switch)", h, lm], ["hosted query / hosted docs (after re-embed)", h, h]] as const) {
  let hit1 = 0, agree = 0;
  queries.forEach(([, expected], qi) => {
    const ranks = top(qv[n + qi]!, dv.slice(0, n));
    if (ranks[0] === expected) hit1 += 1;
    const today = top(lm[n + qi]!, lm.slice(0, n));
    if (ranks.slice(0, 3).join() === today.slice(0, 3).join()) agree += 1;
  });
  console.log(JSON.stringify({ arm: label, top1Correct: `${hit1}/${queries.length}`, top3SameAsToday: `${agree}/${queries.length}` }));
}
