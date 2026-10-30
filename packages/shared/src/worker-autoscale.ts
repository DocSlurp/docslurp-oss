/**
 * Worker fleet target for fly-autoscaler (docs/scaling-1000-workers.md).
 *
 *   target = ceil( min( Σ_org min(demand_org, slots_org), GLOBAL_SLOT_CAP ) / SLOTS_PER_MACHINE × headroom )
 *
 * demand_org is the org's runnable work in slots: per active run, the largest
 * of its pending page tasks (capped at the run's fan-out), its pending
 * document shards (one slot each) and 1 for the document-stage activity. slots_org is the plan ceiling
 * (`organizations.worker_slots`), which the worker enforces at claim time —
 * so machines are never started for work the semaphore would refuse.
 */

export interface OrgSlotDemand {
  orgKey: string;
  demand: number;
  slots: number;
}

export interface WorkerScalerConfig {
  slotsPerMachine: number;
  /** 0 = no fleet-wide cap. */
  globalSlotCap: number;
  headroom: number;
  maxMachines: number;
  /** Orgs whose work runs on a separate (load-test) fleet; excluded here. */
  excludedOrgKeys: ReadonlySet<string>;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOrgList(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
}

/**
 * `fallbackSlotsPerMachine` is used when neither DOCSLURP_WORKER_SLOTS_PER_MACHINE nor
 * WORKER_ACTIVITY_CONCURRENCY is set. A worker passes its resolved activity concurrency (which defaults
 * from the host's CPUs), so the scaler plans with the slots the machine really runs.
 */
export function resolveWorkerScalerConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackSlotsPerMachine = 1,
): WorkerScalerConfig {
  const globalCap = Number.parseInt(env.WORKER_GLOBAL_SLOT_CAP ?? "", 10);
  return {
    slotsPerMachine: Math.max(1, Math.floor(positiveNumber(env.DOCSLURP_WORKER_SLOTS_PER_MACHINE ?? env.WORKER_ACTIVITY_CONCURRENCY, fallbackSlotsPerMachine))),
    globalSlotCap: Number.isFinite(globalCap) && globalCap > 0 ? globalCap : 0,
    headroom: Math.max(1, positiveNumber(env.DOCSLURP_WORKER_SCALE_HEADROOM, 1)),
    maxMachines: Math.max(1, Math.floor(positiveNumber(env.DOCSLURP_WORKER_MAX_AUTOSCALE_MACHINES, 12))),
    excludedOrgKeys: parseOrgList(env.TEMPORAL_LOADTEST_ORG_IDS),
  };
}

/** Σ_org min(demand, slots) over orgs not served by another fleet. */
export function slotDemand(orgs: readonly OrgSlotDemand[], excluded: ReadonlySet<string> = new Set()): number {
  let total = 0;
  for (const org of orgs) {
    if (excluded.has(org.orgKey)) continue;
    const demand = Math.max(0, Number(org.demand) || 0);
    const slots = Math.max(1, Number(org.slots) || 1);
    total += Math.min(demand, slots);
  }
  return total;
}

export function calculateWorkerTargetMachines(
  input: { orgs: readonly OrgSlotDemand[]; workerActive: number },
  config: WorkerScalerConfig,
): number {
  const demand = slotDemand(input.orgs, config.excludedOrgKeys);
  if (demand <= 0) {
    // Keep one machine while a live lease exists so a run's tail is not cut.
    return input.workerActive > 0 ? 1 : 0;
  }
  const capped = config.globalSlotCap > 0 ? Math.min(demand, config.globalSlotCap) : demand;
  const machines = Math.ceil((capped / config.slotsPerMachine) * config.headroom - 1e-9);
  return Math.min(config.maxMachines, Math.max(1, machines));
}

/** Target for a dedicated fleet serving only `orgKeys` (the load-test pool). */
export function calculatePoolTargetMachines(
  orgs: readonly OrgSlotDemand[],
  orgKeys: ReadonlySet<string>,
  config: Pick<WorkerScalerConfig, "slotsPerMachine" | "headroom"> & { maxMachines: number },
): number {
  const demand = slotDemand(orgs.filter((org) => orgKeys.has(org.orgKey)));
  if (demand <= 0) return 0;
  return Math.min(config.maxMachines, Math.max(1, Math.ceil((demand / config.slotsPerMachine) * config.headroom - 1e-9)));
}

