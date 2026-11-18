import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { canonicalIdForUrl, opaqueCanonicalIdForUrl } from "../lib/canonical-id.js";
import type { SqlClient } from "../db.js";

/**
 * A URL re-ingest takes over the version chain of that URL's legacy documents
 * (raw-URL canonical_id), end to end through createRunCreation on a migrated
 * database: only rows URL intake made in the same project and organization.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let creation: typeof import("../services/run-creation.js");
let runCreation: ReturnType<typeof import("../services/run-creation.js").createRunCreation>;
const pdfFacts = { declaredMimeType: "application/pdf", sniffedMimeType: "application/pdf", mimeType: "application/pdf", format: "pdf", container: null, encoding: null, mismatch: "none" };

const URL_A = "https://files.example.com/d/report.pdf?X-Amz-Signature=SIG";
const LEGACY = canonicalIdForUrl(URL_A);
const OPAQUE = opaqueCanonicalIdForUrl(URL_A);

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/source-metadata.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../services/source-metadata.js")>(),
    resolveSourceMetadata: vi.fn(async () => ({ pageCount: 1, sourceSha256: `sha-${Math.random()}`, fileFacts: pdfFacts })),
  }));
  vi.doMock("../lib/temporal.js", () => ({
    startPipelineWorkflow: vi.fn(async () => {}), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
    isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  creation = await import("../services/run-creation.js");
  runCreation = creation.createRunCreation({ sql, start: vi.fn(async () => ({ status: "started" })) } as never);
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'legacy-url@example.test'), ('u2', 'U2', 'legacy-url-2@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('o', 'O', 'legacy-o', 'u', 100000), ('o2', 'O2', 'legacy-o2', 'u2', 100000)`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner'), ('o2', 'u2', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'o', 'u', 'W'), ('w2', 'o', 'u', 'W2'), ('c', 'o2', 'u2', 'C')`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

beforeEach(async () => {
  await sql`delete from documents`;
  await sql`delete from project_runs`;
});

async function legacyRun(id: string, project: string, org: string, user: string, kind: string) {
  await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values (100, ${id}, ${org}, ${user}, ${project}, ${kind}, 'completed', 'index', '{}'::jsonb)`;
}

async function legacyDoc(id: string, args: { project?: string; org?: string; user?: string; run: string; canonical: string; sourceUrl?: string; created: string; version?: number }) {
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, metadata, version_number, created_at)
    values (${id}, ${args.org ?? "o"}, ${args.user ?? "u"}, ${args.project ?? "w"}, ${args.run}, 'report.pdf', 'application/pdf', ${`k/${id}`}, 'completed',
      ${args.canonical}, ${sql.json(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {})}, ${args.version ?? 1}, ${args.created})`;
}

/** A URL ingest through run creation, as URL intake hands it over (URL_A by default). */
async function ingest(url = URL_A) {
  return runCreation.create({
    userId: "u", projectId: "w", kind: "url-ingest", pipeline: defaultPipelineFeatures,
    sources: { kind: "files", files: [{ filename: "files.example.com-0.pdf", mimeType: "application/pdf", sourceKey: `u/raw/${Math.random()}`, fileSize: 1000, canonicalId: opaqueCanonicalIdForUrl(url), metadata: { sourceUrl: url } }] },
  } as never);
}

async function rows() {
  return sql<{ id: string; canonical_id: string; version_number: number; previous_version_id: string | null }[]>`
    select id, canonical_id, version_number, previous_version_id from documents order by created_at, id`;
}

