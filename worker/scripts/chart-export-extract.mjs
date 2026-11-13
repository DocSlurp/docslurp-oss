// Parser-VM guest: deterministic chart/diagram extraction (office-chart-xml, embedded-spec, svg-geometry).
// argv: <input file> <request.json> <output.json> [more input files...]. Reads customer bytes; runs only inside the
// parser VM in production. With `batch: N` in the request (SVG only), the first input plus the N-1 trailing inputs are
// extracted one by one, each under its own size limit, and the output is one result per input, in order.
import { readFile, stat, writeFile } from "node:fs/promises";
// One bundled module (built from dist/chart-export/extractors/guest-entry.js): loads in a fraction of the CPU the
// separate ESM files take, which matters because every VM command starts a fresh process.
import { CHART_EXTRACT_LIMITS, extractDeterministicVisuals, setGuestDeadline } from "../dist/chart-export/guest.bundle.mjs";
const started = Date.now();
const [input, requestPath, output, ...more] = process.argv.slice(2);
if ((await stat(requestPath)).size > 4096) throw new Error("chart extract request exceeds limit");
const request = JSON.parse(await readFile(requestPath, "utf8"));
const kind = request?.kind;
if (!["office", "epub", "svg", "html", "json"].includes(kind)) throw new Error("invalid chart extract kind");
const packaged = kind === "office" || kind === "epub";
const options = { diagrams: request.diagrams !== false };
// Deadline below the host's timeout (the host sends its timeout minus a margin): past it, SVGs not yet analysed are
// returned as a counted `guest-deadline` deferral, so a slow input keeps what it produced instead of being killed.
const budgetMs = Number.isSafeInteger(request.budgetMs) && request.budgetMs >= 1_000 && request.budgetMs <= 175_000 ? request.budgetMs : 45_000;
setGuestDeadline(started + budgetMs);
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

let json;
if (request.batch !== undefined) {
  const batch = request.batch;
  if (kind !== "svg" || !Number.isSafeInteger(batch) || batch < 1 || batch > 40 || more.length !== batch - 1) throw new Error("invalid chart extract batch");
  const refused = (reason) => ({ schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [{ locator: "svg", reason }] });
  const results = [];
  // Each SVG is bounded by the density gate and the per-SVG pair cap, so one figure never starves the others.
  for (const file of [input, ...more]) {
    if ((await stat(file)).size > CHART_EXTRACT_LIMITS.maxTextBytes) { results.push(refused("input-too-large")); continue; }
    try {
      results.push(extractDeterministicVisuals({ kind, text: (await readFile(file)).toString("utf8") }, options));
    } catch {
      // One bad figure never sinks the others; the host sees a machine reason only.
      results.push(refused("extract-failed"));
    }
  }
  json = JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results });
} else {
  if (more.length > 0) throw new Error("unexpected chart extract inputs");
  if ((await stat(input)).size > (packaged ? CHART_EXTRACT_LIMITS.maxPackageBytes : CHART_EXTRACT_LIMITS.maxTextBytes)) throw new Error("chart extract input exceeds limit");
  const bytes = await readFile(input);
  json = JSON.stringify(extractDeterministicVisuals(packaged ? { kind, bytes } : { kind, text: bytes.toString("utf8") }, options));
}
if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error("chart extract result exceeds limit");
await writeFile(output, json, { mode: 0o600 });
