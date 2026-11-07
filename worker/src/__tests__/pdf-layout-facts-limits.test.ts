import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { writePdf } from "../test/page-tree-pdf.js";
import { CommandRunner, PDF_LAYOUT_FACTS_LIMITS } from "../tools/runner.js";

/**
 * The layout walker parses customer PDFs in Python, so it runs under external limits (council E #5): prlimit caps its address
 * space and CPU, and the plan carries a wall-clock timeout. A predictor-row bomb (a tiny stream whose DecodeParms ask for a
 * gigabyte row) is refused by the walker itself, cheaply, and the limits stop anything it does not anticipate.
 */
describe("layout walker limits", () => {
  it("runs the walker under prlimit (address space, CPU) with a wall-clock timeout", async () => {
    const plan = await new CommandRunner().pdfLayoutFacts({ source: "/x/in.pdf", lastPage: 3, listing: "/x/l", wordBoxes: "/x/w", markdown: "/x/m" });
    expect(plan.binary).toBe("prlimit");
    expect(plan.args.slice(0, 3)).toEqual([`--as=${PDF_LAYOUT_FACTS_LIMITS.addressSpaceMiB * 1024 * 1024}`, `--cpu=${PDF_LAYOUT_FACTS_LIMITS.cpuSeconds}`, "--"]);
    expect(plan.args[4]).toMatch(/pdf_layout_facts\.py$/);
    expect(plan.args.slice(5)).toEqual(["--input", "/x/in.pdf", "--first", "1", "--last", "3", "--listing", "/x/l", "--xhtml", "/x/w", "--markdown", "/x/m"]);
    expect(plan).toMatchObject({ timeoutMs: PDF_LAYOUT_FACTS_LIMITS.wallMs, readOnlyInputs: true });
  });

  const runnable = !spawnSync("prlimit", ["--version"]).error;
  it.skipIf(!runnable)("refuses a predictor-row bomb page cheaply, inside its limits", async () => {
    const runner = new CommandRunner();
    const plan = await runner.pdfLayoutFacts({ source: "", lastPage: 1, listing: "", wordBoxes: "", markdown: "" });
    if (!plan.available) return; // no walker Python here (CI's worker job has it)
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "layout-bomb-"));
    try {
      const data = deflateSync(Buffer.alloc(65));
      const pdf = writePdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        `<< /Length ${data.length} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 16384 /Colors 65536 /BitsPerComponent 8 >> >>\nstream\n${data.toString("latin1")}\nendstream`,
      ]);
      const files = { source: path.join(dir, "in.pdf"), listing: path.join(dir, "listing.txt"), wordBoxes: path.join(dir, "words.xhtml"), markdown: path.join(dir, "out.md") };
      await writeFile(files.source, pdf);
      await writeFile(files.listing, "");
      await writeFile(files.wordBoxes, "<html><body><doc><page width=\"612\" height=\"792\"></page></doc></body></html>");
      await writeFile(files.markdown, "");
      const started = Date.now();
      const result = await runner.run(await runner.pdfLayoutFacts({ ...files, lastPage: 1 }));
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(result.stdout).toContain("stream-too-large");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
