import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function invoke(input: string) {
  scratch = await mkdtemp(join(tmpdir(), "docslurp-processor-test-"));
  const adapterModule = join(scratch, "adapters.mjs");
  await writeFile(adapterModule, `
export async function configure() {
  return {
    adapters: [],
    async prepare(input) {
      return {
        request: { sourceDocumentId: "document", initial: [{
          id: "source", kind: "document/markdown", uri: "memory:source", mediaType: "text/markdown",
          sha256: "digest", sourceDocumentId: "document", derivedFrom: [], placements: [],
          producer: { id: "source", optionsDigest: "options" }
        }] },
        async close() { if (input === "fail-cleanup") throw new Error("cleanup refused"); },
      };
    },
  };
}
`);
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  return run(process.execPath, ["--import", "tsx", cli, input, "document/markdown"], {
    env: { ...process.env, DOCSLURP_PROCESSOR_MODULE: adapterModule },
  });
}

describe("artifact processor CLI", () => {
  it("prints one graph result for the requested target", async () => {
    const { stdout, stderr } = await invoke("ready");
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, targets: [{ id: "source" }] });
  });

  it("withholds the result if staging cleanup fails", async () => {
    await expect(invoke("fail-cleanup")).rejects.toMatchObject({ stdout: "", stderr: "cleanup refused\n", code: 1 });
  });
});
