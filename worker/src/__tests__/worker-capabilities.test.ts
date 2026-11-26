import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WORKER_CAPABILITY_PROTOCOL } from "@docslurp/shared";

import {
  lexicalColumnProbe,
  resolveWorkerCapabilities,
  WorkerCapabilityRegistry,
  workerInstanceId,
} from "../db/worker-capabilities.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Worker side of the capability handshake (migration 0055): registration,
 * heartbeat, shutdown marking, and tolerance of a schema without the table.
 */
type Sql = postgres.Sql<Record<string, unknown>>;

// PGlite is a single session shared with its socket server, so the
// pre-0055 schema gets a database of its own.
let oldDb: PGlite;
let oldServer: PGLiteSocketServer;
let oldSql: Sql;
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;

async function open(database: PGlite): Promise<{ server: PGLiteSocketServer; sql: Sql }> {
  const served = await serveOnRandomPort(database);
  return { server: served.server, sql: postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, onnotice: () => {} }) };
}

beforeAll(async () => {
  oldDb = await createMigratedDatabase({ stopBefore: "worker_capabilities" });
  ({ server: oldServer, sql: oldSql } = await open(oldDb));
  db = await createMigratedDatabase();
  ({ server, sql } = await open(db));
}, 180_000);

afterAll(async () => {
  await oldSql?.end();
  await oldServer?.stop();
  await oldDb?.close();
  await sql?.end();
  await server?.stop();
  await db?.close();
});

function registry(logs: string[], client: Sql = sql, capabilities = async () => ["workflow.index-before-enrich" as const]) {
  return new WorkerCapabilityRegistry({
    sql: client,
    instanceId: "fly-m1",
    identity: "docslurp-worker-m1-7",
    taskQueue: "docslurp-pipeline",
    buildId: "abc123",
    capabilities,
    log: (line) => logs.push(line),
  });
}

