import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { quarantineReasonOf } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { QuarantineStage } from "../stages/quarantine.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { sha256Bytes, stageSourceFile } from "../sandbox/source-integrity.js";

/**
 * Correctness council re-check 2 (PR #339): one upload, one file refused by the quarantine stage (a round-5 refusal: an
 * encrypted PDF with two encryption dictionaries) and one good file. Intake accepts both; the worker's real quarantine
 * stage refuses one; the good file completes and the run completes with failedDocuments 1, never failing the whole run.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
let dir: string;

const ID = "/ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]";
const ENC = "<< /Filter /Standard /V 2 /R 3 /Length 128 /P -4 /O <00> /U <00> >>";
/** Two encryption dictionaries, the second under an incremental update's trailer (pdf-encryption-structure.ts). */
function twoKeyPdf(): Buffer {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, body] of ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>", ENC].entries()) {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R /Encrypt 3 0 R ${ID} >>\nstartxref\n${xref}\n%%EOF\n`;
  const second = out.length;
  out += `4 0 obj\n${ENC.replace("<00>", "<11>")}\nendobj\n`;
  const updateXref = out.length;
  out += `xref\n4 1\n${String(second).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R /Prev ${xref} /Encrypt 4 0 R ${ID} >>\nstartxref\n${updateXref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** An ordinary linearized RC4 PDF (council round 6, R6-M1 fixture) and the copy the fake in-VM decryption writes for it. */
const encryptedPdf = readFileSync(new URL("../../testdata/clam-encrypted/r6-linearized-rc4.pdf", import.meta.url));
const scannedCopy = Buffer.from("%PDF-1.7\n% qpdf --decrypt --qdf copy of the board pack\n");

const sources = new Map<string, Buffer>([
  ["k-enc", encryptedPdf],
  ["k-bad", twoKeyPdf()],
  ["k-good", Buffer.from("Quarterly revenue up 12% on strong demand; the team opens the London office in March.\n")],
]);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "quarantine-partial-run-"));
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, execution_generation)
      values ('run-mixed', 'o1', 'u1', 'w', 'upload', 'processing', 'quarantine', '{}', 2, null),
             ('run-enc', 'o1', 'u1', 'w', 'upload', 'processing', 'quarantine', '{}', 1, null);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, created_at)
      values ('doc-bad', 'o1', 'u1', 'w', 'run-mixed', 'board-pack.pdf', 'application/pdf', 'k-bad', 'processing', 1, '2026-01-01'),
             ('doc-good', 'o1', 'u1', 'w', 'run-mixed', 'q3-notes.txt', 'text/plain', 'k-good', 'processing', 1, '2026-01-02'),
             ('doc-enc', 'o1', 'u1', 'w', 'run-enc', 'board-pack.pdf', 'application/pdf', 'k-enc', 'processing', 1, '2026-01-03');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("an upload with one quarantine refusal and one good file", () => {
  it("the good file passes quarantine, the refused one fails with a public reason, and the run completes partial", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", "off");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Store(url, 60_000, { poolMax: 1 });
    try {
      const state = await loadRunState(store, "run-mixed", { totalStages: 1 });
      state.docConcurrency = 2;
      let sequence = 0;
      const storage = {
        downloadSourceToTempFile: async (key: string) => {
          const file = path.join(dir, `${sequence++}-${key}`);
          await writeFile(file, sources.get(key)!);
          return file;
        },
        putArtifactJson: async () => {},
        uri: (key: string) => `s3://test/${key}`,
      } as unknown as ArtifactStore;
      // Both files scan clean: the refusal is quarantine's own (the in-process inspection outside production).
      const scanned: string[] = [];
      const runner = {
        scanForMalware: async (file: string) => {
          scanned.push(path.basename(file));
          return { status: "clean", engine: "clamscan", signature: null, databaseStatus: "fresh", healthWarnings: [] };
        },
        decryptPdfForScan: async () => { throw new Error("an inconsistent encrypted PDF must not be decrypted"); },
      } as unknown as CommandRunner;
      const config = { quarantineEnabled: true, quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3,
        quarantineMaxTotalUncompressedBytes: 1 << 20, quarantineMaxSingleEntryBytes: 1 << 20, quarantineMaxExpansionRatio: 10 } as Config;

      await new QuarantineStage(runner, storage, config).run(state);

      expect(state.documentStage("doc-good", "quarantine")?.status).toBe("completed");
      expect(state.documentStage("doc-bad", "quarantine")?.status).toBe("failed");
      const error = state.documentStage("doc-bad", "quarantine")!.error;
      expect(error).toMatch(/^quarantined \[pdf-encryption-inconsistent\]/);
      expect(quarantineReasonOf(error)).toBe("quarantine-encrypted");
      // Later stages see only the good file.
      expect(healthyDocuments(state).map((document) => document.id)).toEqual(["doc-good"]);
      expect(scanned).toHaveLength(2);

      const fresh = await loadRunState(store, "run-mixed", { totalStages: 1 });
      await store.completeRun(fresh);
    } finally {
      await store.close();
      warn.mockRestore();
      vi.unstubAllEnvs();
    }

    const documents = await db.query<{ id: string; status: string }>(`select id, status from documents where run_id = 'run-mixed' order by id`);
    expect(Object.fromEntries(documents.rows.map((row) => [row.id, row.status]))).toEqual({ "doc-bad": "failed", "doc-good": "completed" });
    const [run] = (await db.query<{ status: string; stats: Record<string, number> }>(`select status, stats from project_runs where id = 'run-mixed'`)).rows;
    expect(run).toMatchObject({ status: "completed" });
    expect(run!.stats).toMatchObject({ failedDocuments: 1 });
  });
});

