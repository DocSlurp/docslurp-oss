import { describe, expect, it } from "vitest";

import {
  formatTemporalConnectionError,
  isLocalTemporalAddress,
  isTemporalConnectionRefused,
  retryTemporalConnect,
} from "../temporal-connection.js";

describe("isLocalTemporalAddress", () => {
  it("detects loopback Temporal addresses", () => {
    expect(isLocalTemporalAddress("localhost:7233")).toBe(true);
    expect(isLocalTemporalAddress("127.0.0.1:7233")).toBe(true);
    expect(isLocalTemporalAddress("[::1]:7233")).toBe(true);
  });

  it("rejects non-loopback Temporal addresses", () => {
    expect(isLocalTemporalAddress("temporal:7233")).toBe(false);
    expect(isLocalTemporalAddress("temporal.example.invalid:7233")).toBe(false);
  });
});

describe("isTemporalConnectionRefused", () => {
  it("matches Temporal loopback refusal errors", () => {
    const error = new Error(
      'TransportError: tonic::transport::Error(Transport, ConnectError(ConnectError("tcp connect error", 127.0.0.1:7233, Os { code: 61, kind: ConnectionRefused, message: "Connection refused" })))'
    );

    expect(isTemporalConnectionRefused(error)).toBe(true);
  });
});

describe("formatTemporalConnectionError", () => {
  it("includes local bootstrap guidance for loopback addresses", () => {
    const message = formatTemporalConnectionError(
      {
        address: "127.0.0.1:7233",
        namespace: "docslurp",
        taskQueue: "docslurp-pipeline",
      },
      "Temporal worker",
      new Error("Connection refused")
    );

    expect(message).toContain("127.0.0.1:7233");
    expect(message).toContain("pnpm db:up");
  });

  it("uses config guidance for non-local clusters", () => {
    const message = formatTemporalConnectionError(
      {
        address: "temporal.example.invalid:7233",
        namespace: "docslurp",
      },
      "Temporal API client",
      new Error("unavailable")
    );

    expect(message).toContain("TEMPORAL_ADDRESS");
    expect(message).not.toContain("pnpm db:up");
  });
});

describe("retryTemporalConnect", () => {
  it("retries transient Temporal connectivity failures", async () => {
    let attempts = 0;

    const result = await retryTemporalConnect(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Failed to connect before the deadline");
        }
        return "connected";
      },
      {
        attempts: 4,
        baseDelayMs: 0,
        maxDelayMs: 0
      }
    );

    expect(result).toBe("connected");
    expect(attempts).toBe(3);
  });

  it("fails fast for non-connectivity errors", async () => {
    let attempts = 0;

    await expect(
      retryTemporalConnect(
        async () => {
          attempts += 1;
          throw new Error("invalid namespace");
        },
        {
          attempts: 4,
          baseDelayMs: 0,
          maxDelayMs: 0
        }
      )
    ).rejects.toThrow("invalid namespace");

    expect(attempts).toBe(1);
  });
});
