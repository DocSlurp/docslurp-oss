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

/** The cursor's values, or throws InvalidListCursorError (a 400) for anything that is not a cursor of this kind. */
export function decodeListCursor<T extends Record<string, string | number>>(kind: ListCursorKind, cursor: string, shape: { [K in keyof T]: "string" | "number" }): T {
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
    if (typeof value !== type || (type === "number" && !Number.isFinite(value as number))) throw new InvalidListCursorError();
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
