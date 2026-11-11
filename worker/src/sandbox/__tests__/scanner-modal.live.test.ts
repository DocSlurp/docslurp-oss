import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runWithPerfContext } from "../../lib/perf-context.js";
import modal, { type ModalConfig } from "../providers/modal/index.js";
import { runWithSandboxScope, SandboxSessionScope, closeSandboxQuietly } from "../session-context.js";
import { setDefaultParserSandbox } from "../startup.js";
import type { ParserSandboxProvider } from "../types.js";
import { CommandRunner } from "../../tools/runner.js";

/**
 * Live Modal check of the scanner snapshot path (Q1/Q2) against the per-command path it replaces. Runs only with
 * DOCSLURP_SCANNER_LIVE_IMAGE_ID (a Modal image with clamav, clamav-daemon, python3 and util-linux), MODAL_TOKEN_ID,
 * MODAL_TOKEN_SECRET and DOCSLURP_SCANNER_LIVE_SIGS (a directory with main/daily/bytecode .cvd). Timings are appended to
 * DOCSLURP_SCANNER_LIVE_OUT when set.
 */
const imageId = process.env.DOCSLURP_SCANNER_LIVE_IMAGE_ID;
const sigs = process.env.DOCSLURP_SCANNER_LIVE_SIGS;
const live = Boolean(imageId && sigs && process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PDF = "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n";

async function record(row: Record<string, unknown>): Promise<void> {
  const out = process.env.DOCSLURP_SCANNER_LIVE_OUT;
  console.log(JSON.stringify(row));
  if (out) await appendFile(out, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
}

(live ? describe : describe.skip)("scanner snapshot on live Modal", () => {
  vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });
  const env = { ...process.env };
  let dir: string;
  const config = {
    tokenId: process.env.MODAL_TOKEN_ID!, tokenSecret: process.env.MODAL_TOKEN_SECRET!,
    app: process.env.DOCSLURP_MODAL_APP ?? "docslurp-quarantine-latency-probe-sbx",
    image: "unused", imageId, cpu: 2, memoryMb: 4096, sessionTimeoutSeconds: 300,
    vmsPerActivity: 4, vmsPerWorker: 8, vmIdleSeconds: 20, scannerRegions: ["us"],
  } as ModalConfig;
  const provider = modal as unknown as ParserSandboxProvider<ModalConfig>;
  const runner = new CommandRunner();

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    process.env.DOCSLURP_CLAMAV_DB_DIR = sigs;
    process.env.DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS = "72";
    setDefaultParserSandbox({ provider: provider as unknown as ParserSandboxProvider, config: config as unknown as Record<string, unknown>, isolation: { filesystem: true, network: "full", processes: true, location: "remote" }, tools: ["clamscan", "clamdscan", "python3"] });
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-scanner-live-"));
  });
  afterAll(async () => {
    setDefaultParserSandbox(undefined);
    process.env = env;
    await rm(dir, { recursive: true, force: true });
  });

  const inContext = <T>(orgId: string, documentId: string, fn: () => Promise<T>) => runWithPerfContext({
    runId: "live-run", documentId, orgId, scope: "document", stageName: "quarantine", pushPerformance: () => {}, pushUsage: () => {},
  }, fn);

  async function file(name: string, body: string): Promise<string> {
    const p = path.join(dir, name);
    await writeFile(p, body);
    return p;
  }

  it("before: the per-command path (version check and clamscan in a fresh activity session)", async () => {
    process.env.DOCSLURP_QUARANTINE_SCAN_SNAPSHOT = "off";
    for (const [name, body, expected] of [["a.pdf", PDF, "clean"], ["eicar.txt", EICAR, "infected"], ["b.pdf", PDF, "clean"]] as const) {
      const source = await file(name, body);
      const scope = new SandboxSessionScope(() => provider.openSession(config, { activityId: "live-before" }));
      const started = Date.now();
      const result = await runWithSandboxScope(scope, () => inContext("org-a", name, () => runner.scanForMalware(source)));
      const scanMs = Date.now() - started;
      await closeSandboxQuietly(() => scope.close(), "live-before");
      await record({ arm: "before-per-command", file: name, status: result.status, engine: result.engine, ms: scanMs, databaseStatus: result.databaseStatus });
      expect(result.status).toBe(expected);
    }
  });

  it("Q1: one restored scanner VM per document; EICAR infected, PDF clean; freshness from the host header", async () => {
    process.env.DOCSLURP_QUARANTINE_SCAN_SNAPSHOT = "on";
    const coldStart = Date.now();
    let first = true;
    for (const [name, body, expected] of [["a.pdf", PDF, "clean"], ["eicar.txt", EICAR, "infected"], ["b.pdf", PDF, "clean"], ["c.pdf", PDF, "clean"]] as const) {
      const source = await file(name, body);
      const started = Date.now();
      const result = await inContext("org-a", name, () => runner.withMalwareScanner("org-a", () => runner.scanForMalware(source)));
      await record({ arm: first ? "Q1-cold-includes-snapshot-build" : "Q1-warm", file: name, status: result.status, engine: result.engine, ms: Date.now() - started, databaseStatus: result.databaseStatus, signature: result.signature });
      first = false;
      expect(result.status).toBe(expected);
      if (expected === "infected") expect(result.signature).toMatch(/Eicar/i);
      expect(result.databaseStatus).toBe("fresh");
    }
    await record({ arm: "Q1-total", ms: Date.now() - coldStart });
  });

  it("Q2: one scanner session for a run's batch; a command of another organization is refused", async () => {
    process.env.DOCSLURP_QUARANTINE_SCAN_SNAPSHOT = "on";
    const files = await Promise.all(Array.from({ length: 10 }, (_, i) => file(`batch-${i}.pdf`, PDF)));
    const eicar = await file("batch-eicar.txt", EICAR);
    const started = Date.now();
    const results = await runner.withMalwareScanner("org-a", async () => {
      const out: string[] = [];
      const perFileMs: number[] = [];
      for (const [i, source] of [...files, eicar].entries()) {
        const t = Date.now();
        out.push((await inContext("org-a", `doc-${i}`, () => runner.scanForMalware(source))).status);
        perFileMs.push(Date.now() - t);
      }
      await record({ arm: "Q2-per-file", perFileMs });
      // The same session, a command of organization B: refused before it reaches a VM.
      const foreign = await inContext("org-b", "doc-b", () => runner.scanForMalware(files[0]!)).then(() => "ran", (error: unknown) => (error as Error).message);
      return { out, foreign };
    });
    await record({ arm: "Q2-batch-11-files", ms: Date.now() - started, statuses: results.out, foreign: results.foreign });
    expect(results.out.slice(0, 10).every((status) => status === "clean")).toBe(true);
    expect(results.out[10]).toBe("infected");
    expect(results.foreign).toMatch(/another organization/);
  });
});
