import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedDatabase,
  migrationJournalProblems,
  readMigrationJournal,
} from "../test/migrated-db.js";

// Reference mirror of the version-key algorithm in the global constraints.
function normPart(x: string): string {
  return x
    .normalize("NFC")
    .replace(/[A-Z]/g, (c) => c.toLowerCase()) // ASCII-only fold
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^[/ \t\r\n]+|[/ \t\r\n]+$/g, "");
}
function refKey(ws: string, path: string, name: string): string {
  const h = createHash("sha256").update(`${ws}\n${normPart(path)}/${normPart(name)}`, "utf8").digest("hex");
  return `path:${h.slice(0, 32)}`;
}

const SAMPLES: Array<[string, string, string]> = [
  ["w", "", "a.pdf"],
  ["w", "", "A.PDF"],
  ["w", "docs", "a.pdf"],
  ["w", "/docs/", "a.pdf"],
  ["w", "docs\\sub", "a.pdf"],
  ["w", "docs//sub///x", "a.pdf"],
  ["w", "  docs/sub  ", " a.pdf "],
  ["w", "Docs/Sub", "Report.PDF"],
  ["w2", "docs", "a.pdf"],
  ["w", "café", "résumé.pdf"],
  ["w", "café", "résumé.pdf"],
  ["w", "日本語/フォルダ", "ファイル.pdf"],
  ["w", "Ünï/çödé", "ÄÖÜ.docx"],
  ["w", "a b/c d", "e f.txt"],
  ["w", "\\\\server\\share", "x.md"],
  ["w", "a/b/c/d/e/f", "deep.xlsx"],
  ["ws-with-dash", "", "weird name (1).pdf"],
  ["w", "emoji 😀", "😀.png"],
  ["w", "", "STRASSE.txt"],
  ["w", "///", "only-name"],
  ["w", "\u00a0docs", "\u00a0a.pdf"],
  ["w", "", "Ä.pdf"],
  ["w", "", "ä.pdf"],
];

