import { Writable } from "node:stream";

import { strFromU8, unzipSync } from "fflate";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { artifactExportPath, buildDocumentExport } from "./build-document-export.js";

let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let server: Awaited<ReturnType<typeof serveOnRandomPort>>["server"];
let sql: postgres.Sql<Record<string, unknown>>;

const objects = new Map<string, Uint8Array>();
const uploads = new Map<string, { bytes: Uint8Array; expires?: Date; metadata?: Record<string, string> }>();
const text = (value: string) => new TextEncoder().encode(value);

const deleted: string[] = [];
const storage = {
  bucket: "bucket",
  async deleteKeys(keys: string[]) { deleted.push(...keys); },
  async openStream(key: string) {
    const bytes = objects.get(key);
    if (!bytes) throw new Error(`NoSuchKey ${key}`);
    return { stream: (async function* () { yield bytes; })(), size: bytes.byteLength };
  },
  createMultipartUploadStream(key: string, _type: string, options?: { object?: { expires?: Date; metadata?: Record<string, string> } }) {
    const parts: Buffer[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((settle) => { resolve = settle; });
    const writable = new Writable({
      write(chunk, _encoding, callback) { parts.push(Buffer.from(chunk)); callback(); },
      final(callback) {
        uploads.set(key, { bytes: new Uint8Array(Buffer.concat(parts)), ...options?.object });
        resolve();
        callback();
      },
    });
    return { writable, done };
  },
};

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`insert into "user"(id,name,email) values('u','User','u@example.invalid');
    insert into organizations(id,name,created_by_user_id) values('o','Org','u');
    insert into workspaces(id,org_id,user_id,name) values('w','o','u','Finance');
    insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,total_documents,pipeline,artifacts)
      values('run','o','u','w','bulk-upload','completed','completed',3,'{}','{
        "doc-1:markdown":"s3://bucket/md/doc-1.md",
        "doc-1:structured":"s3://bucket/st/doc-1.json",
        "doc-1:page-2":"s3://bucket/pages/doc-1-2.png",
        "doc-1:html":"s3://bucket/html/doc-1.html",
        "doc-1:embeddings":"s3://bucket/embed/doc-1.json",
        "doc-1:canonical-document":"s3://bucket/missing.json",
        "doc-2:markdown":"s3://bucket/md/doc-2.md"
      }');
    insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count)
      values('doc-1','o','u','w','run','Q3 plan.pdf','application/pdf','uploads/q3.pdf','completed',2),
            ('doc-2','o','u','w','run','q3 plan.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','uploads/q3.docx','processing',1),
            ('doc-old','o','u','w','run','Old.pdf','application/pdf','uploads/old.pdf','completed',1);
    update documents set superseded_at = now() where id = 'doc-old';
    insert into document_pages(id,document_id,run_id,user_id,page_number,text)
      values('p1','doc-1','run','u',1,'Page one'),('p2','doc-1','run','u',2,'Page two');
    insert into document_tags(document_id,user_id,tag) values('doc-1','u','finance');`);
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  objects.clear();
  uploads.clear();
  deleted.length = 0;
  objects.set("md/doc-1.md", text("# Q3 plan\n\nPage one\n\nPage two\n"));
  objects.set("st/doc-1.json", text("{\"total\":3}"));
  objects.set("pages/doc-1-2.png", new Uint8Array([1, 2]));
  objects.set("html/doc-1.html", text("<p>hi</p>"));
  objects.set("uploads/q3.pdf", text("%PDF"));
  objects.set("uploads/q3.docx", text("PK"));
  await sql`delete from document_exports`;
});

async function queue(id: string, args: { documentId?: string; content: "markdown" | "all"; filename: string }) {
  await sql`
    insert into document_exports (id, org_id, workspace_id, user_id, document_id, content, filename, object_key, expires_at)
    values (${id}, 'o', 'w', 'u', ${args.documentId ?? null}, ${args.content}, ${args.filename}, ${`exports/o/w/${id}.zip`}, now() + interval '7 days')
  `;
}

function unzip(id: string) {
  const upload = uploads.get(`exports/o/w/${id}.zip`);
  expect(upload).toBeDefined();
  return { files: unzipSync(upload!.bytes), upload: upload! };
}

