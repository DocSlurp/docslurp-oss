import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createMigratedDatabase,
  applyRemainingMigrations,
} from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
const mocks = vi.hoisted(() => ({ render: vi.fn(), persist: vi.fn() }));
vi.mock("../pipeline/pdf-asset-cache.js", () => ({
  PdfRasterCache: class {
    renderSelectedPages = mocks.render;
  },
  PdfSourceCache: class {
    async clear() {}
  },
}));
vi.mock("../db/usage-event-store.js", () => ({
  persistScopedUsageEvents: mocks.persist,
}));
import { renderDocumentPage } from "./render-page.js";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let server: Awaited<ReturnType<typeof serveOnRandomPort>>["server"];
let sql: postgres.Sql<Record<string, unknown>>;
const document = {
  id: "doc",
  runId: "run",
  userId: "u",
  status: "completed",
  mimeType: "application/pdf",
  pageCount: 1,
};
const deps = () =>
  ({
    store: { stageSql: sql, loadDocument: async () => document },
    runner: {},
    storage: {},
  }) as never;
beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: "page_render_dpi" });
  await db.exec(`insert into "user"(id,name,email) values('u','User','u@example.invalid');
    insert into organizations(id,name,created_by_user_id) values('o','Org','u');
    insert into workspaces(id,org_id,user_id,name) values('w','o','u','Workspace');
    insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,total_documents,pipeline)
      values('run','o','u','w','bulk-upload','completed','completed',1,'{}');
    insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count)
      values('doc','o','u','w','run','a.pdf','application/pdf','source','completed',1);
    insert into document_page_renders(document_id,run_id,page_number,org_id,workspace_id,quality,expires_at)
      values('doc','run',1,'o','w','reader',now()+interval '10 minutes'),('doc','run',1,'o','w','export',now()+interval '10 minutes');`);
  await applyRemainingMigrations(db, "page_render_dpi");
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
}, 60000);
afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("DOCSLURP_BILL_COMPUTE", "false");
  vi.stubEnv("DOCSLURP_BILL_STORAGE", "false");
  vi.stubEnv("BILLING_EXEMPT_ORG_IDS", "");
});
it("migrates existing reader/export demand without deletion and gives it conservative 120 DPI", async () => {
  expect(
    await sql`select quality,dpi from document_page_renders order by quality`,
  ).toEqual([
    { quality: "export", dpi: 120 },
    { quality: "reader", dpi: 120 },
  ]);
  await expect(sql`update document_page_renders set dpi=999`).rejects.toThrow();
});
it("keeps paid 250 demand while an admitted free 120 export finishes after funding", async () => {
  await sql`delete from document_page_renders`;
  await sql`update organizations set funded_at=null where id='o'`;
  await sql`insert into document_page_renders(document_id,run_id,page_number,org_id,workspace_id,quality,dpi,expires_at) values('doc','run',1,'o','w','export',120,now()+interval '10 minutes')`;
  let releaseLow!: () => void, releaseHigh!: () => void;
  const lowBarrier = new Promise<void>((resolve) => {
      releaseLow = resolve;
    }),
    highBarrier = new Promise<void>((resolve) => {
      releaseHigh = resolve;
    });
  mocks.render.mockImplementation(async ({ dpi }: { dpi: number }) => {
    await (dpi === 120 ? lowBarrier : highBarrier);
    return [{ artifactUri: `s3://page-${dpi}`, cacheHit: false }];
  });
  const low = renderDocumentPage(deps(), {
    documentId: "doc",
    runId: "run",
    pageNumber: 1,
    quality: "export",
    dpi: 120,
  });
  await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
  await sql`update organizations set funded_at=now() where id='o'`;
  await sql`insert into document_page_renders(document_id,run_id,page_number,org_id,workspace_id,quality,dpi,expires_at) values('doc','run',1,'o','w','export',250,now()+interval '10 minutes')`;
  const high = renderDocumentPage(deps(), {
    documentId: "doc",
    runId: "run",
    pageNumber: 1,
    quality: "export",
    dpi: 250,
  });
  await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
  releaseLow();
  await low;
  expect(await sql`select dpi from document_page_renders`).toEqual([
    { dpi: 250 },
  ]);
  releaseHigh();
  await high;
  expect(await sql`select dpi from document_page_renders`).toEqual([]);
  const [run] = await sql`select artifacts from workspace_runs where id='run'`;
  expect(run!.artifacts).toEqual({
    "doc:raster-v3-export-120dpi-page-1": "s3://page-120",
    "doc:raster-v3-export-250dpi-page-1": "s3://page-250",
  });
});
it("clears a repeatedly renewed same-DPI demand when matching cached pixels already exist", async () => {
  await sql`delete from document_page_renders`;
  await sql`update organizations set funded_at=now() where id='o'`;
  await sql`update workspace_runs set artifacts=${sql.json({ "doc:raster-v3-export-250dpi-page-1": "s3://page-250" })}::jsonb where id='run'`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sql`insert into document_page_renders(document_id,run_id,page_number,org_id,workspace_id,quality,dpi,expires_at) values('doc','run',1,'o','w','export',250,now()+interval '10 minutes') on conflict(document_id,run_id,page_number,quality,dpi) do update set expires_at=excluded.expires_at`;
  }
  await renderDocumentPage(deps(), {
    documentId: "doc",
    runId: "run",
    pageNumber: 1,
    quality: "export",
    dpi: 250,
  });
  expect(await sql`select dpi from document_page_renders`).toEqual([]);
  expect(mocks.render).not.toHaveBeenCalled();
});
