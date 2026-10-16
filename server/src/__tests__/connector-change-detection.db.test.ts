import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Connector re-syncs detect unchanged files by the same metadata keys the
 * intake writes (connectorFileId / connectorPath / connectorEtag).
 */
const key = randomBytes(32);
const file = { id: "f1", path: "docs/a.pdf", name: "a.pdf", mimeType: "application/pdf", size: 4, etag: "etag-1" };
const listFiles = vi.fn();
const intake = vi.fn();
let sql: postgres.Sql;
let stop: () => Promise<void>;
let runConnectorSync: typeof import("../routes/connectors.js").runConnectorSync;

function encrypted(): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update("{}", "utf-8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/encryption.js", () => ({ getRequiredEncryptionKey: () => key }));
  vi.doMock("../services/connectors/index.js", () => ({
    getConnectorAdapter: () => ({ listFiles, downloadFile: async () => Buffer.from("%PDF") }),
  }));
  vi.doMock("../services/workspace-intake.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/workspace-intake.js")>()),
    intakeIntoWorkspace: async (request: { items: AsyncIterable<unknown> }) => {
      const items: unknown[] = [];
      for await (const item of request.items) items.push(item);
      intake(items);
      return null;
    },
  }));
  ({ runConnectorSync } = await import("../routes/connectors.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W')`;
  await sql`insert into workspace_connectors (id, workspace_id, type, name, credentials_encrypted) values ('c', 'w', 's3', 'B', ${encrypted()})`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  intake.mockReset();
  listFiles.mockReset().mockResolvedValue([file]);
  await sql`delete from documents`;
  await sql`delete from connector_sync_log`;
});

async function sync() {
  await sql`insert into connector_sync_log (id, connector_id) values (${`log-${Math.random()}`}, 'c') `;
  const [log] = await sql<{ id: string }[]>`select id from connector_sync_log order by started_at desc limit 1`;
  const [row] = await sql`select * from workspace_connectors where id = 'c'`;
  await runConnectorSync(row as never, log!.id);
}

async function seedDocument(etag: string) {
  // Same shape the connector intake writes into documents.metadata.
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, filename, mime_type, source_key, status, metadata)
    values ('d1', 'o', 'u', 'w', 'a.pdf', 'application/pdf', 'u/raw/a.pdf', 'completed',
      ${sql.json({ connectorId: "c", connectorFileId: "f1", connectorPath: "docs/a.pdf", connectorEtag: etag })})
  `;
}

describe("connector sync change detection", () => {
  it("skips a file whose id and etag match an already ingested document", async () => {
    await seedDocument("etag-1");
    await sync();
    expect(intake).toHaveBeenCalledWith([]);
    expect(await sql`select files_added, files_updated from connector_sync_log`).toEqual([{ files_added: 0, files_updated: 0 }]);
  });

  it("re-ingests a file whose etag changed and reports it as updated", async () => {
    await seedDocument("etag-0");
    await sync();
    expect(intake.mock.calls[0]![0]).toHaveLength(1);
    expect(await sql`select files_added, files_updated from connector_sync_log`).toEqual([{ files_added: 0, files_updated: 1 }]);
  });

  it("ingests an unseen file as added", async () => {
    await sync();
    expect(intake.mock.calls[0]![0]).toHaveLength(1);
    expect(await sql`select files_added, files_updated from connector_sync_log`).toEqual([{ files_added: 1, files_updated: 0 }]);
  });
});
