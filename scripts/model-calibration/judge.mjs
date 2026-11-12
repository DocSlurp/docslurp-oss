// Blinded pairwise judge: incumbent vs one candidate arm, same feature and case. Order is randomized per pair
// from a hash; `--swap-check N` re-judges N pairs in the opposite order to measure position bias.
// Usage: node judge.mjs --run dev1 --candidate mm-minimal-r512 [--budget-usd 1] [--swap-check 20]
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const JUDGE = "anthropic/claude-sonnet-5.5";
const arg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
const run = arg("--run"); const candidate = arg("--candidate"); const baseline = arg("--baseline", "incumbent");
const budget = Number(arg("--budget-usd", "1")); const swapCheck = Number(arg("--swap-check", "0"));
const dir = new URL(`./runs/${run}/`, import.meta.url);
const rows = readFileSync(new URL("results.jsonl", dir), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const outFile = new URL(`judge-${candidate}-vs-${baseline}.jsonl`, dir);
const done = new Set(existsSync(outFile) ? readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.feature}:${r.case}:${r.swapped}`; }) : []);

const byKey = new Map();
for (const row of rows) byKey.set(`${row.feature}:${row.case}:${row.arm}`, row);
const pairs = [];
for (const row of rows) {
  if (row.arm !== baseline || !row.judge) continue;
  const other = byKey.get(`${row.feature}:${row.case}:${candidate}`);
  if (!other?.judge) continue;
  pairs.push({ feature: row.feature, case: row.case, split: row.split, task: row.judge.task, input: row.judge.input, base: row.judge.output, cand: other.judge.output });
}
const flip = (p) => createHash("sha256").update(`${p.feature}:${p.case}`).digest()[0] % 2 === 1;

const SYSTEM = `You are an exacting evaluator of outputs from a document-processing product. You compare two candidate outputs (A and B) for the same task and input. Judge only against the task contract and the input; never reward length for its own sake. Penalize, in order of severity: claims not supported by the input (fabrication), violating the output contract (format, length, language, extra prose), missing important content, unclear or redundant wording. An empty, truncated or cut-off output is a serious failure. If both are equally good or equally bad, answer tie.
Reply with JSON only: {"winner":"A"|"B"|"tie","scoreA":1-5,"scoreB":1-5,"severeA":true|false,"severeB":true|false,"reason":"<one sentence>"}. severe = fabrication, empty/truncated output, or a broken contract that would make the output unusable.`;

let spent = 0;
async function judge(pair, swapped) {
  const aIsCand = flip(pair) !== swapped;
  const A = aIsCand ? pair.cand : pair.base; const B = aIsCand ? pair.base : pair.cand;
  const user = `TASK CONTRACT:\n${pair.task}\n\nINPUT:\n${String(pair.input).slice(0, 14000)}\n\n=== OUTPUT A ===\n${A || "(empty)"}\n\n=== OUTPUT B ===\n${B || "(empty)"}`;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: JUDGE, temperature: 0, max_tokens: 1200, reasoning: { effort: "minimal" }, usage: { include: true }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }) });
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json).slice(0, 200));
  spent += json.usage?.cost ?? 0;
  const text = json.choices[0].message.content ?? "";
  const verdict = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const map = (w) => (w === "tie" ? "tie" : (w === "A") === aIsCand ? "candidate" : "baseline");
  return { feature: pair.feature, case: pair.case, split: pair.split, swapped, winner: map(verdict.winner),
    candidateScore: aIsCand ? verdict.scoreA : verdict.scoreB, baselineScore: aIsCand ? verdict.scoreB : verdict.scoreA,
    candidateSevere: aIsCand ? verdict.severeA : verdict.severeB, baselineSevere: aIsCand ? verdict.severeB : verdict.severeA, reason: verdict.reason, costUsd: json.usage?.cost };
}

const jobs = [...pairs.map((p) => [p, false]), ...pairs.slice(0, swapCheck).map((p) => [p, true])].filter(([p, s]) => !done.has(`${p.feature}:${p.case}:${s}`));
console.log(`${jobs.length} judgments (${pairs.length} pairs), budget $${budget}`);
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < jobs.length && spent < budget) {
    const [pair, swapped] = jobs[next++];
    try { appendFileSync(outFile, JSON.stringify(await judge(pair, swapped)) + "\n"); }
    catch (error) { console.error(pair.feature, pair.case, String(error).slice(0, 160)); }
  }
}));
console.log(`spent $${spent.toFixed(4)}${spent >= budget ? " (STOPPED at budget)" : ""}`);
