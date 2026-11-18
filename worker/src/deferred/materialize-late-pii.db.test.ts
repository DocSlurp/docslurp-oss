import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { piiWithholdsPage } from "@docslurp/shared";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { recordLatePiiPages } from "./materialize-pages.js";

let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let server: Awaited<ReturnType<typeof serveOnRandomPort>>["server"];
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`insert into "user"(id,name,email) values('u','User','u@example.invalid');
    insert into organizations(id,name,created_by_user_id) values('o','Org','u');
    insert into projects(id,org_id,user_id,name) values('w','o','u','Project');
    insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,total_documents,pipeline,artifacts)
      values('run','o','u','w','bulk-upload','completed','completed',1,'{}','{"doc:page-3":"s3://b/page-3.png","doc:page-1":"s3://b/page-1.png"}');
    insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,page_count)
      values('doc','o','u','w','run','a.pdf','application/pdf','source','completed',4);`);
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
}, 60000);
afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

const metadataOf = async () => (await sql<{ metadata: unknown }[]>`select metadata from documents where id='doc'`)[0]!.metadata;
const setPii = (pii: unknown) => sql`update documents set metadata=${sql.json(pii === undefined ? {} : { pii } as never)}::jsonb where id='doc'`;
const record = (pages: number[]) => sql.begin((tx) => recordLatePiiPages(tx as never, "doc", pages, { sourceUri: "s3://b/source", pageSlots: pages.map((p) => `doc:page-${p}`), runId: "run" }));

it("withholds a page a query-time read found PII on, on a document pii-detect left clean", async () => {
  await setPii(undefined);
  await record([3]);
  const metadata = await metadataOf();
  expect(piiWithholdsPage(metadata, 3)).toBe(true);
  expect(piiWithholdsPage(metadata, 1)).toBe(false);
  const pii = (metadata as { pii: { withheldArtifactUris: string[]; withheldPages: number[] } }).pii;
  expect(pii.withheldPages).toEqual([3]);
  expect(pii.withheldArtifactUris).toEqual(expect.arrayContaining(["s3://b/source", "s3://b/page-3.png"]));
  expect(pii.withheldArtifactUris).not.toContain("s3://b/page-1.png");
});

it("appends to a page-scoped outcome and leaves an all-pages outcome alone", async () => {
  await setPii({ redacted: true, withheldArtifactUris: ["s3://b/source"], pageScoped: true, withheldPages: [2] });
  await record([3]);
  expect((await metadataOf() as { pii: { withheldPages: number[] } }).pii.withheldPages).toEqual([2, 3]);
  for (const pii of [{ blocked: true }, { redacted: true, withheldArtifactUris: ["s3://b/source"] }, { redacted: true, pageScoped: true, withheldPages: ["2"] }]) {
    await setPii(pii);
    await record([3]);
    const metadata = await metadataOf();
    expect((metadata as { pii: unknown }).pii).toEqual(pii);
    expect(piiWithholdsPage(metadata, 1)).toBe(true);
  }
});
