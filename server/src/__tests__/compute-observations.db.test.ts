import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import type { ComputePriceObservation, ComputeCalibrationObservation } from "@docslurp/shared";
import { insertComputeCalibration, insertComputePrice, readComputeObservations } from "../services/compute-observations.js";
import { reconcileRoleGrants } from "../../db/roles.mjs";

let sql: ReturnType<typeof postgres>, stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  // The migration must reconcile roles already present at deploy time, and be safe to repeat.
  await sql.unsafe("create role docslurp_app nologin; create role docslurp_worker nologin");
  await sql.unsafe(await readFile(new URL("../../db/migrations/0177_compute_observations.sql", import.meta.url), "utf8"));
  await reconcileRoleGrants({ query: async (statement: string, params: unknown[] = []) => ({ rows: await sql.unsafe(statement, params as postgres.ParameterOrJSON<never>[]) }) }, { log: () => {} });
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
const now = new Date("2026-11-15T12:00:00Z");
const price = (id: string): ComputePriceObservation => ({
  id, offerId: "offer-a", provider: "provider-a", sku: "cpu-a", region: "region-a", market: "on-demand",
  observedAt: "2026-11-15T11:00:00Z", validUntil: "2026-11-16T11:00:00Z", sourceUrl: "https://example.com/prices", sourceHash: "a".repeat(64),
  nativeCurrency: "USD", nativePerHour: 1, usdPerNative: 1, fxObservedAt: "2026-11-15T11:00:00Z", fxSourceUrl: "https://example.com/prices",
  usdPerHour: 1, egressUsdPerGiB: 0.1, billingMinimumSeconds: 60, billingQuantumSeconds: 1,
});
const calibration = (id: string, priceId: string): ComputeCalibrationObservation => ({
  id, profileId: "profile-a", priceId, offerId: "offer-a", imageHash: "image-a", isolationPolicy: "policy-a", engine: "engine-a", workload: "class-a",
  observedAt: "2026-11-15T11:01:00Z", validUntil: "2026-11-22T11:01:00Z", attempted: 10, succeeded: 10, failed: 0,
  slots: 2, startupP95Ms: 1000, serviceP95MsPerPage: 1000, transferMsPerMiB: 1, idleTailMs: 1000, allocatedMs: 7000, sourceHash: "b".repeat(64),
});

describe("compute observations", () => {
  it("imports idempotently and refuses conflicting receipt IDs", async () => {
    expect(await insertComputePrice(sql, price("price-a"))).toBe(true);
    expect(await insertComputePrice(sql, price("price-a"))).toBe(false);
    await expect(insertComputePrice(sql, { ...price("price-a"), usdPerHour: 2, nativePerHour: 2 })).rejects.toThrow("receipt ID conflict");
    expect(await insertComputeCalibration(sql, calibration("cal-a", "price-a"))).toBe(true);
    expect(await insertComputeCalibration(sql, calibration("cal-a", "price-a"))).toBe(false);
    await expect(insertComputeCalibration(sql, { ...calibration("cal-a", "price-a"), slots: 4 })).rejects.toThrow("receipt ID conflict");
  });

  it("joins fresh prices to existing calibration without rerunning an engine for each price refresh", async () => {
    const refreshed = { ...price("price-b"), observedAt: "2026-11-15T11:30:00Z", usdPerHour: 2, nativePerHour: 2 };
    await insertComputePrice(sql, refreshed);
    const result = await readComputeObservations(sql, ["profile-a"], now);
    expect(result.prices[0]).toMatchObject({ id: "price-b", usdPerHour: 2 });
    expect(result.calibrations[0]).toMatchObject({ id: "cal-a", priceId: "price-a" });
    expect(await readComputeObservations(sql, ["profile-a"], new Date("2026-11-23T12:00:00Z"))).toEqual({ prices: [], calibrations: [] });
    expect(await readComputeObservations(sql, [], now)).toEqual({ prices: [], calibrations: [] });
  });

  it("rejects malformed or incomplete operational records and mismatched offers", async () => {
    await expect(insertComputePrice(sql, { ...price("bad-negative"), usdPerHour: -1 })).rejects.toThrow();
    await expect(insertComputePrice(sql, { ...price("bad-number"), usdPerHour: Number.NaN })).rejects.toThrow();
    await expect(insertComputePrice(sql, { ...price("bad-url"), sourceUrl: "file:///secret" })).rejects.toThrow();
    await expect(insertComputePrice(sql, { ...price("bad-age"), validUntil: "2026-11-22T11:00:00Z" })).rejects.toThrow();
    await expect(insertComputePrice(sql, { ...price("bad-fx"), usdPerNative: 0.01 })).rejects.toThrow();
    await expect(insertComputePrice(sql, { ...price("old-fx"), fxObservedAt: "2000-01-01T00:00:00Z" })).rejects.toThrow();
    await expect(insertComputePrice(sql, { ...price("future-fx"), fxObservedAt: "2026-11-16T11:00:00Z" })).rejects.toThrow();
    await expect(insertComputeCalibration(sql, { ...calibration("bad-count", "price-a"), failed: 1 })).rejects.toThrow();
    await expect(insertComputeCalibration(sql, { ...calibration("bad-offer", "price-a"), offerId: "other-offer" })).rejects.toThrow();
    await expect(insertComputeCalibration(sql, { ...calibration("bad-expiry", "price-a"), validUntil: "2030-01-01T00:00:00Z" })).rejects.toThrow();
    await expect(insertComputeCalibration(sql, { ...calibration("bad-integer", "price-a"), allocatedMs: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow();
    await expect(readComputeObservations(sql, Array(101).fill("profile-a"), now)).rejects.toThrow();
  });

  it("keeps runtime price writes and calibration updates forbidden", async () => {
    for (const role of ["docslurp_app", "docslurp_worker"]) {
      const [row] = await sql`select has_table_privilege(${role}, 'compute_price_observations', 'SELECT') as price_read,
        has_table_privilege(${role}, 'compute_price_observations', 'INSERT') as price_write,
        has_table_privilege(${role}, 'compute_calibration_observations', 'INSERT') as sample_write,
        has_table_privilege(${role}, 'compute_calibration_observations', 'UPDATE') as sample_update`;
      expect(row).toEqual({ price_read: true, price_write: false, sample_write: true, sample_update: false });
      for (const command of [
        "delete from compute_price_observations", "update compute_price_observations set usd_per_hour = 0.01",
        "delete from compute_calibration_observations", "update compute_calibration_observations set slots = 10",
      ]) {
        await expect(sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx.unsafe(command);
        })).rejects.toThrow(/permission denied/);
      }
    }
  });
});
