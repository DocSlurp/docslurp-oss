import { Writable } from "node:stream";
import path from "node:path";

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
  async deleteKeys(keys: string[]) { deleted.push(...keys); for (const key of keys) uploads.delete(key); },
  async listKeys({ prefix }: { prefix: string }) { return { keys: [...uploads.keys()].filter((key) => key.startsWith(prefix)) }; },
  async abortMultipartUploads() { return 0; },
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
    values (${id}, 'o', 'w', 'u', ${args.documentId ?? null}, ${args.content}, ${args.filename}, ${`exports/o/w/${id}/`}, now() + interval '7 days')
  `;
}

function unzip(id: string, attempt = 1) {
  const upload = uploads.get(`exports/o/w/${id}/a${attempt}.zip`);
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
    expect(upload.expires).toBeUndefined();
    expect(upload.metadata?.["docslurp-export-id"]).toBe("exp-1");
    const [row] = await sql<{ status: string; size_bytes: string; file_count: number; skipped_count: number; object_key: string; document_ids: string[]; ttl_days: number }[]>`
      select status, size_bytes, file_count, skipped_count, object_key, document_ids,
        round(extract(epoch from expires_at - completed_at) / 86400)::int as ttl_days
      from document_exports where id = 'exp-1'`;
    expect(row).toMatchObject({ status: "ready", file_count: 6, skipped_count: 0, object_key: "exports/o/w/exp-1/a1.zip", document_ids: ["doc-1"], ttl_days: 7 });
    expect(Number(row!.size_bytes)).toBe(upload.bytes.byteLength);
  });

  it("builds an extract download from its run only, under the extract prefix, never outliving the extract", async () => {
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline, artifacts, extract_id, storage_prefix)
      values ('ext-run', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', 2, '{}', '{"doc-x:markdown":"s3://bucket/extracts/o/ext_1/markdown/doc-x.md"}', 'ext_1', 'extracts/o/ext_1')
      on conflict (id) do nothing`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('doc-x', 'o', 'u', 'w', 'ext-run', 'Scan.pdf', 'application/pdf', 'extracts/o/ext_1/raw/scan.pdf', 'completed', 1),
             ('doc-y', 'o', 'u', 'w', 'ext-run', 'Broken.pdf', 'application/pdf', 'extracts/o/ext_1/raw/broken.pdf', 'failed', 0)
      on conflict (id) do nothing`;
    objects.set("extracts/o/ext_1/markdown/doc-x.md", text("# Scan"));
    await sql`insert into document_exports (id, org_id, workspace_id, user_id, run_id, content, filename, object_key, expires_at, max_expires_at)
      values ('exp-x', 'o', 'w', 'u', 'ext-run', 'markdown', 'Scan.zip', 'extracts/o/ext_1/exports/exp-x/', now() + interval '2 days', now() + interval '2 days')`;

    await buildDocumentExport({ sql, storage: storage as never }, "exp-x");

    const upload = uploads.get("extracts/o/ext_1/exports/exp-x/a1.zip");
    expect(upload).toBeDefined();
    // Only the run's completed document: nothing else in the workspace, not its failed one.
    expect(Object.keys(unzipSync(upload!.bytes)).some((name) => name.includes("Q3 plan") || name.includes("Broken"))).toBe(false);
    const [row] = await sql<{ document_ids: string[]; hours: number }[]>`
      select document_ids, round(extract(epoch from expires_at - now()) / 3600)::int as hours from document_exports where id = 'exp-x'`;
    expect(row).toEqual({ document_ids: ["doc-x"], hours: 48 });
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
    expect(readme).toContain("`q3 plan/`: still processing, so only metadata.json is included");
    expect(readme).toContain("`Q3 plan (2)/outputs/canonical-document.json`: NoSuchKey");
  });

  it("never exports files the PII policy withholds", async () => {
    await sql`update documents set metadata = ${sql.json({ pii: { withheldArtifactUris: ["s3://bucket/uploads/q3.pdf", "s3://bucket/md/doc-1.md"] } })} where id = 'doc-1'`;
    await queue("exp-3", { documentId: "doc-1", content: "all", filename: "Q3 plan.zip" });

    await buildDocumentExport({ sql, storage: storage as never }, "exp-3");

    const { files } = unzip("exp-3");
    expect(Object.keys(files).some((name) => name.includes("original/"))).toBe(false);
    expect(strFromU8(files["Q3 plan/README.md"]!)).toContain("`original/Q3 plan.pdf`: withheld by the workspace's privacy (PII) policy");
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
    deleted.length = 0;
    await queue("exp-7", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });
    const removing = { ...storage, openStream: async (key: string) => {
      await sql`delete from document_exports where id = 'exp-7'`;
      return storage.openStream(key);
    } };
    expect(await buildDocumentExport({ sql, storage: removing as never }, "exp-7")).toEqual({ status: "skipped" });
    expect(deleted).toEqual(["exports/o/w/exp-7/a1.zip"]);

    // A stale attempt finishing after another attempt made the export ready drops only its own zip.
    await queue("exp-8", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });
    const racing = { ...storage, openStream: async (key: string) => {
      await sql`update document_exports set status = 'ready', object_key = 'exports/o/w/exp-8/a2.zip' where id = 'exp-8'`;
      return storage.openStream(key);
    } };
    deleted.length = 0;
    expect(await buildDocumentExport({ sql, storage: racing as never }, "exp-8", { attempt: 1 })).toEqual({ status: "skipped" });
    expect(deleted).toEqual(["exports/o/w/exp-8/a1.zip"]);
    expect((await sql`select status, object_key from document_exports where id = 'exp-8'`)[0]).toEqual({ status: "ready", object_key: "exports/o/w/exp-8/a2.zip" });

    await queue("exp-6", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });
    await sql`update document_exports set expires_at = now() - interval '1 minute' where id = 'exp-6'`;
    expect(await buildDocumentExport({ sql, storage: storage as never }, "exp-6")).toEqual({ status: "skipped" });
  });

  it("keeps the live version while a newer upload of it is pending or failed", async () => {
    await sql`insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count,previous_version_id)
      values('doc-1-v2','o','u','w','run','Q3 plan.pdf','application/pdf','uploads/q3-v2.pdf','processing',0,'doc-1')`;
    await queue("exp-9", { content: "markdown", filename: "Finance.zip" });

    await buildDocumentExport({ sql, storage: storage as never }, "exp-9");

    const { files } = unzip("exp-9");
    // Both rows are live until the new version completes and supersedes doc-1.
    expect(strFromU8(files["Finance/Q3 plan (2)/Q3 plan (2).md"]!)).toContain("# Q3 plan");
    expect(Object.keys(files)).toContain("Finance/Q3 plan (3)/metadata.json");
    await sql`delete from documents where id = 'doc-1-v2'`;
  });

  it("writes each attempt to its own key and clears other attempts' zips when ready", async () => {
    await queue("exp-10", { documentId: "doc-1", content: "markdown", filename: "Q3 plan.zip" });
    uploads.set("exports/o/w/exp-10/a1.zip", { bytes: new Uint8Array([1]) });

    await buildDocumentExport({ sql, storage: storage as never }, "exp-10", { attempt: 2 });

    expect([...uploads.keys()].filter((key) => key.startsWith("exports/o/w/exp-10/"))).toEqual(["exports/o/w/exp-10/a2.zip"]);
    expect((await sql`select object_key from document_exports where id = 'exp-10'`)[0]).toEqual({ object_key: "exports/o/w/exp-10/a2.zip" });
  });
});

describe("embedded images in exports", () => {
  const base = (over: Record<string, unknown>) => ({
    role: "image", sha256: "a".repeat(64), mediaType: "image/webp", width: 4, height: 4,
    source: { objectId: null, inline: false, encoding: "image", colorSpace: "rgb", components: 3, bitsPerComponent: 8, interpolate: false, ppi: [null, null], streamBytes: null },
    placement: { status: "unknown", reason: "no-placement-source" }, alt: null, signals: null, signalsUnavailable: "not-measured",
    class: { label: "figure", confidence: 0.5, signals: [] }, route: { action: "keep", reason: "unclassified-figure" },
    ...over,
  });
  const md = (page: number, occ: number, included: boolean) => ({ markdown: { included, anchor: `p${page}o${occ}`, block: included ? 0 : null, method: included ? "page-end" : null } });
  const ref = (id: string, occ: string) => `docslurp-artifact:${id}#${occ}`;
  const uri = (n: number) => `s3://bucket/graph/doc-img/${n}`;
  const ids = { logo: "doc-img:logo.webp", mask: "doc-img:mask.webp", secret: "doc-img:secret.webp", missing: "doc-img:missing.webp", decor: "doc-img:decor.webp", foreign: "doc-img:foreign.webp" };
  const mediaMap = {
    version: "docslurp-media-map@2", pageCount: 3, encoding: "lossless-webp", minWidth: 1, minHeight: 1, masks: "separate-linked-assets",
    placementSource: "none", coordinateSpace: "pdf-points-top-left",
    routing: { table: "image-routing@1", routedImages: 0, cap: 64, counts: { keep: 5, skip: 1 } },
    images: [
      base({ pageNumber: 1, occurrence: 0, artifactId: ids.logo, alt: { text: "Logo", source: "marked-content" }, ...md(1, 0, true) }),
      base({ pageNumber: 1, occurrence: 1, role: "smask", maskOf: { pageNumber: 1, occurrence: 0 }, artifactId: ids.mask, class: { label: "mask", confidence: 1, signals: [] }, route: { action: "skip", reason: "mask" }, ...md(1, 1, false) }),
      base({ pageNumber: 2, occurrence: 0, artifactId: ids.logo, ...md(2, 0, true) }),
      base({ pageNumber: 2, occurrence: 1, artifactId: ids.decor, route: { action: "skip", reason: "decorative" }, ...md(2, 1, false) }),
      base({ pageNumber: 2, occurrence: 2, artifactId: ids.secret, alt: { text: "Secret chart", source: "marked-content" }, ...md(2, 2, true) }),
      base({ pageNumber: 3, occurrence: 0, artifactId: ids.missing, ...md(3, 0, true) }),
      base({ pageNumber: 3, occurrence: 1, artifactId: ids.foreign, ...md(3, 1, true) }),
    ],
  };
  const manifest = { documentId: "doc-img", artifacts: [
    { id: "doc-img:source", kind: "source/pdf", uri: "s3://bucket/uploads/img.pdf", mediaType: "application/pdf", placements: [] },
    { id: ids.logo, kind: "page/embedded-image", uri: uri(1), mediaType: "image/webp", placements: [{ pageNumber: 1 }, { pageNumber: 2 }] },
    { id: ids.mask, kind: "page/embedded-image-mask", uri: uri(2), mediaType: "image/webp", placements: [{ pageNumber: 1 }] },
    { id: ids.secret, kind: "page/embedded-image", uri: uri(3), mediaType: "image/webp", placements: [{ pageNumber: 2 }] },
    { id: ids.missing, kind: "page/embedded-image", uri: uri(4), mediaType: "image/webp", placements: [{ pageNumber: 3 }] },
    { id: ids.decor, kind: "page/embedded-image", uri: uri(6), mediaType: "image/webp", placements: [{ pageNumber: 2 }] },
    // Named by the manifest but not recorded for this document: another tenant's object must never be read.
    { id: ids.foreign, kind: "page/embedded-image", uri: "s3://bucket/other-tenant/secret.webp", mediaType: "image/webp", placements: [{ pageNumber: 3 }] },
    { id: "doc-img:media-map.json", kind: "document/media-map", uri: uri(5), mediaType: "application/json", placements: [] },
  ] };
  const page1 = `# Report\n\n${`![Logo](${ref(ids.logo, "p1o0")})`}\n\nIntro text.`;
  const page2 = `![](${ref(ids.logo, "p2o0")})\n\nBody.\n\n![Secret chart](${ref(ids.secret, "p2o2")})`;
  const page3 = `![](${ref(ids.missing, "p3o0")})\n\n![Stolen](${ref(ids.foreign, "p3o1")})\n\nEnd.`;

  beforeAll(async () => {
    await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,total_documents,pipeline,artifacts)
      values('run-img','o','u','w','bulk-upload','completed','completed',1,'{}',${sql.json({
        "doc-img:markdown": "s3://bucket/md/doc-img.md",
        "doc-img:artifact-graph": "s3://bucket/graph/doc-img/manifest.json",
        "doc-img:embedded-image-artifact:0": uri(1), "doc-img:embedded-image-artifact:1": uri(2), "doc-img:embedded-image-artifact:2": uri(3),
        "doc-img:embedded-image-artifact:3": uri(4), "doc-img:embedded-image-artifact:4": uri(5), "doc-img:embedded-image-artifact:5": uri(6),
      })}) on conflict (id) do nothing`;
    await sql`insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count,metadata)
      values('doc-img','o','u','w-img','run-img','Images.pdf','application/pdf','uploads/img.pdf','completed',3,${sql.json({ pii: { withheldArtifactUris: [uri(3)] } })})
      on conflict (id) do nothing`.catch(async () => {
        await sql`insert into workspaces(id,org_id,user_id,name) values('w-img','o','u','Images') on conflict do nothing`;
        await sql`insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status,page_count,metadata)
          values('doc-img','o','u','w-img','run-img','Images.pdf','application/pdf','uploads/img.pdf','completed',3,${sql.json({ pii: { withheldArtifactUris: [uri(3)] } })})`;
      });
    await sql`insert into document_pages(id,document_id,run_id,user_id,page_number,text)
      values('pi1','doc-img','run-img','u',1,${page1}),('pi2','doc-img','run-img','u',2,${page2}),('pi3','doc-img','run-img','u',3,${page3})
      on conflict do nothing`;
  });

  function seedObjects() {
    objects.set("md/doc-img.md", text(`${page1}\f${page2}\f${page3}\n`));
    objects.set("graph/doc-img/manifest.json", text(JSON.stringify(manifest)));
    objects.set("graph/doc-img/1", new Uint8Array([1, 1, 1]));
    objects.set("graph/doc-img/2", new Uint8Array([2, 2]));
    objects.set("graph/doc-img/3", new Uint8Array([3]));
    objects.set("graph/doc-img/5", text(JSON.stringify(mediaMap)));
    objects.set("graph/doc-img/6", new Uint8Array([6]));
    objects.set("other-tenant/secret.webp", new Uint8Array([9, 9, 9]));
    objects.set("uploads/img.pdf", text("%PDF"));
  }

  async function exportImages(id: string, content: "markdown" | "all") {
    seedObjects();
    await sql`insert into document_exports (id, org_id, workspace_id, user_id, document_id, content, filename, object_key, expires_at)
      values (${id}, 'o', 'w-img', 'u', 'doc-img', ${content}, 'Images.zip', ${`exports/o/w/${id}/`}, now() + interval '7 days')`;
    await buildDocumentExport({ sql, storage: storage as never }, id);
    return unzip(id).files;
  }

  /** Every relative Markdown link must name a file inside the zip. */
  function expectLinksResolve(files: Record<string, Uint8Array>) {
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.endsWith(".md") || name.endsWith("README.md")) continue;
      for (const [, target] of strFromU8(bytes).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        expect(target).not.toContain("docslurp-artifact:");
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target!));
        expect(files[resolved], `${name} links to ${target}`).toBeDefined();
      }
    }
  }

  it("stitches Markdown to per-page image files, stores a repeated logo once and keeps masks beside their image", async () => {
    const files = await exportImages("exp-img-1", "markdown");
    const names = Object.keys(files).filter((name) => name.includes("/images/")).sort();
    expect(names).toEqual(["Images/images/index.json", "Images/images/page-0001/image-001.smask.webp", "Images/images/page-0001/image-001.webp"]);
    expect([...files["Images/images/page-0001/image-001.webp"]!]).toEqual([1, 1, 1]);
    const markdown = strFromU8(files["Images/Images.md"]!);
    expect(markdown).toContain("![Logo](images/page-0001/image-001.webp)");
    expect(markdown).toContain("![](images/page-0001/image-001.webp)\n\nBody.");   // page 2 repeats the logo: same file
    expect(markdown).not.toContain("docslurp-artifact:");
    // Withheld, missing and foreign images keep only their alt text.
    expect(markdown).toContain("\n\nSecret chart");
    expect(markdown).toContain("\n\nStolen\n\nEnd.");
    expect(strFromU8(files["Images/pages/page-0001.md"]!)).toContain("![Logo](../images/page-0001/image-001.webp)");
    expect(strFromU8(files["Images/pages/page-0002.md"]!)).toContain("![](../images/page-0001/image-001.webp)");
    expectLinksResolve(files);
    // No other tenant's object, and nothing the PII policy withholds, is read into the zip.
    expect(Object.values(files).some((bytes) => bytes.length === 3 && bytes[0] === 9)).toBe(false);
    expect(Object.values(files).some((bytes) => bytes.length === 1 && bytes[0] === 3)).toBe(false);
    const index = JSON.parse(strFromU8(files["Images/images/index.json"]!));
    expect(index).toMatchObject({ version: "docslurp-export-images@1", documentId: "doc-img", source: "media-map", pageCount: 3 });
    const byAnchor = Object.fromEntries(index.images.map((image: { anchor: string }) => [image.anchor, image]));
    expect(byAnchor.p1o0.path).toBe("images/page-0001/image-001.webp");
    expect(byAnchor.p1o1).toMatchObject({ path: "images/page-0001/image-001.smask.webp", maskOf: { pageNumber: 1, occurrence: 0 } });
    expect(byAnchor.p2o0.path).toBe("images/page-0001/image-001.webp");
    expect(byAnchor.p2o2).toMatchObject({ path: null, skipped: "withheld by the workspace's privacy (PII) policy" });
    expect(byAnchor.p3o0.path).toBeNull();
    expect(byAnchor.p3o1).toMatchObject({ path: null, skipped: "image artifact missing from the run" });
    expect(byAnchor.p2o1).toBeUndefined();   // not referenced by the Markdown: only in full exports
    const readme = strFromU8(files["Images/README.md"]!);
    expect(readme).toContain("`images/page-0002/image-003.webp`: withheld by the workspace's privacy (PII) policy");
    expect(readme).toContain("`images/page-0003/image-001.webp`: NoSuchKey");
    expect(readme).toContain("`images/page-0003/image-002.webp`: image artifact missing from the run");
    expect(readme).toContain("images/page-0001/image-001.webp");
  });

  it("adds every embedded image to a full export and still links only files it holds", async () => {
    const files = await exportImages("exp-img-2", "all");
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      "Images/images/page-0001/image-001.webp", "Images/images/page-0001/image-001.smask.webp", "Images/images/page-0002/image-002.webp", "Images/images/index.json",
    ]));
    expect(Object.keys(files).some((name) => name.includes("page-0002/image-001") || name.includes("page-0002/image-003"))).toBe(false);
    expectLinksResolve(files);
  });

  it("drops image links when the zip cannot hold the files", async () => {
    seedObjects();
    await sql`insert into document_exports (id, org_id, workspace_id, user_id, document_id, content, filename, object_key, expires_at)
      values ('exp-img-3', 'o', 'w-img', 'u', 'doc-img', 'markdown', 'Images.zip', 'exports/o/w/exp-img-3/', now() + interval '7 days')`;
    await buildDocumentExport({ sql, storage: storage as never }, "exp-img-3", { maxBytes: 1 });
    const { files } = unzip("exp-img-3");
    expect(Object.keys(files).some((name) => name.endsWith(".webp"))).toBe(false);
    expect(strFromU8(files["Images/README.md"]!)).toContain("export size limit reached");
    expectLinksResolve(files);
  });
});
