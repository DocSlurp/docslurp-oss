import type { Sql } from "postgres";
import { withBackgroundSpan } from "@docslurp/shared/observability";

import {
  WORKER_CAPABILITY_PROTOCOL,
  type WorkerCapability,
} from "@docslurp/shared";

/**
 * Worker side of the capability handshake (migration 0055,
 * packages/shared/src/worker-capabilities.ts). Each worker process upserts
 * its row before it polls Temporal and then on a heartbeat, so the app only
 * enables a gated feature once every live poller advertises it.
 *
 * Never throws: a database without migration 0055 (schema older than the
 * code) or a failing heartbeat only means this worker is not counted as
 * supporting anything, which keeps the app on the old behaviour.
 */

type Client = Sql<Record<string, unknown>>;

export interface WorkerCapabilityProbes {
  /** Credit leases are on in this worker and their schema (0052 + 0053) exists. */
  creditLeasesActive: () => Promise<boolean>;
  /** documents.lexical_searchable_at exists (0051). */
  lexicalColumnPresent: () => Promise<boolean>;
}

/** Capabilities this build supports, given runtime config and schema. */
export async function resolveWorkerCapabilities(probes: WorkerCapabilityProbes): Promise<WorkerCapability[]> {
  const capabilities: WorkerCapability[] = [
    // Code-level: this build's workflow and store support both.
    "workflow.index-before-enrich",
    "workflow.group-adjacent-stages",
    "workflow.page-range-shards",
  ];
  const [leases, lexical] = await Promise.all([
    probes.creditLeasesActive().catch(() => false),
    probes.lexicalColumnPresent().catch(() => false),
  ]);
  if (leases) capabilities.push("billing.credit-leases");
  if (lexical) capabilities.push("search.early-lexical");
  return capabilities.sort();
}

/** Cached once present; re-checked every 5 minutes while missing. */
export function lexicalColumnProbe(sql: Client): () => Promise<boolean> {
  let state: { present: boolean; checkedAt: number } | null = null;
  return async () => {
    const now = Date.now();
    if (state && (state.present || now - state.checkedAt < 5 * 60_000)) return state.present;
    const [row] = await sql<{ present: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'documents' and column_name = 'lexical_searchable_at'
      ) as present
    `;
    state = { present: row?.present === true, checkedAt: now };
    return state.present;
  };
}

export interface WorkerCapabilityRegistryOptions {
  sql: Client;
  instanceId: string;
  identity: string;
  taskQueue: string;
  buildId: string | null;
  capabilities: () => Promise<WorkerCapability[]>;
  intervalMs?: number;
  log?: (line: string) => void;
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "42P01";
}

/** Host key: the Fly machine id, else hostname plus pid (several local workers per host). */
export function workerInstanceId(env: NodeJS.ProcessEnv, hostname: string, pid: number): string {
  const explicit = env.WORKER_INSTANCE_ID?.trim();
  if (explicit) return explicit.slice(0, 200);
  // One row per process: a restarted process on the same machine gets a new row, so the
  // old process's row survives (marked stopped) and the app can tell its lingering Temporal
  // poller apart from an unregistered older build.
  const machine = env.FLY_MACHINE_ID?.trim();
  return (machine ? `fly-${machine}-${pid}` : `${hostname}-${pid}`).slice(0, 200);
}

export class WorkerCapabilityRegistry {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAdvertised: string | null = null;
  private missingTableLogged = false;
  private readonly log: (line: string) => void;
  readonly intervalMs: number;

  constructor(private readonly options: WorkerCapabilityRegistryOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.intervalMs = Math.max(5_000, options.intervalMs ?? 20_000);
  }

  private schemaCache: { when: number | null; at: number } | null = null;

  /** Newest applied migration (drizzle journal `when`), re-read every 5 minutes. */
  private async schemaAppliedWhen(): Promise<number | null> {
    const now = Date.now();
    if (this.schemaCache && now - this.schemaCache.at < 5 * 60_000) return this.schemaCache.when;
    const rows = await this.options.sql<{ latest: string | number | null }[]>`
      select max(created_at) as latest from drizzle.__drizzle_migrations
    `.catch(() => null);
    const latest = rows?.[0]?.latest;
    const when = latest === null || latest === undefined ? null : Number(latest);
    this.schemaCache = { when, at: now };
    return when;
  }

  /** Upsert this worker's row. Resolves false (never throws) when it could not. */
  async heartbeat(): Promise<boolean> {
    const { sql, instanceId, identity, taskQueue, buildId } = this.options;
    try {
      const capabilities = await this.options.capabilities();
      const schemaWhen = await this.schemaAppliedWhen();
      await sql`
        insert into worker_capabilities (
          instance_id, identity, task_queue, build_id, protocol, capabilities,
          schema_applied_when, started_at, last_seen_at, stopped_at
        ) values (
          ${instanceId}, ${identity}, ${taskQueue}, ${buildId}, ${WORKER_CAPABILITY_PROTOCOL},
          ${sql.array(capabilities)}::text[], ${schemaWhen}, now(), now(), null
        )
        on conflict (instance_id) do update set
          identity = excluded.identity,
          task_queue = excluded.task_queue,
          build_id = excluded.build_id,
          protocol = excluded.protocol,
          capabilities = excluded.capabilities,
          schema_applied_when = excluded.schema_applied_when,
          started_at = case
            when worker_capabilities.identity = excluded.identity then worker_capabilities.started_at
            else now()
          end,
          last_seen_at = now(),
          stopped_at = null
      `;
      const advertised = `${buildId ?? "auto"}:${capabilities.join(",")}`;
      if (advertised !== this.lastAdvertised) {
        this.lastAdvertised = advertised;
        this.log(
          `[worker-capabilities] registered instance=${instanceId} identity=${identity} taskQueue=${taskQueue} ` +
          `buildId=${buildId ?? "auto"} protocol=${WORKER_CAPABILITY_PROTOCOL} capabilities=${capabilities.join(",") || "none"}`,
        );
      }
      return true;
    } catch (error) {
      if (isUndefinedTable(error)) {
        if (!this.missingTableLogged) {
          this.missingTableLogged = true;
          this.log("[worker-capabilities] worker_capabilities table missing (migration 0055 not applied); the app treats this worker as supporting no gated features");
        }
      } else {
        this.log(`[worker-capabilities] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
  }

  /** Register now (bounded wait) and keep heartbeating until stop(). */
  async start(timeoutMs = 10_000): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const registered = await Promise.race([
      this.heartbeat(),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]).finally(() => clearTimeout(timeout));
    this.timer = setInterval(() => void withBackgroundSpan("worker.capability-heartbeat", () => this.heartbeat()), this.intervalMs);
    this.timer.unref?.();
    // Housekeeping: drop rows of hosts not seen for a week.
    void this.options.sql`delete from worker_capabilities where last_seen_at < now() - interval '7 days'`.catch(() => {});
    return registered;
  }

  /** Stop heartbeating and mark the row stopped (kept for the idle-fleet fallback). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.options.sql`
      update worker_capabilities set stopped_at = now(), last_seen_at = now()
      where instance_id = ${this.options.instanceId} and identity = ${this.options.identity}
    `.catch(() => {});
  }
}