describe("migration 0065 versions, retention and config jobs", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
      insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
      insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
      insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
        values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
        values ('d1', 'o1', 'u1', 'w', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 3);
    `);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("keeps the journal consistent", () => {
    expect(migrationJournalProblems(readMigrationJournal())).toEqual([]);
  });

  it("applies column defaults", async () => {
    const d = await db.query<{ source_path: string; archived_at: unknown; index_config_hash: unknown }>(
      `select source_path, archived_at, index_config_hash from documents where id = 'd1'`);
    expect(d.rows[0]).toEqual({ source_path: "", archived_at: null, index_config_hash: null });
    const w = await db.query<{ a: boolean; r: unknown; p: unknown }>(
      `select auto_confirm_reindex a, retain_document_versions r, index_configs p from workspaces where id = 'w'`);
    expect(w.rows[0]).toEqual({ a: false, r: null, p: null });
    const o = await db.query<{ r: unknown }>(`select retain_document_versions r from organizations where id = 'o1'`);
    expect(o.rows[0]!.r).toBeNull();
    const r = await db.query<{ b: unknown; j: unknown }>(`select blocked_reason b, job_id j from workspace_runs where id = 'run-1'`);
    expect(r.rows[0]).toEqual({ b: null, j: null });
    const re = await db.query<{ r: unknown }>(`select reindex_of r from documents where id = 'd1'`);
    expect(re.rows[0]!.r).toBeNull();
  });

  it("enforces check constraints", async () => {
    for (const t of ["organizations", "workspaces"]) {
      const id = t === "organizations" ? "o1" : "w";
      await expect(db.exec(`update ${t} set retain_document_versions = 0 where id = '${id}'`)).rejects.toThrow();
      await expect(db.exec(`update ${t} set retain_document_versions = 101 where id = '${id}'`)).rejects.toThrow();
      await db.exec(`update ${t} set retain_document_versions = 1 where id = '${id}'`);
      await db.exec(`update ${t} set retain_document_versions = 100 where id = '${id}'`);
      await db.exec(`update ${t} set retain_document_versions = null where id = '${id}'`);
    }
    await expect(db.exec(`update workspace_runs set blocked_reason = 'nope' where id = 'run-1'`)).rejects.toThrow();
    for (const reason of ["credits", "budget", "policy"]) {
      await db.exec(`update workspace_runs set status = 'blocked', blocked_reason = '${reason}' where id = 'run-1'`);
    }
    await db.exec(`update workspace_runs set status = 'processing', blocked_reason = null where id = 'run-1'`);
  });

  it("SQL docslurp_version_key equals the reference TS algorithm for the sample inputs", async () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(20);
    for (const [ws, path, name] of SAMPLES) {
      const r = await db.query<{ k: string }>(`select docslurp_version_key($1, $2, $3) k`, [ws, path, name]);
      expect(r.rows[0]!.k, JSON.stringify([ws, path, name])).toBe(refKey(ws, path, name));
    }
    // Case, separator and unicode variants collapse to one key.
    const k = async (p: string, n: string) =>
      (await db.query<{ k: string }>(`select docslurp_version_key('w', $1, $2) k`, [p, n])).rows[0]!.k;
    expect(await k("Docs\\Sub", "A.PDF")).toBe(await k("/docs//sub/", "a.pdf"));
    expect(await k("", "Ä.pdf")).not.toBe(await k("", "ä.pdf"));
    expect(await k("", "\u00a0a.pdf")).not.toBe(await k("", "a.pdf"));
  });

  it("backfills only chained versions into one key; unrelated same-name files stay independent", async () => {
    const m = (await import("node:fs")).readFileSync(
      new URL("../../../server/db/migrations/0065_versions_retention_config_jobs.sql", import.meta.url), "utf8");
    const doc = (id: string, name: string, status: string, day: string, prev: string | null) =>
      `('${id}','o1','u1','w','run-1','${name}','application/pdf','k-${id}','${status}',1,'2026-02-${day}',${prev ? `'${prev}'` : "null"})`;
    await db.exec(`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, created_at, previous_version_id) values
        ${doc("u1a", "Same.pdf", "completed", "01", null)},
        ${doc("u2a", "same.PDF", "completed", "02", null)},
        ${doc("c1", "Chain.pdf", "completed", "01", null)},
        ${doc("c2", "chain.pdf", "completed", "02", "c1")},
        ${doc("f1", "Fail.pdf", "failed", "01", null)},
        ${doc("f2", "fail.pdf", "completed", "02", "f1")};
      update documents set canonical_id = null, superseded_at = null, superseded_by_document_id = null
        where id in ('u1a','u2a','c1','c2','f1','f2');
    `);
    // Re-run the migration's backfill: the data statements are the ones that start
    // with an optional WITH and an UPDATE documents (function/DDL statements excluded).
    const stmts = m.split("--> statement-breakpoint").map((s) => s.trim())
      .filter((s) => /^(--[^\n]*\n)*\s*(WITH RECURSIVE[\s\S]*?\)\s*)?UPDATE documents/i.test(s) && !/ALTER|CREATE/i.test(s.slice(0, 40)));
    expect(stmts).toHaveLength(2);
    for (const s of stmts) await db.exec(s);
    const rows = await db.query<{ id: string; canonical_id: string; superseded_at: unknown; by: string | null }>(
      `select id, canonical_id, superseded_at, superseded_by_document_id by from documents
       where id in ('u1a','u2a','c1','c2','f1','f2') order by id`);
    const r = Object.fromEntries(rows.rows.map((x) => [x.id, x]));
    // Unrelated same-name docs: both live, distinct keys.
    expect(r.u1a!.superseded_at).toBeNull();
    expect(r.u2a!.superseded_at).toBeNull();
    expect(r.u1a!.canonical_id).toBe("legacy:u1a");
    // The newest row heads its group and takes the path key; the unchained older one is legacy.
    expect(r.u2a!.canonical_id).toBe(refKey("w", "", "same.PDF"));
    expect(r.u2a!.canonical_id).not.toBe(r.u1a!.canonical_id);
    // Chained v1 -> v2: shared path key, v1 superseded.
    expect(r.c1!.canonical_id).toBe(refKey("w", "", "Chain.pdf"));
    expect(r.c2!.canonical_id).toBe(r.c1!.canonical_id);
    expect(r.c1!.by).toBe("c2");
    expect(r.c2!.superseded_at).toBeNull();
    // Failed older chained row is superseded too.
    expect(r.f1!.by).toBe("f2");
    expect(r.f2!.superseded_at).toBeNull();
  });
});
