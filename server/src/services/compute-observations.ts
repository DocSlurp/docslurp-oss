import type postgres from "postgres";
import { computePriceColumns, computeCalibrationColumns, decodeComputeObservation as decode, type ComputePriceObservation, type ComputeCalibrationObservation, type ComputeObservations } from "@docslurp/shared";

type Sql = postgres.Sql;
const priceColumns = computePriceColumns;
const calibrationColumns = computeCalibrationColumns;
const numericFields = new Set(["nativePerHour", "usdPerNative", "usdPerHour", "egressUsdPerGiB", "billingMinimumSeconds", "billingQuantumSeconds", "attempted", "succeeded", "failed", "slots", "startupP95Ms", "serviceP95MsPerPage", "transferMsPerMiB", "idleTailMs", "allocatedMs"]);
const dateFields = new Set(["observedAt", "validUntil", "fxObservedAt"]);

function encode(row: object, columns: Record<string, string>): Record<string, string | number> {
  const input = row as Record<string, unknown>;
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => {
    const value = input[key];
    if (numericFields.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid compute observation ${key}`);
      if (key === "allocatedMs" && !Number.isSafeInteger(value)) throw new Error("Invalid compute observation allocatedMs");
      return [column, value];
    }
    if (typeof value !== "string" || !value.length || value.length > 2000) throw new Error(`Invalid compute observation ${key}`);
    if (dateFields.has(key)) {
      const ms = Date.parse(value);
      if (!Number.isFinite(ms)) throw new Error(`Invalid compute observation ${key}`);
      return [column, new Date(ms).toISOString()];
    }
    return [column, value];
  }));
}

/** Operator-owned price import. Duplicate receipt IDs must describe exactly the same observation. */
export async function insertComputePrice(sql: Sql, row: ComputePriceObservation): Promise<boolean> {
  const data = encode(row, priceColumns);
  return sql.begin(async (tx) => {
    const created = await tx`insert into compute_price_observations ${tx(data)} on conflict (id) do nothing returning id`;
    if (created.length) return true;
    const [existing] = await tx`select * from compute_price_observations where id = ${row.id}`;
    if (!existing || JSON.stringify(decode(existing, priceColumns)) !== JSON.stringify(decode(data, priceColumns))) throw new Error("Compute price receipt ID conflict");
    return false;
  });
}

/** Runtime may append immutable, content-free measurements, without editing the prices used to rank hosts. */
export async function insertComputeCalibration(sql: Sql, row: ComputeCalibrationObservation): Promise<boolean> {
  const data = encode(row, calibrationColumns);
  return sql.begin(async (tx) => {
    const created = await tx`insert into compute_calibration_observations ${tx(data)} on conflict (id) do nothing returning id`;
    if (created.length) return true;
    const [existing] = await tx`select * from compute_calibration_observations where id = ${row.id}`;
    if (!existing || JSON.stringify(decode(existing, calibrationColumns)) !== JSON.stringify(decode(data, calibrationColumns))) throw new Error("Compute calibration receipt ID conflict");
    return false;
  });
}

/** Bounded operational lookup; no request can fetch tenant/document metadata through this interface. */
export async function readComputeObservations(sql: Sql, profileIds: readonly string[], now = new Date()): Promise<ComputeObservations> {
  if (profileIds.length > 100 || profileIds.some((id) => !id || id.length > 200)) throw new Error("Invalid compute profile selection");
  if (!profileIds.length) return { prices: [], calibrations: [] };
  const calibrations = await sql`
    select distinct on (profile_id) * from compute_calibration_observations
    where profile_id = any(${[...profileIds]}) and observed_at <= ${now} and valid_until > ${now}
      and observed_at > ${now} - interval '7 days'
    order by profile_id, observed_at desc, id desc`;
  const offers = calibrations.map((row) => String(row.offer_id));
  const prices = offers.length ? await sql`
    select distinct on (offer_id) * from compute_price_observations where offer_id = any(${offers})
      and observed_at <= ${now} and valid_until > ${now}
    order by offer_id, observed_at desc, id desc` : [];
  const validPrices = new Set(prices.map((row) => row.offer_id));
  return {
    prices: prices.map((row) => decode<ComputePriceObservation>(row, priceColumns)),
    calibrations: calibrations.filter((row) => validPrices.has(row.offer_id)).map((row) => decode<ComputeCalibrationObservation>(row, calibrationColumns)),
  };
}
