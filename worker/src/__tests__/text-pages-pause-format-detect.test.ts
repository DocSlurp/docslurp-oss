import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { FormatDetectStage } from "../stages/format-detect.js";
import { QuarantineStage } from "../stages/quarantine.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

// Spend mechanics below are exact at zero: no running-job overdraft.
process.env.RUN_CREDIT_OVERDRAFT_CREDITS = "0";

/**
 * Council round 2 (DocSlurp/app issue 599): quarantine records a text file's page count from its VM inspection but makes no
 * spend decision; format-detect, which authorizes every document on every attempt, pauses an unfunded run. A resumed run
 * then repeats only format-detect's cheap check, never quarantine's download, inspection and malware scan.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
let dir: string;

// A million short lines: 16,667 pages by the text rule against an intake estimate of one.
const content = Buffer.concat([Buffer.alloc(1_000_000, "\n"), Buffer.from("end")]);
const measured = Math.ceil(1_000_001 / 60);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "text-pages-pause-"));
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Low', 'low', 'u1', 8, 1);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (100, 'run-low', 'o1', 'u1', 'w', 'upload', 'processing', 'quarantine', '{}', 1, 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source)
      values ('doc-log', 'o1', 'u1', 'w', 'run-low', 'server.log', 'text/plain', 'k-log', 'processing', 1, 'assumed');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await server?.stop();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("text pages: counted in quarantine, authorized in format-detect", () => {
  it("counts once, pauses the unfunded run in format-detect, and resumes without re-scanning", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", "off");
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
    const store = new Store(url, 60_000, { poolMax: 1 });
    try {
      let downloads = 0;
      const storage = {
        bucket: "test",
        downloadSourceToTempFile: async (key: string) => {
          downloads++;
          const file = path.join(dir, `${downloads}-${key}`);
          await writeFile(file, content);
          return file;
        },
        putArtifactJson: async () => {},
        putJson: async () => {},
        uri: (key: string) => `s3://test/${key}`,
      } as unknown as ArtifactStore;
      const scans: string[] = [];
      const runner = {
        scanForMalware: async (file: string) => {
          scans.push(path.basename(file));
          return { status: "clean", engine: "clamscan", signature: null, databaseStatus: "fresh", healthWarnings: [] };
        },
      } as unknown as CommandRunner;
      const config = { quarantineEnabled: true, quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3,
        quarantineMaxTotalUncompressedBytes: 1 << 20, quarantineMaxSingleEntryBytes: 1 << 20, quarantineMaxExpansionRatio: 10 } as Config;
      const row = async () => (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = 'doc-log'`)).rows[0];
      const control = async () => (await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run-low'`)).rows[0]!.control_state;

      // Quarantine: one download, one scan, the count persisted, and no spend decision (the run is not paused here).
      let state = await loadRunState(store, "run-low", { totalStages: 2 });
      state.executionGeneration = state.run.executionGeneration;
      state.executionGeneration = state.run.executionGeneration;
      await new QuarantineStage(runner, storage, config).run(state);
      expect(state.documentStage("doc-log", "quarantine")?.status).toBe("completed");
      expect(await row()).toEqual({ page_count: measured, page_count_source: "counted" });
      expect(await control()).not.toBe("paused");
      expect({ downloads, scans: scans.length }).toEqual({ downloads: 1, scans: 1 });

      // Format-detect authorizes the measured pages and pauses the run (no source read: the count is persisted).
      state = await loadRunState(store, "run-low", { totalStages: 2 });
      state.executionGeneration = state.run.executionGeneration;
      const paused = await new FormatDetectStage(storage).run(state).then(() => null, (error: unknown) => error);
      expect(await control()).toBe("paused");
      expect(paused === null ? state.documentStage("doc-log", "format-detect")?.status : "threw").not.toBe("completed");
      expect(downloads).toBe(1);

      // Funded and resumed: quarantine is a checkpoint (no download, no scan, no count), format-detect completes.
      await db.exec(`update organizations set credit_balance_cents = 100000000 where id = 'o1'; update project_runs set control_state = null, pause_reason = null where id = 'run-low'`);
      state = await loadRunState(store, "run-low", { totalStages: 2 });
      state.executionGeneration = state.run.executionGeneration;
      await new QuarantineStage(runner, storage, config).run(state);
      await new FormatDetectStage(storage).run(state);
      expect(state.documentStage("doc-log", "format-detect")?.status).toBe("completed");
      expect({ downloads, scans: scans.length }).toEqual({ downloads: 1, scans: 1 });
      expect(await row()).toEqual({ page_count: measured, page_count_source: "counted" });
    } finally {
      await store.close();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  }, 120_000);
});