describe("WorkerCapabilityRegistry", () => {
  it("tolerates a schema without migration 0055 (worker deployed before the migration)", async () => {
    const logs: string[] = [];
    const reg = registry(logs, oldSql);
    expect(await reg.heartbeat()).toBe(false);
    expect(logs.filter((line) => line.includes("migration 0055"))).toHaveLength(1);
  });

  it("logs a missing table once and never throws on repeated heartbeats", async () => {
    // PGlite's socket server mis-answers a statement re-sent after it failed,
    // so repeated failures use a client that always reports 42P01.
    const missing = Object.assign(
      () => Promise.reject(Object.assign(new Error('relation "worker_capabilities" does not exist'), { code: "42P01" })),
      { array: (values: unknown[]) => values },
    ) as unknown as Sql;
    const logs: string[] = [];
    const reg = registry(logs, missing);
    for (let i = 0; i < 3; i++) expect(await reg.heartbeat()).toBe(false);
    expect(logs.filter((line) => line.includes("migration 0055"))).toHaveLength(1);
    await expect(reg.stop()).resolves.toBeUndefined();
  });

  it("registers, heartbeats and marks the row stopped on shutdown", { timeout: 60_000 }, async () => {
    const logs: string[] = [];
    const reg = registry(logs);
    expect(await reg.start()).toBe(true);
    const [row] = await sql<{ identity: string; build_id: string; protocol: number; capabilities: string[]; stopped_at: Date | null }[]>`
      select identity, build_id, protocol, capabilities, stopped_at from worker_capabilities where instance_id = 'fly-m1'
    `;
    expect(row).toMatchObject({
      identity: "docslurp-worker-m1-7",
      build_id: "abc123",
      protocol: WORKER_CAPABILITY_PROTOCOL,
      capabilities: ["workflow.index-before-enrich"],
      stopped_at: null,
    });
    expect(logs.some((line) => line.includes("registered") && line.includes("buildId=abc123"))).toBe(true);

    await reg.stop();
    const [stopped] = await sql<{ stopped_at: Date | null }[]>`select stopped_at from worker_capabilities where instance_id = 'fly-m1'`;
    expect(stopped?.stopped_at).not.toBeNull();

    // A restart on the same host replaces the row and clears stopped_at.
    const next = new WorkerCapabilityRegistry({
      sql,
      instanceId: "fly-m1",
      identity: "docslurp-worker-m1-8",
      taskQueue: "docslurp-pipeline",
      buildId: "def456",
      capabilities: async () => [],
      log: () => {},
    });
    expect(await next.heartbeat()).toBe(true);
    const rows = await sql<{ identity: string; build_id: string; stopped_at: Date | null }[]>`select identity, build_id, stopped_at from worker_capabilities`;
    expect(rows).toEqual([{ identity: "docslurp-worker-m1-8", build_id: "def456", stopped_at: null }]);
    await next.stop();
  });

  it("advertises its extraction config and posture digest (migration 0182) for /ops/worker-fleet", { timeout: 60_000 }, async () => {
    const config = { extractionConfig: 1, postureDigest: "sha256:0123456789abcdef", profile: "service", disabled: ["ocr"] };
    const logs: string[] = [];
    const reg = new WorkerCapabilityRegistry({
      sql, instanceId: "fly-cfg", identity: "docslurp-worker-cfg", taskQueue: "docslurp-pipeline", buildId: "cfg",
      capabilities: async () => ["extraction.config-v1"], config: () => config, log: (line) => logs.push(line),
    });
    expect(await reg.heartbeat()).toBe(true);
    const [row] = await sql<{ config: unknown; capabilities: string[] }[]>`select config, capabilities from worker_capabilities where instance_id = 'fly-cfg'`;
    expect(row).toEqual({ config, capabilities: ["extraction.config-v1"] });
    expect(logs.some((line) => line.includes("posture=sha256:0123456789abcdef"))).toBe(true);
    await reg.stop();
    await sql`delete from worker_capabilities where instance_id = 'fly-cfg'`;
  });

  it("falls back to the old row on a schema without migration 0182, logging it once", async () => {
    const statements: string[] = [];
    const client = Object.assign(
      (strings: TemplateStringsArray) => {
        const text = strings.join("?");
        statements.push(text);
        if (text.includes("docslurp_migrations.applied")) return Promise.resolve([{ latest: null }]);
        if (text.includes("capabilities, config")) return Promise.reject(Object.assign(new Error('column "config" does not exist'), { code: "42703" }));
        return Promise.resolve([]);
      },
      { array: (values: unknown[]) => values, json: (value: unknown) => value },
    ) as unknown as Sql;
    const logs: string[] = [];
    const reg = new WorkerCapabilityRegistry({
      sql: client, instanceId: "fly-old", identity: "w", taskQueue: "q", buildId: "b",
      capabilities: async () => ["extraction.config-v1"], config: () => ({ extractionConfig: 1, postureDigest: "sha256:x" }), log: (line) => logs.push(line),
    });
    expect(await reg.heartbeat()).toBe(true);
    expect(await reg.heartbeat()).toBe(true);
    expect(logs.filter((line) => line.includes("migration 0182"))).toHaveLength(1);
    // The second heartbeat skips the config statement until the schema is re-checked.
    expect(statements.filter((text) => text.includes("capabilities, config"))).toHaveLength(1);
  });

  it("probes the lexical column and lease schema for runtime capabilities", async () => {
    expect(await lexicalColumnProbe(sql)()).toBe(true);
    expect(await resolveWorkerCapabilities({
      creditLeasesActive: async () => false,
      lexicalColumnPresent: async () => true,
    })).toEqual(["extraction.config-v1", "search.early-lexical", "workflow.group-adjacent-stages", "workflow.index-before-enrich", "workflow.page-range-shards", "workflow.quarantine-document-threshold", "workflow.quarantine-shards"]);
    expect(await resolveWorkerCapabilities({
      creditLeasesActive: async () => { throw new Error("db down"); },
      lexicalColumnPresent: async () => false,
    })).toEqual(["extraction.config-v1", "workflow.group-adjacent-stages", "workflow.index-before-enrich", "workflow.page-range-shards", "workflow.quarantine-document-threshold", "workflow.quarantine-shards"]);
  });
});

describe("workerInstanceId", () => {
  it("prefers WORKER_INSTANCE_ID, then the Fly machine and pid, then host and pid", () => {
    expect(workerInstanceId({ WORKER_INSTANCE_ID: "x" }, "h", 1)).toBe("x");
    expect(workerInstanceId({ FLY_MACHINE_ID: "m1" }, "h", 1)).toBe("fly-m1-1");
    // A restarted process on the same machine gets its own row.
    expect(workerInstanceId({ FLY_MACHINE_ID: "m1" }, "h", 2)).not.toBe(workerInstanceId({ FLY_MACHINE_ID: "m1" }, "h", 1));
    expect(workerInstanceId({}, "h", 1)).toBe("h-1");
  });
});