describe("a URL re-ingest supersedes the URL's legacy documents (createRunCreation end to end)", () => {
  it("re-keys only this project's URL-intake rows of this URL, never another project's, org's, upload's or URL's", async () => {
    await legacyRun("url-run", "w", "o", "u", "url-ingest");
    await legacyRun("url-run-w2", "w2", "o", "u", "url-ingest");
    await legacyRun("url-run-c", "c", "o2", "u2", "url-ingest");
    await legacyRun("upload-run", "w", "o", "u", "bulk-upload");
    await legacyDoc("legacy", { run: "url-run", canonical: LEGACY, sourceUrl: URL_A, created: "2026-01-01" });
    await legacyDoc("other-project", { project: "w2", run: "url-run-w2", canonical: LEGACY, sourceUrl: URL_A, created: "2026-01-01" });
    await legacyDoc("other-org", { project: "c", org: "o2", user: "u2", run: "url-run-c", canonical: LEGACY, sourceUrl: URL_A, created: "2026-01-01" });
    // A caller's upload that chose this URL as its own canonical ID: no sourceUrl (callers cannot set it).
    await legacyDoc("caller-upload", { run: "upload-run", canonical: LEGACY, created: "2026-01-02" });
    // A URL-intake row with this canonical ID whose stored source URL is a different one: ambiguous, left alone.
    await legacyDoc("other-url", { run: "url-run", canonical: LEGACY, sourceUrl: "https://files.example.com/d/other.pdf", created: "2026-01-03" });

    await ingest();
    const byId = Object.fromEntries((await rows()).map((row) => [row.id, row]));
    expect(byId.legacy!.canonical_id).toBe(OPAQUE);
    for (const id of ["other-project", "other-org", "caller-upload", "other-url"]) expect({ id, canonical: byId[id]!.canonical_id }).toEqual({ id, canonical: LEGACY });
    const created = (await rows()).find((row) => !["legacy", "other-project", "other-org", "caller-upload", "other-url"].includes(row.id));
    expect(created).toMatchObject({ canonical_id: OPAQUE, version_number: 2, previous_version_id: "legacy" });
  });

  it("adopts a mixed url-ingest + bulk-reprocess chain: once the new version completes, it is the only current one", async () => {
    await legacyRun("url-run", "w", "o", "u", "url-ingest");
    await legacyRun("reprocess-run", "w", "o", "u", "bulk-reprocess");
    await legacyDoc("v1", { run: "url-run", canonical: LEGACY, sourceUrl: URL_A, created: "2026-01-01" });
    // A reprocess copies canonical_id and sourceUrl from its source; completing it supersedes v1.
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, metadata, version_number, previous_version_id, created_at)
      values ('v2', 'o', 'u', 'w', 'reprocess-run', 'report.pdf', 'application/pdf', 'k/v2', 'queued', ${LEGACY}, ${sql.json({ sourceUrl: URL_A })}, 2, 'v1', '2026-01-05')`;
    await sql`update documents set status = 'completed' where id = 'v2'`;
    await ingest();
    const created = (await rows()).find((row) => !["v1", "v2"].includes(row.id))!;
    expect(created).toMatchObject({ canonical_id: OPAQUE, version_number: 3, previous_version_id: "v2" });
    await sql`update documents set status = 'completed' where id = ${created.id}`;
    const states = await sql<{ id: string; canonical_id: string; superseded: boolean }[]>`
      select id, canonical_id, superseded_at is not null as superseded from documents where project_id = 'w' order by created_at`;
    expect(states).toEqual([
      { id: "v1", canonical_id: OPAQUE, superseded: true },
      { id: "v2", canonical_id: OPAQUE, superseded: true },
      { id: created.id, canonical_id: OPAQUE, superseded: false },
    ]);
  });

  it("keeps two long URLs that share a 2,048-character prefix in separate chains", async () => {
    const prefix = `https://files.example.com/${"a".repeat(2100)}`;
    const [one, two] = [`${prefix}?part=1`, `${prefix}?part=2`];
    expect(canonicalIdForUrl(one)).toBe(canonicalIdForUrl(two));
    await legacyRun("url-run", "w", "o", "u", "url-ingest");
    await legacyDoc("long-one", { run: "url-run", canonical: canonicalIdForUrl(one), sourceUrl: one, created: "2026-01-01" });
    await ingest(two);
    const created = (await rows()).find((row) => row.id !== "long-one")!;
    // The other URL's legacy row shares the legacy key but not the provenance: untouched, and not this chain's.
    expect(created).toMatchObject({ canonical_id: opaqueCanonicalIdForUrl(two), version_number: 1, previous_version_id: null });
    expect((await rows()).find((row) => row.id === "long-one")!.canonical_id).toBe(canonicalIdForUrl(one));
  });

  it("keeps /manual and /manual/ in separate chains (the fetched path, exactly)", async () => {
    const [plain, slash] = ["https://files.example.com/manual", "https://files.example.com/manual/"];
    // Both stored the same legacy key (the old normalization folded the slash).
    expect(canonicalIdForUrl(plain)).toBe(canonicalIdForUrl(slash));
    await legacyRun("url-run", "w", "o", "u", "url-ingest");
    await legacyDoc("plain-legacy", { run: "url-run", canonical: canonicalIdForUrl(plain), sourceUrl: plain, created: "2026-01-01" });
    await ingest(slash);
    const created = (await rows()).find((row) => row.id !== "plain-legacy")!;
    expect(created).toMatchObject({ canonical_id: opaqueCanonicalIdForUrl(slash), version_number: 1, previous_version_id: null });
    expect((await rows()).find((row) => row.id === "plain-legacy")!.canonical_id).toBe(canonicalIdForUrl(plain));
    await ingest(plain);
    const adopted = (await rows()).find((row) => row.id === "plain-legacy")!;
    expect(adopted.canonical_id).toBe(opaqueCanonicalIdForUrl(plain));
    expect(opaqueCanonicalIdForUrl(plain)).not.toBe(opaqueCanonicalIdForUrl(slash));
  });

  it("orders an adopted chain by creation and numbers after its highest version", async () => {
    await legacyRun("url-run", "w", "o", "u", "url-ingest");
    await legacyDoc("legacy", { run: "url-run", canonical: LEGACY, sourceUrl: URL_A, created: "2026-01-01" });
    // An opaque-keyed row already exists (version 1 too): the new version follows it, as number 2.
    await legacyDoc("opaque-early", { run: "url-run", canonical: OPAQUE, sourceUrl: URL_A, created: "2026-02-01" });
    await ingest();
    const created = (await rows()).find((row) => !["legacy", "opaque-early"].includes(row.id))!;
    expect(created).toMatchObject({ canonical_id: OPAQUE, version_number: 2, previous_version_id: "opaque-early" });
  });

  it("is idempotent: a second re-ingest adopts nothing and extends the chain", async () => {
    await legacyRun("url-run", "w", "o", "u", "url-ingest");
    await legacyDoc("legacy", { run: "url-run", canonical: LEGACY, sourceUrl: URL_A, created: "2026-01-01" });
    await ingest();
    const first = (await rows()).find((row) => row.id !== "legacy")!;
    await ingest();
    const second = (await rows()).find((row) => row.id !== "legacy" && row.id !== first.id)!;
    expect(second).toMatchObject({ canonical_id: OPAQUE, version_number: 3, previous_version_id: first.id });
    expect(await sql.begin(async (tx) => creation.adoptLegacyUrlVersions(tx as unknown as SqlClient, { projectId: "w", orgId: "o", canonicalId: OPAQUE, metadata: { sourceUrl: URL_A } }))).toBe(0);
  });

  it("never takes the legacy key's advisory lock, so a worker completing a legacy row cannot deadlock with it", async () => {
    await legacyRun("url-run", "w", "o", "u", "url-ingest");
    await legacyDoc("legacy", { run: "url-run", canonical: LEGACY, sourceUrl: URL_A, created: "2026-01-01" });
    await sql`update documents set status = 'processing' where id = 'legacy'`;
    // PGlite serves one connection at a time, so the two sessions cannot interleave here; what this checks is
    // the lock order: run creation holds only the opaque key (taken by its caller) while it re-keys rows.
    // (Other triggers on documents take their own advisory keys, as for any row update.)
    const held = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`w:${OPAQUE}`}, 0))`;
      await creation.adoptLegacyUrlVersions(tx as unknown as SqlClient, { projectId: "w", orgId: "o", canonicalId: OPAQUE, metadata: { sourceUrl: URL_A } });
      const holds = async (key: string) => (await tx<{ n: number }[]>`select count(*)::int as n from pg_locks l
        where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 1
          and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${key}, 0)`)[0]!.n;
      const result = { opaque: await holds(`w:${OPAQUE}`), legacy: await holds(`w:${LEGACY}`) };
      // The same check does see the legacy key once it is taken (the key mapping is right for it).
      await tx`select pg_advisory_xact_lock(hashtextextended(${`w:${LEGACY}`}, 0))`;
      return { ...result, legacyWhenTaken: await holds(`w:${LEGACY}`) };
    });
    expect(held).toEqual({ opaque: 1, legacy: 0, legacyWhenTaken: 1 });
    // The worker then completes the (now opaque-keyed) row: its supersession trigger runs without conflict.
    await sql`update documents set status = 'completed' where id = 'legacy'`;
    expect(await sql`select canonical_id, status from documents where id = 'legacy'`).toEqual([{ canonical_id: OPAQUE, status: "completed" }]);
  });
});
