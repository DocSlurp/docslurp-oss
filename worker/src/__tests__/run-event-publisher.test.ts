import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encodeRunEventHints, RunEventPublisher } from "../db/run-event-store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Run events are buffered per worker process and written in coalesced batches
 * with one NOTIFY hint per flush instead of one NOTIFY per event
 * (2026-10-09 load test: per-event NOTIFY serialized every commit).
 */
let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;
const statements: string[] = [];

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into workspaces(id, org_id, user_id, name) values ('w', null, 'u1', 'W');
    insert into workspace_runs (id, user_id, workspace_id, kind, status, stage, pipeline) values
      ('run-a', 'u1', 'w', 'bulk-upload', 'processing', 'embed', '{}'),
      ('run-b', 'u1', 'w', 'bulk-upload', 'processing', 'embed', '{}');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    debug: (_connection, query) => { statements.push(query); },
  });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await sql`delete from workspace_run_events`;
  statements.length = 0;
});

const notifies = () => statements.filter((query) => query.includes("pg_notify"));
const events = async () => (await sql<{ run_id: string; event_type: string; message: string }[]>`
  select run_id, event_type, message from workspace_run_events order by created_at, id`)
  .map((row) => `${row.run_id}:${row.event_type}:${row.message}`);

const progress = (runId: string, message: string) => ({ userId: "u1", runId, eventType: "run.progress", message });

describe("RunEventPublisher", () => {
  it("coalesces a burst from several runs into one write with one hint, in emission order", async () => {
    const publisher = new RunEventPublisher(sql, { flushMs: 50, maxBuffered: 1_000 });
    for (let i = 1; i <= 20; i++) await publisher.append(progress(i % 2 ? "run-a" : "run-b", `p${String(i).padStart(2, "0")}`));

    expect(await events()).toEqual([]);
    expect(publisher.pending).toBe(20);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const written = await events();
    expect(written).toHaveLength(20);
    expect(written.map((event) => event.split(":")[2])).toEqual(
      Array.from({ length: 20 }, (_, i) => `p${String(i + 1).padStart(2, "0")}`),
    );
    expect(notifies()).toHaveLength(1);
    expect(publisher.pending).toBe(0);
  });

  it("writes terminal run events, and everything buffered before them, before append resolves", async () => {
    const publisher = new RunEventPublisher(sql, { flushMs: 60_000, maxBuffered: 1_000 });
    await publisher.append({ userId: "u1", runId: "run-a", eventType: "stage.completed", message: "index" });
    await publisher.append(progress("run-a", "last page"));
    expect(await events()).toEqual([]);

    await publisher.append({ userId: "u1", runId: "run-a", eventType: "run.completed", message: "done" });

    expect(await events()).toEqual([
      "run-a:stage.completed:index",
      "run-a:run.progress:last page",
      "run-a:run.completed:done",
    ]);
    expect(notifies()).toHaveLength(1);
  });

  it("flushes on close and drops only rows whose run no longer exists", async () => {
    const publisher = new RunEventPublisher(sql, { flushMs: 60_000, maxBuffered: 1_000 });
    await publisher.append(progress("run-a", "kept"));
    await publisher.append(progress("run-deleted", "orphan"));
    await publisher.append(progress("run-b", "kept too"));
    await publisher.close();

    expect(await events()).toEqual(["run-a:run.progress:kept", "run-b:run.progress:kept too"]);
  });

  it("splits hints so each NOTIFY payload stays under PostgreSQL's 8 KB limit", () => {
    const runIds = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const hints = encodeRunEventHints([...runIds, ...runIds]);
    expect(hints).toHaveLength(3);
    expect(hints.every((hint) => hint.length < 8_000)).toBe(true);
    expect(hints.flatMap((hint) => (JSON.parse(hint) as { runIds: string[] }).runIds)).toEqual(runIds);
  });
});
