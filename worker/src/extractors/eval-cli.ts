#!/usr/bin/env node
/** Run one production registry candidate for the method-neutral local evaluator. */
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRunner, type CommandPlan } from "../tools/runner.js";
import { documentExtractorRegistry, type CandidateExecutors, type ExtractedCandidate } from "./registry.js";
import { runLocalPdfArtifactGraph } from "./local-graph-runner.js";

function arg(name: string): string {
  const at = process.argv.indexOf(name);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`missing ${name}`);
  return process.argv[at + 1];
}

async function main(): Promise<void> {
  const id = arg("--adapter");
  const source = path.resolve(arg("--input"));
  const destination = path.resolve(arg("--output"));
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-eval-registry-"));
  try {
    const input = path.join(scratch, path.basename(source));
    await copyFile(source, input);
    const runner = new CommandRunner();
    const prepared = await documentExtractorRegistry.prepare(id, runner, input);
    if (!prepared.plan.available) {
      await writeFile(destination, JSON.stringify({ status: "unavailable", adapter: id, error: `binary unavailable: ${prepared.plan.binary}` }));
      return;
    }
    const started = performance.now();
    const resultFrom = (plan: CommandPlan, label: string, text: string): ExtractedCandidate & { prediction: string } => ({
      label, plan, textKey: "eval", textUri: "eval", tempTextPath: "", prediction: text,
    });
    let prediction = "";
    let graphArtifacts: Array<{ id: string; kind: string; sha256: string; derivedFrom: string[]; placements: unknown[] }> | undefined;
    const executors: CandidateExecutors = {
      async file(plan, label, _key, outputPath, signal) {
        await runner.run(plan, signal);
        prediction = await readFile(outputPath, "utf8");
        return resultFrom(plan, label, prediction);
      },
      async stream(plan, label, _key, signal) {
        const result = await runner.run(plan, signal);
        prediction = result.stdout;
        return resultFrom(plan, label, prediction);
      },
      async markdownFile(candidate, _key, outputPath) {
        prediction = await readFile(outputPath, "utf8");
        return resultFrom(candidate.plan, candidate.label, prediction);
      },
      async docling() { throw new Error("docling eval executor not implemented"); },
      async liteparse() { throw new Error("liteparse eval executor not implemented"); },
      async graph(candidate, _key, sourcePath) {
        const infoPlan = await runner.pdfInfo(sourcePath);
        if (!infoPlan.available) throw new Error("missing dependency: pdfinfo");
        const info = await runner.run(infoPlan);
        const pages = Number(info.stdout.match(/^Pages:\s*(\d+)/m)?.[1]);
        if (!Number.isSafeInteger(pages) || pages < 1) throw new Error("pdfinfo did not report a valid page count");
        const sourceHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
        const graph = await runLocalPdfArtifactGraph({ sourcePath, sourceDocumentId: `eval-${sourceHash.slice(0, 12)}`, sha256: sourceHash, pageCount: pages, targetKinds: ["document/markdown"], scratchDir: path.join(scratch, "graph") });
        const markdown = graph.targets.find((artifact) => artifact.kind === "document/markdown");
        if (!markdown) throw new Error("graph-local produced no Markdown");
        prediction = await readFile(markdown.uri, "utf8");
        graphArtifacts = graph.artifacts.map(({ id, kind, sha256, derivedFrom, placements }) => ({ id, kind, sha256, derivedFrom, placements }));
        return resultFrom(candidate.plan, candidate.label, prediction);
      },
    };
    await prepared.execute(executors, "eval", input);
    await writeFile(destination, JSON.stringify({ status: "ok", adapter: id, output: { [id === "pymupdf" || id === "poppler-text" ? "text" : "markdown"]: prediction, ...(graphArtifacts ? { artifacts: graphArtifacts } : {}) }, usage: [], diagnostics: { latencyMs: performance.now() - started, warnings: [] } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = /missing dependency|No module named|command not found/i.test(message);
    await writeFile(destination, JSON.stringify({ status: unavailable ? "unavailable" : "failed", adapter: id, error: message }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
