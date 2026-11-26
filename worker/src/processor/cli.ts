import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createArtifactProcessor, type ProcessorModule } from "./index.js";

async function main([input, ...targets]: string[]): Promise<void> {
  const modulePath = process.env.DOCSLURP_PROCESSOR_MODULE?.trim();
  if (!input || targets.length === 0) {
    throw new Error("Pass <input> <target-kind> [<target-kind> ...]");
  }
  // Adapter and provider diagnostics must leave stdout available for the manifest.
  console.log = console.info = console.error;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const module: ProcessorModule = modulePath
      ? await import(pathToFileURL(resolve(modulePath)).href)
      : await import("./pdf-reference.js");
    const configured = await module.configure(process.env);
    if (input === "-" && !configured.prepareStream) throw new Error("Configured processor does not accept stdin");
    const prepared = input === "-" && configured.prepareStream
      ? await configured.prepareStream(process.stdin, targets, abort.signal)
      : await configured.prepare(input, targets, abort.signal);
    let result;
    try {
      const processor = createArtifactProcessor(configured.adapters);
      result = await processor.execute({ ...prepared.request, target: targets }, abort.signal);
    } finally {
      await prepared.close?.();
    }
    abort.signal.throwIfAborted();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Document processing failed");
  process.exitCode = 1;
});
