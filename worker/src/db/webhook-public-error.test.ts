import { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOCUMENT_FAILURE_MARKERS, PUBLIC_ERROR_MESSAGES, publicDocumentError } from "@docslurp/shared";

import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { publicErrorSql } from "./store.js";

/**
 * The run.completed / run.failed outbox payload maps a run's stored error in SQL (triggerWebhooks). It must give exactly
 * what publicDocumentError gives the API for the same text, for every reviewed marker and for raw worker errors.
 */
type Sql = postgres.Sql<Record<string, unknown>>;
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;

beforeAll(async () => {
  db = new PGlite();
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false, onnotice: () => undefined }) as unknown as Sql;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

async function viaOutbox(error: string | null): Promise<string | null> {
  const [row] = await sql<{ error: string | null }[]>`select ${publicErrorSql(sql, "r.error")} as error from (select ${error}::text as error) r`;
  return row!.error;
}

describe("webhook outbox error copy matches publicDocumentError", () => {
  it.each(Object.entries(DOCUMENT_FAILURE_MARKERS))("maps the %s marker, alone and inside a run summary", async (key, marker) => {
    for (const stored of [marker, `1 document failed: ${marker} (doc-1)`, `Error: ${marker}\n    at stage (/app/worker/x.ts:1:1)`]) {
      expect(await viaOutbox(stored)).toBe(publicDocumentError(stored));
      expect(await viaOutbox(stored)).toBe(PUBLIC_ERROR_MESSAGES[key as keyof typeof DOCUMENT_FAILURE_MARKERS]);
    }
  });

  it("withholds raw worker errors and keeps no error as null", async () => {
    for (const stored of [
      "pdftotext exited non-zero",
      "Error: connect ECONNREFUSED 10.0.0.5:5432\n    at TCPConnectWrap (node:net:1:1)",
      "provider said: invalid api key sk-test-123",
      "it's 100% 'quoted' \\ text",
    ]) {
      expect(await viaOutbox(stored)).toBe(publicDocumentError(stored));
      expect(await viaOutbox(stored)).toBe(PUBLIC_ERROR_MESSAGES.processing);
    }
    expect(await viaOutbox(null)).toBe(publicDocumentError(null));
    expect(await viaOutbox("")).toBe(publicDocumentError(""));
  });
});
