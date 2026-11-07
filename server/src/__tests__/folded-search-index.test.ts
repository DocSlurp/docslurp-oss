import { describe, expect, it } from "vitest";

import { buildSettings, ensureFoldedIndex } from "../../db/folded-search-index.mjs";

/**
 * The folded-index build's lock handling, against a recording client: the short lock_timeout bounds only a probe of the initial
 * lock, the CONCURRENTLY build runs with lock_timeout = 0 (its waits for older transactions are lock waits too), and a probe
 * that times out is retried. The real build runs against PGlite in rollout-ops-scripts.db.test.ts.
 */
function recordingClient({ probeFailures = 0 } = {}) {
  const statements: string[] = [];
  let state: "missing" | "valid" = "missing";
  let failures = probeFailures;
  const client = {
    statements,
    async query(text: string) {
      statements.push(text.replace(/\s+/g, " ").trim());
      if (text.includes("to_regprocedure")) return { rows: [{ present: true }] };
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("from pg_index")) return { rows: state === "missing" ? [] : [{ valid: true, bytes: 8192 }] };
      if (text.startsWith("lock table") && failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      }
      if (text.startsWith("create index concurrently")) state = "valid";
      return { rows: [] };
    },
  };
  return client;
}

const settings = { ...buildSettings({}), retryDelayMs: 0 };
const log = () => undefined;

describe("folded index build locks", () => {
  it("bounds only the initial lock acquire, then builds with lock_timeout = 0", async () => {
    const client = recordingClient();
    expect(await ensureFoldedIndex(client, { settings, log })).toMatchObject({ action: "built" });
    const from = client.statements.indexOf("begin");
    expect(client.statements.slice(from, from + 6)).toEqual([
      "begin",
      "set local lock_timeout = '5000ms'",
      "lock table public.document_chunks in share update exclusive mode",
      "commit",
      "set lock_timeout = 0",
      "set statement_timeout = 0",
    ]);
    const build = client.statements.findIndex((statement) => statement.startsWith("create index concurrently"));
    expect(build).toBeGreaterThan(from + 5);
    // Nothing sets a non-zero lock_timeout between the probe and the build.
    expect(client.statements.slice(from + 4, build).filter((statement) => /lock_timeout = '/.test(statement))).toEqual([]);
  });

  it("retries a probe that times out and never starts the build without the probe", async () => {
    const client = recordingClient({ probeFailures: 2 });
    expect(await ensureFoldedIndex(client, { settings, log })).toMatchObject({ action: "built" });
    expect(client.statements.filter((statement) => statement.startsWith("lock table"))).toHaveLength(3);
    expect(client.statements.filter((statement) => statement === "rollback")).toHaveLength(2);
    expect(client.statements.filter((statement) => statement.startsWith("create index concurrently"))).toHaveLength(1);
  });

  it("gives up after the configured attempts", async () => {
    const client = recordingClient({ probeFailures: 10 });
    await expect(ensureFoldedIndex(client, { settings: { ...settings, attempts: 2 }, log })).rejects.toMatchObject({ code: "55P03" });
    expect(client.statements.some((statement) => statement.startsWith("create index concurrently"))).toBe(false);
  });

  it("defaults maintenance_work_mem conservatively and refuses a malformed value", () => {
    expect(buildSettings({}).maintenanceWorkMem).toBe("128MB");
    expect(buildSettings({ FOLDED_INDEX_MAINTENANCE_WORK_MEM: "1GB" }).maintenanceWorkMem).toBe("1GB");
    expect(() => buildSettings({ FOLDED_INDEX_MAINTENANCE_WORK_MEM: "lots" })).toThrow(/128MB or 1GB/);
  });
});
