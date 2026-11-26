/**
 * The PDF raster and text consumers (pdf-tooling, split-pages, render-images, routing evidence and page facts, document-map,
 * page-embed, vision-extract, extract-html, extract-markdown's raster paths, deferred render-page and materialize-pages) run
 * Poppler and Doppler only through CommandRunner: its plan builders, PdfRasterCache and runLocalArtifactCommand. Outside
 * development every such command must reach the remote parser VM's run(); a session that would start it on the worker host
 * is refused before anything is spawned, whatever opened it (DocSlurp/app issue 599).
 */
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLocalArtifactCommand } from "../extractors/local-artifact-adapters.js";
import type { Document } from "../models.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { setDefaultParserSandbox, type InitializedParserSandbox } from "../sandbox/startup.js";
import { watchSandboxInfrastructure } from "../sandbox/session-context.js";
import { SandboxInfrastructureError, SandboxPolicyError, type SandboxCommand, type SandboxIsolation, type SandboxResult, type SandboxSession } from "../sandbox/types.js";
import { CommandRunner, type CommandPlan } from "../tools/runner.js";

const roots: string[] = [];
async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `docslurp-${prefix}-`));
  roots.push(root);
  return root;
}

/** A PDF header followed by an object stream crafted to crash a parser, and a page tree that claims a billion pages. */
const HOSTILE_PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1000000000 >>\nendobj\n" +
    "3 0 obj\n<< /Length 999999999999 /Filter [/FlateDecode /FlateDecode /JBIG2Decode] >>\nstream\n" + "\u0000".repeat(4096) +
    "\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Prev 0 >>\nstartxref\n0\n%%EOF\n",
  "latin1",
);

async function hostilePdf(): Promise<string> {
  const file = path.join(await scratch("hostile"), "hostile.pdf");
  await writeFile(file, HOSTILE_PDF);
  return file;
}

/** A 3 GiB PDF (sparse: the header, then a hole), larger than any page or byte limit, so a host binary would choke on it. */
async function oversizedPdf(): Promise<string> {
  const file = path.join(await scratch("oversized"), "oversized.pdf");
  const handle = await open(file, "w");
  try {
    await handle.write(HOSTILE_PDF, 0, HOSTILE_PDF.length, 0);
    await handle.truncate(3 * 1024 ** 3);
  } finally {
    await handle.close();
  }
  return file;
}

interface Recorder {
  spawned: string[];
  ran: SandboxCommand[];
}

/** A session that would start commands on this host (bubblewrap, landlock, none or a caller's own opener). */
function localSession(recorder: Recorder, overrides: Partial<SandboxSession> = {}): SandboxSession {
  return {
    providerId: "bubblewrap",
    isolation: { filesystem: true, network: "full", processes: true, location: "local" },
    filtersUnixSockets: true,
    spawn: (command) => {
      recorder.spawned.push(command.binary);
      throw new Error(`host spawn reached for ${command.binary}`);
    },
    close: async () => {},
    ...overrides,
  };
}

const VM_ISOLATION: SandboxIsolation = { filesystem: true, network: "full", processes: true, location: "remote" };

/** The audited remote VM provider's session shape: run() only, remote, filesystem and full network isolation. */
function vmSession(recorder: Recorder, answer: (command: SandboxCommand) => SandboxResult = () => ({ exitCode: 0, stdout: "", stderr: "" })): SandboxSession {
  return {
    providerId: "modal",
    isolation: VM_ISOLATION,
    run: async (command) => {
      recorder.ran.push(command);
      return answer(command);
    },
    close: async () => {},
  };
}

function recorder(): Recorder {
  return { spawned: [], ran: [] };
}

/** Every Poppler/Doppler plan the raster and text consumers build, for one source. */
async function consumerPlans(runner: CommandRunner, source: string, out: string): Promise<Array<[string, CommandPlan]>> {
  return [
    ["pdf-tooling pdfinfo", await runner.pdfInfo(source)],
    ["pdf-tooling / extract-markdown pdftotext", await runner.extractText(source, 3)],
    ["extract-html pdftohtml", await runner.extractHtml(source, 3)],
    ["pdf-tooling pdfimages", await runner.extractImages(source, path.join(out, "img"), 3)],
    ["page-facts pdfimages -list", await runner.listImages(source, 3)],
    ["split-pages pdfseparate", await runner.splitPages(source, path.join(out, "page-%d.pdf"), 3)],
    ["render-images pdftoppm", await runner.renderPageImages(source, path.join(out, "page"), 3)],
    ["raster cache pdfinfo sizes", await runner.pdfPageSizes(source, 1, 3)],
    ["raster cache pdftoppm range", await runner.renderPdfPageRange(source, path.join(out, "range"), 1, 3, 150)],
  ];
}

