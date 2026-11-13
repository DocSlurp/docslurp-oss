import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

vi.mock("../config.js", async (original) => ({ ...await original<typeof import("../config.js")>(), env: { ...(await original<typeof import("../config.js")>()).env, s3Bucket: "bucket" } }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let documents: typeof import("../services/documents.js");

const DOC_A = "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b";
const DOC_B = "7d1c2b3a-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
// Doppler's folder layout: `<artifact root>/doppler/<document>/images/page-NNNN/(image|figure)-NNN.<ext>`.
const figureA = `s3://bucket/ua/ra/doppler/${DOC_A}/images/page-0003/figure-002.svg`;
const figureB = `s3://bucket/ub/rb/doppler/${DOC_B}/images/page-0001/image-001.webp`;
const unrecorded = `s3://bucket/ua/ra/doppler/${DOC_A}/images/page-0009/image-001.webp`;
const manifestA = `s3://bucket/ua/ra/doppler/${DOC_A}/images/manifest.json`;
const factsA = `s3://bucket/ua/ra/doppler/${DOC_A}/images/page-facts.jsonl`;
const markdownA = `s3://bucket/ua/ra/doppler/${DOC_A}/document.md`;
const sourceA = `s3://bucket/ua/ra/doppler/${DOC_A}/source.json`;

/**
 * Doppler figure files are authorized exactly like every other document artifact: by their exact URI in the document's
 * run artifact slots (`<document>:doppler-figure:<id>`), within the caller's projects and organization, minus PII
 * withholding. These are the negative cases the security rules require, on a migrated database.
 */
describe("Doppler figure access", () => {
  beforeAll(async () => {
    const database = await startMigratedPostgres();
    stop = database.stop;
    sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql }));
    await sql`insert into "user" (id, name, email) values ('ua', 'A', 'a@figures.test'), ('ub', 'B', 'b@figures.test')`;
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('oa', 'Org A', 'figures-a', 'ua'), ('ob', 'Org B', 'figures-b', 'ub')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('oa', 'ua', 'owner'), ('ob', 'ub', 'owner')`;
    await sql`insert into projects (id, org_id, user_id, name) values ('pa', 'oa', 'ua', 'A'), ('pb', 'ob', 'ub', 'B')`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, artifacts) values
      ('ra', 'oa', 'ua', 'pa', 'bulk-upload', 'completed', 'completed', '{}', ${sql.json({
        [`${DOC_A}:doppler-figure:p3.g2`]: figureA, [`${DOC_A}:doppler-figures`]: `s3://bucket/ua/ra/doppler/${DOC_A}/index.json`,
        [`${DOC_A}:doppler-manifest`]: manifestA, [`${DOC_A}:doppler-page-facts`]: factsA, [`${DOC_A}:doppler-markdown`]: markdownA,
      })}),
      ('rb', 'ob', 'ub', 'pb', 'bulk-upload', 'completed', 'completed', '{}', ${sql.json({ [`${DOC_B}:doppler-figure:p1.1`]: figureB })})`;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status) values
      (${DOC_A}, 'oa', 'ua', 'pa', 'ra', 'a.pdf', 'application/pdf', 'ua/a.pdf', 'completed'),
      (${DOC_B}, 'ob', 'ub', 'pb', 'rb', 'b.pdf', 'application/pdf', 'ub/b.pdf', 'completed')`;
    documents = await import("../services/documents.js");
  }, 120_000);
  afterAll(async () => { await sql?.end(); await stop?.(); });

  it("lets the owner's session and an in-org key read a recorded figure", async () => {
    expect(await documents.userCanAccessArtifactUri(figureA, "ua")).toBe(true);
    expect(await documents.userCanAccessArtifactUri(figureA, "ua", "oa")).toBe(true);
  });

  it("refuses another tenant's figure, both ways", async () => {
    expect(await documents.userCanAccessArtifactUri(figureB, "ua")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(figureA, "ub")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(figureA, "ub", "ob")).toBe(false);
  });

  it("refuses a key bound to another organization and a figure file no run recorded", async () => {
    expect(await documents.userCanAccessArtifactUri(figureA, "ua", "ob")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(unrecorded, "ua")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(figureA.replace("s3://bucket/", "s3://other-bucket/"), "ua")).toBe(false);
  });

  it("stops serving at once when membership is revoked or the PII policy withholds the figure", async () => {
    await sql`delete from org_memberships where org_id = 'oa' and user_id = 'ua'`;
    expect(await documents.userCanAccessArtifactUri(figureA, "ua")).toBe(false);
    await sql`insert into org_memberships (org_id, user_id, role) values ('oa', 'ua', 'owner')`;
    expect(await documents.userCanAccessArtifactUri(figureA, "ua")).toBe(true);
    await sql`update documents set metadata = ${sql.json({ pii: { withheldArtifactUris: [figureA] } })} where id = ${DOC_A}`;
    expect(await documents.userCanAccessArtifactUri(figureA, "ua")).toBe(false);
    await sql`update documents set metadata = '{}'::jsonb where id = ${DOC_A}`;
  });

  it("authorizes the folder's manifest, page facts and Markdown like the figures, and withholds them under the PII policy", async () => {
    for (const uri of [manifestA, factsA, markdownA]) {
      expect(await documents.userCanAccessArtifactUri(uri, "ua"), uri).toBe(true);
      expect(await documents.userCanAccessArtifactUri(uri, "ub"), uri).toBe(false);
      expect(await documents.userCanAccessArtifactUri(uri, "ua", "ob"), uri).toBe(false);
    }
    await sql`update documents set metadata = ${sql.json({ pii: { withheldArtifactUris: [manifestA, factsA, markdownA] } })} where id = ${DOC_A}`;
    for (const uri of [manifestA, factsA, markdownA]) expect(await documents.userCanAccessArtifactUri(uri, "ua"), uri).toBe(false);
    await sql`update documents set metadata = '{}'::jsonb where id = ${DOC_A}`;
  });

  it("never authorizes the source pointer, which no slot records", async () => {
    expect(await documents.userCanAccessArtifactUri(sourceA, "ua")).toBe(false);
  });
});