describe("buildDocumentExport", () => {
  it("maps page images and readable outputs, and leaves out indexes", () => {
    expect(artifactExportPath("page-12", "pages/p.webp")).toEqual({ path: "images/page-0012.webp", compress: false });
    expect(artifactExportPath("html", "html/x.html")).toEqual({ path: "outputs/html.html", compress: true });
    expect(artifactExportPath("embeddings", "e.json")).toBeNull();
  });

  it("exports one document's Markdown, pages, structured data and metadata", async () => {
    await queue("exp-1", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });

    await buildDocumentExport({ sql, storage: storage as never }, "exp-1");

    const { files, upload } = unzip("exp-1");
    expect(Object.keys(files).sort()).toEqual([
      "Q3 plan/Q3 plan.md",
      "Q3 plan/README.md",
      "Q3 plan/metadata.json",
      "Q3 plan/pages/page-0001.md",
      "Q3 plan/pages/page-0002.md",
      "Q3 plan/structured.json",
    ]);
    expect(strFromU8(files["Q3 plan/pages/page-0002.md"]!)).toBe("Page two");
    expect(JSON.parse(strFromU8(files["Q3 plan/structured.json"]!))).toEqual({ total: 3 });
    expect(JSON.parse(strFromU8(files["Q3 plan/metadata.json"]!))).toMatchObject({ id: "doc-1", tags: ["finance"], pageCount: 2 });
    expect(upload.metadata?.["docslurp-expires-at"]).toBe(upload.expires?.toISOString());
    const [row] = await sql<{ status: string; size_bytes: string; file_count: number; skipped_count: number }[]>`
      select status, size_bytes, file_count, skipped_count from document_exports where id = 'exp-1'`;
    expect(row).toMatchObject({ status: "ready", file_count: 6, skipped_count: 0 });
    expect(Number(row!.size_bytes)).toBe(upload.bytes.byteLength);
  });

  it("adds originals, page images and outputs for a full workspace export, and lists what it could not read", async () => {
    await queue("exp-2", { content: "all", filename: "Finance.zip" });

    await buildDocumentExport({ sql, storage: storage as never }, "exp-2");

    const { files } = unzip("exp-2");
    const names = Object.keys(files);
    expect(names).toEqual(expect.arrayContaining([
      "Finance/q3 plan/original/q3 plan.docx",
      "Finance/q3 plan/metadata.json",
      "Finance/Q3 plan (2)/original/Q3 plan.pdf",
      "Finance/Q3 plan (2)/images/page-0002.png",
      "Finance/Q3 plan (2)/outputs/html.html",
      "Finance/README.md",
    ]));
    // Superseded versions, indexes and another document's artifacts stay out; unfinished documents have no Markdown yet.
    expect(names.some((name) => name.includes("Old") || name.includes("embeddings") || name.endsWith("q3 plan/q3 plan.md"))).toBe(false);
    const readme = strFromU8(files["Finance/README.md"]!);
    expect(readme).toContain("| q3 plan | q3 plan.docx | 1 | processing |");
    expect(readme).toContain("`Q3 plan (2)/outputs/canonical-document.json`: NoSuchKey");
  });

  it("never exports files the PII policy withholds", async () => {
    await sql`update documents set metadata = ${sql.json({ pii: { withheldArtifactUris: ["s3://bucket/uploads/q3.pdf", "s3://bucket/md/doc-1.md"] } })} where id = 'doc-1'`;
    await queue("exp-3", { documentId: "doc-1", content: "all", filename: "Q3 plan.zip" });

    await buildDocumentExport({ sql, storage: storage as never }, "exp-3");

    const { files } = unzip("exp-3");
    expect(Object.keys(files).some((name) => name.includes("original/"))).toBe(false);
    // The withheld Markdown falls back to the indexed (post-policy) page text.
    expect(strFromU8(files["Q3 plan/Q3 plan.md"]!)).toBe("Page one\n\nPage two");
    await sql`update documents set metadata = '{}' where id = 'doc-1'`;
  });

  it("skips files past the size limit and says so", async () => {
    await queue("exp-4", { documentId: "doc-1", content: "all", filename: "Q3 plan.zip" });

    await buildDocumentExport({ sql, storage: storage as never }, "exp-4", { maxBytes: 40 });

    const { files } = unzip("exp-4");
    expect(strFromU8(files["Q3 plan/README.md"]!)).toContain("export size limit reached");
  });

  it("records a failure only on the final attempt, and never rebuilds an expired export", async () => {
    await queue("exp-5", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });
    const broken = { ...storage, createMultipartUploadStream: () => { throw new Error("storage down"); } };

    await expect(buildDocumentExport({ sql, storage: broken as never }, "exp-5", { final: false })).rejects.toThrow("storage down");
    expect((await sql`select status from document_exports where id = 'exp-5'`)[0]).toEqual({ status: "running" });
    await expect(buildDocumentExport({ sql, storage: broken as never }, "exp-5", { final: true })).rejects.toThrow("storage down");
    expect((await sql`select status, error from document_exports where id = 'exp-5'`)[0]).toMatchObject({ status: "failed" });

    // An export removed while it was building (its document was deleted) cleans up its own upload.
    await queue("exp-7", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });
    const removing = { ...storage, openStream: async (key: string) => {
      await sql`delete from document_exports where id = 'exp-7'`;
      return storage.openStream(key);
    } };
    expect(await buildDocumentExport({ sql, storage: removing as never }, "exp-7")).toEqual({ status: "skipped" });
    expect(deleted).toEqual(["exports/o/w/exp-7.zip"]);

    await queue("exp-6", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });
    await sql`update document_exports set expires_at = now() - interval '1 minute' where id = 'exp-6'`;
    expect(await buildDocumentExport({ sql, storage: storage as never }, "exp-6")).toEqual({ status: "skipped" });
  });
});
