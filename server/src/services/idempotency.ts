import { createHash } from "node:crypto";

import { sql } from "../db.js";

const IDEMPOTENCY_TTL_HOURS = 24;

type IdempotencyRow = {
  request_hash: string;
  response_status: number;
  response_body: Record<string, unknown> | null;
};

export function hashIdempotencyPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export async function getCachedIdempotentResponse(args: {
  idempotencyKey: string;
  routeKey: string;
  requestHash: string;
}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  await purgeExpiredIdempotencyKeys();

  const [row] = await sql<IdempotencyRow[]>`
    select request_hash, response_status, response_body
    from idempotency_cache
    where idempotency_key = ${args.idempotencyKey}
      and route_key = ${args.routeKey}
      and expires_at > now()
    limit 1
  `;

  if (!row) {
    return null;
  }

  if (row.request_hash !== args.requestHash) {
    throw new Error("Idempotency-Key already exists for a different request payload.");
  }

  return {
    status: row.response_status,
    body: row.response_body ?? {}
  };
}

export async function storeIdempotentResponse(args: {
  idempotencyKey: string;
  routeKey: string;
  requestHash: string;
  userId?: string | null;
  status: number;
  body: Record<string, unknown>;
}): Promise<void> {
  await sql`
    insert into idempotency_cache (
      idempotency_key,
      route_key,
      request_hash,
      user_id,
      response_status,
      response_body,
      expires_at
    )
    values (
      ${args.idempotencyKey},
      ${args.routeKey},
      ${args.requestHash},
      ${args.userId ?? null},
      ${args.status},
      ${sql.json(JSON.parse(JSON.stringify(args.body)))},
      now() + (${IDEMPOTENCY_TTL_HOURS} * interval '1 hour')
    )
    on conflict (idempotency_key, route_key) do update
    set
      request_hash = excluded.request_hash,
      user_id = excluded.user_id,
      response_status = excluded.response_status,
      response_body = excluded.response_body,
      expires_at = excluded.expires_at
  `;
}

async function purgeExpiredIdempotencyKeys(): Promise<void> {
  await sql`
    delete from idempotency_cache
    where expires_at <= now()
  `;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
