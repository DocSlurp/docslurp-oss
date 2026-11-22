import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createArtifactProcessor, type ProcessorModule } from "./index.js";

async function main([input, ...targets]: string[]): Promise<void> {
  const modulePath = process.env.DOCSLURP_PROCESSOR_MODULE?.trim();
  if (!modulePath || !input || targets.length === 0) {
    throw new Error("Set DOCSLURP_PROCESSOR_MODULE and pass <input> <target-kind> [<target-kind> ...]");
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const module = await import(pathToFileURL(resolve(modulePath)).href) as ProcessorModule;
    const { adapters, prepare } = await module.configure(process.env);
    const prepared = await prepare(input, targets, abort.signal);
    let result;
    try {
      const processor = createArtifactProcessor(adapters);
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
