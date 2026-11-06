import { HTTPException } from "hono/http-exception";

import { apiError } from "@docslurp/shared";

/**
 * Opaque keyset cursors for list endpoints. A cursor only repositions a query
 * inside the rows the caller's scope already allows (the scope conditions are
 * applied again on every page), so it carries no authority and needs no
 * signature: a forged or stale cursor can skip or repeat rows of the caller's
 * own list, never reveal another tenant's. It is bound to one list kind so a
 * documents cursor cannot be replayed against runs.
 */
export type ListCursorKind = "documents" | "runs";

export class InvalidListCursorError extends HTTPException {
  constructor() {
    super(400, { res: Response.json(apiError("invalid_request", "Invalid cursor. Pass the nextCursor from the previous page unchanged."), { status: 400 }) });
    this.name = "InvalidListCursorError";
  }
}

export function encodeListCursor(kind: ListCursorKind, values: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify({ v: 1, k: kind, ...values }), "utf8").toString("base64url");
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/;
/** Postgres refuses a zone offset beyond ±15:59 ("time zone displacement out of range"). */
const MAX_OFFSET_HOURS = 15;

/** A timestamp Postgres will accept as `::timestamptz` (a Postgres `created_at::text`, or ISO 8601): real calendar date and time and an offset within ±15:59, else the cast would fail the query. */
function isTimestampText(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const [offsetHours, offsetMinutes] = [Number(match[7] ?? 0), Number(match[8] ?? 0)];
  if (offsetHours > MAX_OFFSET_HOURS || offsetMinutes >= 60) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
}

/**
 * The cursor's values, or throws InvalidListCursorError (a 400) for anything that is not a cursor of this kind. `timestamp`
 * values are checked as real timestamps here, so a forged one is a 400 and never reaches the query as a failing cast (a 500).
 */
export function decodeListCursor<T extends Record<string, string | number>>(kind: ListCursorKind, cursor: string, shape: { [K in keyof T]: "string" | "number" | "int" | "timestamp" }): T {
  let parsed: unknown;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("shape");
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidListCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidListCursorError();
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1 || record.k !== kind) throw new InvalidListCursorError();
  const out: Record<string, string | number> = {};
  for (const [key, type] of Object.entries(shape)) {
    const value = record[key];
    if (type === "int") {
      // An integer column: a fractional or out-of-range value would fail the query's cast (a 500) instead of being a bad cursor.
      if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 2_147_483_647) throw new InvalidListCursorError();
    } else if (type === "timestamp") {
      if (typeof value !== "string" || value.length > 64 || !isTimestampText(value)) throw new InvalidListCursorError();
    } else if (typeof value !== type || (type === "number" && !Number.isFinite(value as number))) throw new InvalidListCursorError();
    if (typeof value === "string" && value.length > 256) throw new InvalidListCursorError();
    out[key] = value as string | number;
  }
  return out as T;
}

/** `limit` from a query string: an integer from 1 to `max`, else a 400. Absent means `fallback`. */
export function parseListLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new HTTPException(400, { res: Response.json(apiError("invalid_request", `limit must be an integer from 1 to ${max}`), { status: 400 }) });
  const value = Number(raw);
  if (value < 1 || value > max) throw new HTTPException(400, { res: Response.json(apiError("invalid_request", `limit must be an integer from 1 to ${max}`), { status: 400 }) });
  return value;
}
