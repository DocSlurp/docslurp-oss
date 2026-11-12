// One-time corpus generation: each document is written by a judge-class model from an authored fact sheet.
// Gold answers come from facts.json, never from model output. Re-running refuses to overwrite.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const KEY = process.env.OPENROUTER_API_KEY; const MODEL = "anthropic/claude-sonnet-5.5";
const dir = new URL("./corpus/", import.meta.url);
const facts = JSON.parse(readFileSync(new URL("facts.json", dir), "utf8"));
let cost = 0;
await Promise.all(facts.map(async (doc) => {
  const out = new URL(`${doc.id}.md`, dir); if (existsSync(out)) return;
  const prompt = `Write a realistic ${doc.kind} in ${doc.language}, titled "${doc.title}", formatted as Markdown with headings, about 1,600-2,000 words. It must state every fact below exactly (same numbers, names, dates), spread naturally through the document, and must not contradict them. Add plausible supporting detail (sections, at least one Markdown table, narrative), but do not invent other numbers that could be confused with the listed facts for the same quantity. Keep the tone positive and businesslike. Output only the document.\n\nFacts:\n${doc.facts.map((f) => `- ${f}`).join("\n")}`;
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, temperature: 0.4, usage: { include: true }, reasoning: { effort: "minimal" }, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  cost += j.usage?.cost ?? 0; writeFileSync(out, j.choices[0].message.content.trim() + "\n");
  console.log(doc.id, j.usage?.completion_tokens, j.usage?.cost);
}));
console.log("total cost USD", cost.toFixed(4));
