import type { MiddlewareHandler } from "hono";

import { sql, type SqlClient } from "../db.js";
import type { RequestActor } from "../lib/request-actor.js";

/**
 * Client surfaces: which way a user reaches DocSlurp (dashboard, raw API, SDK,
 * CLI, MCP, ...), for the platform-admin user panel. Analytics only: the
 * `X-DocSlurp-Client` header is caller-supplied, so it only labels requests
 * and never changes what a request may do.
 */
export const CLIENT_SURFACES = ["web", "api", "browser_key", "sdk", "cli", "mcp", "mcp_stdio", "openai_compat", "search_compat", "widget", "wordpress"] as const;
export type ClientSurface = typeof CLIENT_SURFACES[number];

export const CLIENT_HEADER = "X-DocSlurp-Client";

/** Header product names (`sdk/0.3.0` → `sdk`) that map to a surface. */
const HEADER_SURFACES = new Map<string, ClientSurface>([
  ["sdk", "sdk"],
  ["cli", "cli"],
  ["mcp-stdio", "mcp_stdio"],
  ["widget", "widget"],
  ["wordpress", "wordpress"],
]);

/** `name` or `name/version`, at most 64 safe characters; anything else is ignored. */
export function parseClientHeader(value: string | null | undefined): { surface: ClientSurface; client: string } | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 64 || !/^[a-z][a-z0-9-]*(?:\/[0-9A-Za-z.+-]{1,32})?$/.test(trimmed)) return null;
  const surface = HEADER_SURFACES.get(trimmed.split("/")[0]!);
  return surface ? { surface, client: trimmed } : null;
}

export function classifyClientSurface(args: { path: string; actor: RequestActor | undefined; clientHeader?: string | null }): { surface: ClientSurface; client: string | null } | null {
  const { path, actor } = args;
  if (!actor) return null;
  // Sessions are first-party only: the dashboard, whatever library it uses.
  if (actor.type === "session") return { surface: "web", client: null };
  const oauth = actor.apiKey.oauth?.audience;
  if (oauth === "mcp" || path === "/v1/mcp" || path.startsWith("/v1/mcp/")) return { surface: "mcp", client: null };
  const tagged = parseClientHeader(args.clientHeader);
  // An OAuth REST token is only ever issued to the CLI's device login (its stdio MCP server included).
  if (oauth === "api") return tagged?.surface === "mcp_stdio" ? tagged : { surface: "cli", client: tagged?.surface === "cli" ? tagged.client : null };
  if (tagged) return tagged;
  if (path.startsWith("/compat/")) return { surface: "search_compat", client: null };
  if (path === "/v1/chat/completions") return { surface: "openai_compat", client: null };
  if (actor.apiKey.keyType === "client") return { surface: "browser_key", client: null };
  return { surface: "api", client: null };
}

interface PendingSurface { userId: string; surface: ClientSurface; client: string | null; count: number; firstAt: Date; lastAt: Date }

/** Coalesces surface hits so a busy key costs one upsert per flush, not one per request. */
export class ClientSurfaceRecorder {
  private pending = new Map<string, PendingSurface>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly client: () => SqlClient, private readonly flushMs = 30_000, private readonly maxPending = 5_000) {}

  record(userId: string, surface: ClientSurface, client: string | null, now = new Date()): void {
    const key = `${userId}\u0000${surface}`;
    const entry = this.pending.get(key);
    if (entry) {
      entry.count += 1; entry.lastAt = now; entry.client = client ?? entry.client;
    } else {
      // Under extreme fan-out drop new keys rather than grow without bound.
      if (this.pending.size >= this.maxPending) return;
      this.pending.set(key, { userId, surface, client, count: 1, firstAt: now, lastAt: now });
    }
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush(); }, this.flushMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    const db = this.client();
    try {
      await db`
        insert into user_client_surfaces (user_id, surface, last_client, first_seen_at, last_seen_at, request_count)
        select b.user_id, b.surface, b.last_client, b.first_at, b.last_at, b.count
        from jsonb_to_recordset(${db.json(batch.map(entry => ({
          user_id: entry.userId, surface: entry.surface, last_client: entry.client,
          first_at: entry.firstAt.toISOString(), last_at: entry.lastAt.toISOString(), count: entry.count,
        })) as never)}::jsonb) as b(user_id text, surface text, last_client text, first_at timestamptz, last_at timestamptz, count bigint)
        where exists (select 1 from "user" u where u.id = b.user_id)
        on conflict (user_id, surface) do update set
          last_client = coalesce(excluded.last_client, user_client_surfaces.last_client),
          first_seen_at = least(user_client_surfaces.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(user_client_surfaces.last_seen_at, excluded.last_seen_at),
          request_count = user_client_surfaces.request_count + excluded.request_count`;
    } catch (error) {
      // Analytics never fails a request; the lost batch is only a count.
      console.warn("[client-surface] flush failed", error instanceof Error ? error.message : error);
    }
  }
}

export const clientSurfaceRecorder = new ClientSurfaceRecorder(() => sql);

/** Runs after the route: records the authenticated actor's surface on non-error responses. */
export const clientSurfaceMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method === "OPTIONS" || c.res.status >= 400) return;
  try {
    const classified = classifyClientSurface({ path: c.req.path, actor: c.get("requestActor"), clientHeader: c.req.header(CLIENT_HEADER) });
    const userId = c.get("requestActor")?.userId;
    if (classified && userId) clientSurfaceRecorder.record(userId, classified.surface, classified.client);
  } catch (error) {
    console.warn("[client-surface] classify failed", error instanceof Error ? error.message : error);
  }
};