describe("scan what we parse (council round 6, R6-H1)", () => {
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "quarantine-parse-copy-")); });
  const config = { quarantineEnabled: true, quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3,
    quarantineMaxTotalUncompressedBytes: 1 << 20, quarantineMaxSingleEntryBytes: 1 << 20, quarantineMaxExpansionRatio: 10 } as Config;
  const clean = { status: "clean", engine: "clamscan", signature: null, databaseStatus: "fresh", healthWarnings: [] };

  function harness(copyVerdict: Record<string, unknown> = clean) {
    const downloads: string[] = [];
    const objects = new Map<string, Buffer>(sources);
    let sequence = 0;
    const storage = {
      // Each download in its own directory, as the real store does (cleanupTempFile removes the file's directory).
      downloadSourceToTempFile: async (key: string) => {
        downloads.push(key);
        const file = path.join(await mkdtemp(path.join(dir, `${sequence++}-`)), key.replaceAll("/", "_"));
        await writeFile(file, objects.get(key)!);
        return file;
      },
      downloadToTempFile: async (key: string) => {
        const file = path.join(await mkdtemp(path.join(dir, `${sequence++}-`)), key.replaceAll("/", "_"));
        await writeFile(file, objects.get(key) ?? Buffer.alloc(0));
        return file;
      },
      putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
      putArtifactJson: async () => {},
      uri: (key: string) => `s3://test/${key}`,
    } as unknown as ArtifactStore;
    const scanned: string[] = [];
    const runner = {
      scanForMalware: async (file: string) => {
        scanned.push(path.basename(file));
        return path.basename(file) === "decrypted.pdf" ? copyVerdict : clean;
      },
      decryptPdfForScan: async (_source: string, outputDir: string) => {
        const output = path.join(outputDir, "decrypted.pdf");
        await writeFile(output, scannedCopy);
        return { status: "decrypted", path: output, bytes: scannedCopy.length, ms: 3, encrypted: true };
      },
    } as unknown as CommandRunner;
    return { storage, runner, downloads, scanned, objects };
  }

  it("an accepted encrypted PDF is parsed from the copy its scan read; the original is quarantine's alone", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", "off");
    const store = new Store(url, 60_000, { poolMax: 1 });
    const { storage, runner, downloads, scanned, objects } = harness();
    const copyKey = "u1/run-enc/quarantine/doc-enc.scanned.pdf";
    try {
      const state = await loadRunState(store, "run-enc", { totalStages: 1 });
      await new QuarantineStage(runner, storage, config).run(state);
      expect(state.documentStage("doc-enc", "quarantine")?.status).toBe("completed");
      expect(scanned).toEqual([expect.stringContaining("k-enc"), "decrypted.pdf"]);
      // The stored copy is byte for byte the copy the scan read.
      expect(objects.get(copyKey)).toEqual(scannedCopy);
      expect(state.documents[0]).toMatchObject({ sourceKey: copyKey, sourceSha256: sha256Bytes(scannedCopy), parseSourceDecision: "scanned-copy" });
      expect(state.documentStage("doc-enc", "quarantine")?.stats).toMatchObject({ pdfParseCopy: true, pdfParseCopyBytes: scannedCopy.length });

      // Every later stage (and the deferred materializer, which loads by id) gets the copy from the loader.
      const fresh = await loadRunState(store, "run-enc", { totalStages: 1 });
      const document = fresh.documents[0]!;
      expect(document).toMatchObject({ sourceKey: copyKey, parseSourceDecision: "scanned-copy" });
      expect(JSON.stringify(document)).not.toContain("k-enc");
      expect((await store.loadDocument("doc-enc")).sourceKey).toBe(copyKey);
      // A parser's staged read gets the scanned copy.
      const staged = await stageSourceFile(storage, document, "x");
      expect(await readFile(staged)).toEqual(scannedCopy);

      // A retried quarantine (its checkpoint gone) scans the upload again, never its own copy.
      await db.exec(`delete from document_run_stage_states where document_id = 'doc-enc'`);
      await new QuarantineStage(runner, storage, config).run(await loadRunState(store, "run-enc", { totalStages: 1 }));
      expect(downloads).toEqual(["k-enc", "k-enc"]);
    } finally {
      await store.close();
      vi.unstubAllEnvs();
    }
    const [row] = (await db.query<{ source_key: string; parse_source_key: string | null; parse_source_sha256: string | null }>(`select source_key, parse_source_key, parse_source_sha256 from documents where id = 'doc-enc'`)).rows;
    // The upload stays the document's source (download original); the copy is recorded beside it.
    expect(row).toEqual({ source_key: "k-enc", parse_source_key: copyKey, parse_source_sha256: sha256Bytes(scannedCopy) });
  });

  it("a refused encrypted PDF records no copy, and a retry that refuses clears an earlier one", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", "off");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Store(url, 60_000, { poolMax: 1 });
    const { storage, runner } = harness({ ...clean, status: "infected", signature: "Docslurp.Test.MatrixMarker" });
    try {
      const state = await loadRunState(store, "run-enc", { totalStages: 1 });
      expect(state.documents[0]?.parseSourceDecision).toBe("scanned-copy");
      await db.exec(`delete from document_run_stage_states where document_id = 'doc-enc'`);
      const retry = await loadRunState(store, "run-enc", { totalStages: 1 });
      await new QuarantineStage(runner, storage, config).run(retry);
      expect(retry.documentStage("doc-enc", "quarantine")?.status).toBe("failed");
      // Refused: no decision, and nothing may read the upload.
      expect(retry.documents[0]?.parseSourceDecision).toBe("unscanned");
      expect(retry.documents[0]?.sourceKey).not.toContain("k-enc");
    } finally {
      await store.close();
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
    const [row] = (await db.query<{ parse_source_key: string | null; parse_source_scan_version: number | null }>(`select parse_source_key, parse_source_scan_version from documents where id = 'doc-enc'`)).rows;
    expect(row).toEqual({ parse_source_key: null, parse_source_scan_version: null });
  });
});