/** Parses the scaler query's JSON aggregate defensively (driver may return text). */
export function parseOrgDemand(value: unknown): OrgSlotDemand[] {
  const rows = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const orgKey = typeof record.org_key === "string" ? record.org_key : typeof record.orgKey === "string" ? record.orgKey : null;
    if (!orgKey) return [];
    return [{ orgKey, demand: Number(record.demand ?? 0) || 0, slots: Number(record.slots ?? 1) || 1 }];
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ── Demand query and Prometheus lines (app /fly-scaler-metrics and the worker leader) ──

/** A postgres.js-compatible tagged template (app `sql`, worker `store.sql`). */
export type ScalerSql = (strings: TemplateStringsArray, ...values: any[]) => PromiseLike<readonly unknown[]>;

export interface WorkerScalerQueryParams {
  /** WORKER_PAGE_CONCURRENCY, clamped to 1..128. */
  pageFanout: number;
  /** WORKER_DEFAULT_ORG_SLOTS for orgs without a plan row. */
  defaultOrgSlots: number;
  /** DOCSLURP_LOADTEST_MAX_MACHINES. */
  loadtestMaxMachines: number;
}

export function resolveWorkerScalerQueryParams(env: NodeJS.ProcessEnv = process.env): WorkerScalerQueryParams {
  return {
    pageFanout: Math.max(1, Math.min(128, Number.parseInt(env.WORKER_PAGE_CONCURRENCY ?? "1", 10) || 1)),
    defaultOrgSlots: Math.max(1, Number.parseInt(env.WORKER_DEFAULT_ORG_SLOTS ?? "50", 10) || 50),
    loadtestMaxMachines: Math.max(1, Number.parseInt(env.DOCSLURP_LOADTEST_MAX_MACHINES ?? "125", 10) || 125),
  };
}

export interface WorkerScalerSnapshot {
  queue_depth: number;
  queued_documents: number;
  queued_pages: number;
  pending_page_tasks?: number;
  processing_runs: number;
  processing_documents: number;
  processing_pages: number;
  stale_leases: number;
  worker_active: number;
  pages_processed_total: number;
  oldest_queued_run_age_seconds: number | null;
  oldest_queued_run_created_at_seconds: number | null;
  /** [{ org_key, slots, demand }]: see calculateWorkerTargetMachines. */
  org_demand?: unknown;
}

export const EMPTY_WORKER_SCALER_SNAPSHOT: WorkerScalerSnapshot = {
  queue_depth: 0,
  queued_documents: 0,
  queued_pages: 0,
  processing_runs: 0,
  processing_documents: 0,
  processing_pages: 0,
  stale_leases: 0,
  worker_active: 0,
  pages_processed_total: 0,
  oldest_queued_run_age_seconds: null,
  oldest_queued_run_created_at_seconds: null,
};

/** One read of queue state and per-org slot demand. */
export async function queryWorkerScalerSnapshot(sql: ScalerSql, params: WorkerScalerQueryParams): Promise<WorkerScalerSnapshot> {
  const rows = await sql`
    select
      count(*) filter (
        where status = 'queued'
          and coalesce(control_state, '') not in ('paused', 'cancelled')
      )::int as queue_depth,
      coalesce(sum(total_documents) filter (
        where status = 'queued'
          and coalesce(control_state, '') not in ('paused', 'cancelled')
      ), 0)::int as queued_documents,
      coalesce(sum(pages_total) filter (
        where status = 'queued'
          and coalesce(control_state, '') not in ('paused', 'cancelled')
      ), 0)::int as queued_pages,
        (select count(*)::int from page_work_tasks p join workspace_runs r on r.id=p.run_id
          where p.status in ('queued','processing') and r.status='processing'
          and coalesce(r.control_state,'') not in ('paused','cancel_requested','cancelled')) as pending_page_tasks,
        (select coalesce(json_agg(d), '[]'::json) from (
          select org_key, max(slots)::int as slots,
            sum(greatest(1, least(fanout_cap, page_demand), least(slots, shard_demand)))::int as demand
          from (
            select coalesce(r.org_id, 'workspace:' || r.workspace_id) as org_key,
              coalesce(o.worker_slots, ${params.defaultOrgSlots}) as slots,
              case when r.status = 'processing' then r.shard_demand else 0 end as shard_demand,
              least(${params.pageFanout}, coalesce(o.worker_slots, ${params.defaultOrgSlots}), 128) as fanout_cap,
              greatest(
                (select count(*) from page_work_tasks p where p.run_id = r.id and p.status in ('queued','processing')),
                case when coalesce((r.pipeline->>'visionFallback')::boolean,false)
                  and coalesce((r.pipeline->>'maxCostCents')::numeric,0)=0
                  and not exists(select 1 from workspace_run_stage_states s where s.run_id=r.id and s.stage_name='vision-extract' and s.status='completed')
                then r.pages_total else 0 end
              ) as page_demand
            from workspace_runs r
            left join organizations o on o.id = r.org_id
            where (r.status = 'queued' and coalesce(r.control_state,'') not in ('paused','cancelled'))
              or (r.status = 'processing' and coalesce(r.control_state,'') not in ('paused','cancel_requested','cancelled')
                and coalesce(r.lease_expires_at, now()) >= now())
            union all
            select p.org_id as org_key, coalesce(o.worker_slots, ${params.defaultOrgSlots}) as slots,
              0 as shard_demand, 2 as fanout_cap, 1 as page_demand
            from document_page_renders p left join organizations o on o.id=p.org_id
            where p.expires_at > now()
          ) runs
          group by org_key
        ) d) as org_demand,
      count(*) filter (
        where status = 'processing'
      )::int as processing_runs,
      coalesce(sum(total_documents) filter (
        where status = 'processing'
          and coalesce(control_state, '') not in ('paused', 'cancel_requested', 'cancelled')
          and coalesce(lease_expires_at, now()) >= now()
      ), 0)::int as processing_documents,
      coalesce(sum(pages_total) filter (
        where status = 'processing'
          and coalesce(control_state, '') not in ('paused', 'cancel_requested', 'cancelled')
          and coalesce(lease_expires_at, now()) >= now()
      ), 0)::int as processing_pages,
      count(*) filter (
        where status = 'processing'
          and coalesce(lease_expires_at, to_timestamp(0)) < now()
      )::int as stale_leases,
      count(*) filter (
        where status = 'processing'
          and coalesce(control_state, '') not in ('paused', 'cancel_requested', 'cancelled')
          and coalesce(lease_expires_at, now()) >= now()
      )::int as worker_active,
      coalesce(sum(pages_processed), 0)::int as pages_processed_total,
      extract(epoch from (
        now() - min(created_at) filter (
          where status = 'queued'
            and coalesce(control_state, '') not in ('paused', 'cancelled')
        )
      )) as oldest_queued_run_age_seconds,
      extract(epoch from min(created_at) filter (
        where status = 'queued'
          and coalesce(control_state, '') not in ('paused', 'cancelled')
      )) as oldest_queued_run_created_at_seconds
    from workspace_runs
  `;
  return (rows[0] as WorkerScalerSnapshot | undefined) ?? EMPTY_WORKER_SCALER_SNAPSHOT;
}

function metricLine(name: string, value: number, labels?: Record<string, string>): string {
  const suffix = labels && Object.keys(labels).length > 0
    ? `{${Object.entries(labels)
        .map(([key, rawValue]) => `${key}="${rawValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(",")}}`
    : "";
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

/** Queue gauges and the fleet target; fly-autoscaler reads docslurp_worker_target_machines. */
export function formatWorkerScalerMetricLines(
  queue: WorkerScalerSnapshot,
  config: WorkerScalerConfig,
  params: Pick<WorkerScalerQueryParams, "loadtestMaxMachines">,
): string[] {
  const orgs = parseOrgDemand(queue.org_demand);
  const workerTargetMachines = calculateWorkerTargetMachines({ orgs, workerActive: Number(queue.worker_active ?? 0) }, config);
  const gauge = (name: string, help: string, value: number) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, metricLine(name, value)];
  return [
    ...gauge("docslurp_pending_page_tasks", "Independently queued or processing page activities.", Number(queue.pending_page_tasks ?? 0)),
    ...gauge("docslurp_queue_depth", "Current queued run count.", Number(queue.queue_depth ?? 0)),
    ...gauge("docslurp_queued_documents", "Current queued document count from API-created runs.", Number(queue.queued_documents ?? 0)),
    ...gauge("docslurp_queued_pages", "Current queued page count from API-created runs.", Number(queue.queued_pages ?? 0)),
    ...gauge("docslurp_processing_runs", "Current processing run count.", Number(queue.processing_runs ?? 0)),
    ...gauge("docslurp_stale_leases", "Current processing runs with expired leases.", Number(queue.stale_leases ?? 0)),
    ...gauge("docslurp_worker_active", "Current processing run count with a live lease.", Number(queue.worker_active ?? 0)),
    ...gauge("docslurp_worker_target_machines",
      "Fly worker Machine target: ceil(min(sum over orgs of min(demand, worker_slots), global cap) / slots per machine x headroom), zero when idle, capped by DOCSLURP_WORKER_MAX_AUTOSCALE_MACHINES.",
      workerTargetMachines),
    ...gauge("docslurp_worker_slot_demand", "Runnable work in worker slots, capped per org by plan worker_slots.", slotDemand(orgs, config.excludedOrgKeys)),
    ...gauge("docslurp_worker_demand_orgs", "Orgs with runnable work.", orgs.filter((org) => org.demand > 0 && !config.excludedOrgKeys.has(org.orgKey)).length),
    ...gauge("docslurp_worker_slots_per_machine", "Configured activity slots per worker Machine.", config.slotsPerMachine),
    ...gauge("docslurp_worker_global_slot_cap", "Fleet-wide slot ceiling (0 = none).", config.globalSlotCap),
    ...gauge("docslurp_worker_max_autoscale_machines", "Configured maximum Fly worker Machine target.", config.maxMachines),
    ...gauge("docslurp_loadtest_worker_target_machines", "Machine target for the load-test fleet (TEMPORAL_LOADTEST_ORG_IDS only).",
      calculatePoolTargetMachines(orgs, config.excludedOrgKeys, { ...config, maxMachines: params.loadtestMaxMachines })),
    ...gauge("docslurp_oldest_queued_run_created_at_seconds", "Unix timestamp for the oldest queued run.", Number(queue.oldest_queued_run_created_at_seconds ?? 0)),
    ...gauge("docslurp_oldest_queued_run_age_seconds", "Age in seconds of the oldest queued run.", Number(queue.oldest_queued_run_age_seconds ?? 0)),
  ];
}