function pdfinfoSizes(first: number, last: number): string {
  return [`Pages:           ${last}`, "Encrypted:       no", ...Array.from({ length: last - first + 1 }, (_, i) => `Page ${String(first + i).padStart(4)} size: 612 x 792 pts (letter)`)].join("\n");
}

function hashedDocument(bytes: Buffer): Document {
  return {
    id: "doc-hostile",
    userId: "user-1",
    runId: "run-1",
    filename: "hostile.pdf",
    mimeType: "application/pdf",
    fileFacts: { format: "pdf" } as Document["fileFacts"],
    sourceKey: "sources/hostile.pdf",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    parseSourceDecision: "original",
    status: "processing",
    extractionMode: "auto",
    pageCount: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Document;
}

function sourceStorage(bytes: Buffer) {
  return {
    async downloadToTempFile(_key: string, pattern: string) {
      const file = path.join(await scratch("raster-source"), pattern.replace("*", "fixture"));
      await writeFile(file, bytes);
      return file;
    },
  };
}

const rasterStorage = { async objectSize() { return null; }, async putBytes() {}, uri: (key: string) => `s3://test/${key}` };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setDefaultParserSandbox(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production: raster and text consumers never start Poppler on the worker host", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  const hostSessions: Array<[string, (r: Recorder) => SandboxSession]> = [
    ["bubblewrap on the host", (r) => localSession(r)],
    ["landlock on the host", (r) => localSession(r, { providerId: "landlock" })],
    ["provider none", (r) => localSession(r, { providerId: "none", isolation: { filesystem: false, network: "none", processes: false, location: "local" } })],
    ["a local session that names the VM provider", (r) => localSession(r, { providerId: "modal" })],
    ["an unaudited provider claiming to be remote", (r) => localSession(r, { providerId: "bubblewrap", isolation: VM_ISOLATION })],
    ["a VM session without network isolation", (r) => ({ ...vmSession(r), isolation: { ...VM_ISOLATION, network: "none" } })],
    ["a VM-named session that only spawns locally", (r) => ({ ...localSession(r, { providerId: "modal", isolation: VM_ISOLATION }) })],
  ];

  it.each(hostSessions)("refuses every consumer plan on %s before spawning", async (_label, open) => {
    const r = recorder();
    const runner = new CommandRunner({ openSession: async () => open(r) });
    const source = await hostilePdf();
    const out = await scratch("out");
    for (const [consumer, plan] of await consumerPlans(runner, source, out)) {
      await expect(runner.run({ ...plan, available: true }), consumer).rejects.toBeInstanceOf(SandboxPolicyError);
    }
    expect(r.spawned).toEqual([]);
    expect(r.ran).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[parser-sandbox] status=refused"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reason=no-vm-boundary"));
  });

  it("refuses an oversized PDF on a host session", async () => {
    const r = recorder();
    const runner = new CommandRunner({ openSession: async () => localSession(r) });
    const source = await oversizedPdf();
    const out = await scratch("out");
    for (const [consumer, plan] of await consumerPlans(runner, source, out)) {
      await expect(runner.run({ ...plan, available: true }), consumer).rejects.toBeInstanceOf(SandboxPolicyError);
    }
    expect(r.spawned).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reason=no-vm-boundary"));
  });

  it.each([
    ["an unknown NODE_ENV", { NODE_ENV: "staging" }],
    ["a service profile with NODE_ENV unset", { NODE_ENV: "", DOCSLURP_PROFILE: "service" }],
    ["a service profile under development", { NODE_ENV: "development", DOCSLURP_PROFILE: "service" }],
  ])("refuses a host session under %s", async (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const r = recorder();
    const runner = new CommandRunner({ openSession: async () => localSession(r) });
    await expect(runner.run({ ...(await runner.pdfInfo(await hostilePdf())), available: true })).rejects.toBeInstanceOf(SandboxPolicyError);
    expect(r.spawned).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reason=no-vm-boundary"));
  });

  it("fails the activity when a stage swallows the refusal and carries on", async () => {
    const r = recorder();
    const runner = new CommandRunner({ openSession: async () => localSession(r) });
    const source = await hostilePdf();
    // A stage that treats a failed probe as "no evidence" (page facts does) must not complete the document on that.
    const watched = await watchSandboxInfrastructure(async () => {
      const info = await runner.run({ ...(await runner.pdfInfo(source)), available: true }).catch(() => null);
      return info === null ? "degraded" : "ok";
    });
    expect(watched.result).toBe("degraded");
    expect(watched.infrastructure).toBeInstanceOf(SandboxInfrastructureError);
    expect(watched.infrastructure?.cause).toBeInstanceOf(SandboxPolicyError);
    expect((watched.infrastructure as SandboxInfrastructureError).strikes).toBeFalsy();
    expect(r.spawned).toEqual([]);
  });

  it("sends every consumer plan for a hostile PDF to the VM's run, never to spawn", async () => {
    const r = recorder();
    // The VM session also carries a spawn that would run on the host: the runner must not use it.
    const runner = new CommandRunner({ openSession: async () => ({ ...vmSession(r), spawn: localSession(r).spawn }) });
    const source = await hostilePdf();
    const out = await scratch("out");
    const plans = await consumerPlans(runner, source, out);
    for (const [, plan] of plans) await runner.run({ ...plan, available: true });
    expect(r.spawned).toEqual([]);
    expect(r.ran.map((command) => path.basename(command.binary))).toEqual(plans.map(([, plan]) => path.basename(plan.binary)));
    for (const command of r.ran) expect(command.args).toContain(source);
  });

  it("document-map and the local artifact adapters (runLocalArtifactCommand) refuse a host default sandbox", async () => {
    const r = recorder();
    const sandbox: InitializedParserSandbox = {
      provider: { id: "bubblewrap", openSession: async () => localSession(r) } as unknown as InitializedParserSandbox["provider"],
      config: {},
      isolation: { filesystem: true, network: "full", processes: true, location: "local" },
    };
    setDefaultParserSandbox(sandbox);
    const source = await hostilePdf();
    await expect(runLocalArtifactCommand("pdftotext", ["-f", "1", "-l", "3", "-layout", "-enc", "UTF-8", source, "-"], 1024, 5_000))
      .rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(runLocalArtifactCommand("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-png", source, path.join(await scratch("out"), "p")], 1024, 5_000))
      .rejects.toBeInstanceOf(SandboxPolicyError);
    expect(r.spawned).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reason=no-vm-boundary"));
  });

  it("document-map and the local artifact adapters run in the VM with the registered VM sandbox", async () => {
    const r = recorder();
    setDefaultParserSandbox({
      provider: { id: "modal", openSession: async () => vmSession(r, () => ({ exitCode: 0, stdout: "page text", stderr: "" })) } as unknown as InitializedParserSandbox["provider"],
      config: {},
      isolation: VM_ISOLATION,
    });
    const source = await hostilePdf();
    const out = await runLocalArtifactCommand("pdftotext", ["-f", "1", "-l", "3", "-layout", "-enc", "UTF-8", source, "-"], 1024, 5_000);
    expect(out.toString()).toBe("page text");
    expect(r.ran.map((command) => command.binary)).toEqual(["pdftotext"]);
  });

  it("render-images, page-embed, vision-extract, render-page and materialize-pages (PdfRasterCache) refuse a host session", async () => {
    const r = recorder();
    const runner = new CommandRunner({ openSession: async () => localSession(r) });
    const sources = new PdfSourceCache(sourceStorage(HOSTILE_PDF) as never);
    try {
      const cache = new PdfRasterCache(runner, rasterStorage as never, sources, { engine: "pdftoppm" });
      await expect(cache.renderSelectedPages({ document: hashedDocument(HOSTILE_PDF), runId: "run-1", pageNumbers: [1, 2, 3] }))
        .rejects.toBeInstanceOf(SandboxPolicyError);
    } finally {
      await sources.clear();
    }
    expect(r.spawned).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reason=no-vm-boundary"));
  });

  it("PdfRasterCache measures and renders a hostile PDF in the VM", async () => {
    const r = recorder();
    const runner = new CommandRunner({
      openSession: async () => vmSession(r, (command) => path.basename(command.binary) === "pdfinfo"
        ? { exitCode: 0, stdout: pdfinfoSizes(1, 3), stderr: "" }
        // The guest refuses to render the crafted file; the host never retries it locally.
        : { exitCode: 1, stdout: "", stderr: "Syntax Error: Couldn't read xref table" }),
    });
    const sources = new PdfSourceCache(sourceStorage(HOSTILE_PDF) as never);
    try {
      const cache = new PdfRasterCache(runner, rasterStorage as never, sources, { engine: "pdftoppm" });
      await expect(cache.renderSelectedPages({ document: hashedDocument(HOSTILE_PDF), runId: "run-1", pageNumbers: [1, 2, 3] })).rejects.toThrow();
    } finally {
      await sources.clear();
    }
    expect(r.spawned).toEqual([]);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("reason=no-vm-boundary"));
    const binaries = r.ran.map((command) => path.basename(command.binary));
    expect(binaries).toContain("pdfinfo");
    expect(binaries).toContain("pdftoppm");
  });
});

describe("development keeps local parser sandboxes", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "development"));

  it("starts commands through the local session's spawn", async () => {
    const r = recorder();
    const runner = new CommandRunner({ openSession: async () => localSession(r) });
    const source = await hostilePdf();
    await expect(runner.run({ ...(await runner.pdfInfo(source)), available: true })).rejects.toThrow("host spawn reached for pdfinfo");
    expect(r.spawned).toEqual(["pdfinfo"]);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("reason=no-vm-boundary"));
  });
});
