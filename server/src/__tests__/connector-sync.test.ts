import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value,
  }),
}));

vi.mock("../lib/encryption.js", () => ({
  getRequiredEncryptionKey: () => {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured");
  },
}));

const { runConnectorSync } = await import("../routes/connectors.js");
const { sweepInterruptedConnectorSyncs } = await import("../services/connector-sync-recovery.js");

const queryText = (call: unknown[]): string => {
  const strings = call[0] as unknown;
  return Array.isArray(strings) && "raw" in strings ? strings.join("?") : "";
};

describe("connector sync durability", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  it("marks the sync log failed when credential setup throws", async () => {
    await expect(
      runConnectorSync(
        {
          id: "conn-1",
          workspace_id: "ws-1",
          type: "s3",
          name: "Bucket",
          credentials_encrypted: "iv:tag:data",
          config: {},
          status: "active",
          last_sync_at: null,
          created_at: "2026-10-03T00:00:00.000Z",
          updated_at: "2026-10-03T00:00:00.000Z",
        },
        "sync-1",
      ),
    ).rejects.toThrow(/CREDENTIALS_ENCRYPTION_KEY/);

    const statements = sqlMock.mock.calls.map(queryText);
    expect(statements.some((text) => text.includes("update connector_sync_log") && text.includes("'failed'"))).toBe(true);
    expect(statements.some((text) => text.includes("update workspace_connectors set status = 'error'"))).toBe(true);
  });

  it("fails syncs left running past the timeout and flags their connectors", async () => {
    sqlMock
      .mockResolvedValueOnce([{ connector_id: "conn-1" }, { connector_id: "conn-1" }])
      .mockResolvedValueOnce([]);

    await expect(sweepInterruptedConnectorSyncs()).resolves.toBe(2);
    const statements = sqlMock.mock.calls.map(queryText);
    expect(statements.some((text) => text.includes("update workspace_connectors"))).toBe(true);
  });
});
