import { instrumentPostgres } from "@docslurp/shared/observability";
import type { WorkerCapability } from "@docslurp/shared";
import postgres, { type Sql } from "postgres";

import { sandboxedPdfBatchProvider } from "../extractors/sandboxed-pdf-batch.js";
import { dbTraceStatementHook } from "../lib/db-trace.js";
import { advertisedWorkerConfig } from "../lib/vm-only-parsing.js";
import { PostgresCapacityLeaseStore } from "../media/capacity/store.js";
import { PostgresMediaJournal } from "../media/journal.js";
import { PostgresPageReaderOrgBudget } from "../ocr/page-reader-budget.js";
import { PageTaskStore } from "./page-task-store.js";
import type { RunEventPublisherOptions } from "./run-event-store.js";
import { PostgresRunLedger } from "./run-ledger.js";
import { PostgresVisionAttemptBackend } from "./vision-attempt-store.js";
import {
  lexicalColumnProbe,
  ocrPageClassSettlementProbe,
  piiFindingsTableProbe,
  resolveWorkerCapabilities,
  WorkerCapabilityRegistry,
  type WorkerCapabilityRegistryOptions,
} from "./worker-capabilities.js";
import { WorkerSlotStore, resolveWorkerSlotOptions, type WorkerSlotOptions } from "./worker-slot-store.js";

/**
 * The worker process's database handle: one pool, the run ledger over it (db/run-ledger.ts, with the ports stages write
 * through), and the worker infrastructure built on the same pool (page tasks, worker slots, capacity leases, the media
 * journal, vision and page-reader ledgers, the capability registry). Maintenance (db/maintenance.ts) and the worker's job
 * loops take the pool (`stageSql`) and own their SQL.
 */
export class Store extends PostgresRunLedger {
  private readonly workerSlotOptions: WorkerSlotOptions;

  constructor(
    databaseUrl: string,
    leaseTtlMs: number,
    options?: {
      plausibilityWarningThreshold?: number;
      poisonRunFailureThreshold?: number;
      /** Connections per worker process; 8 activities share it (docs/scaling-1000-workers.md). */
      poolMax?: number;
      workerSlots?: WorkerSlotOptions;
      /** Run event coalescing (run-event-store.ts). */
      runEvents?: RunEventPublisherOptions;
    },
  ) {
    super(instrumentPostgres(postgres<Record<string, postgres.PostgresType>>(databaseUrl, {
      max: Math.max(1, options?.poolMax ?? 10),
      // Avoid stale result types in pooled statements after schema deployments.
      prepare: false,
      types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
      idle_timeout: 20,
      connect_timeout: 10,
    }), databaseUrl, { onStatement: dbTraceStatementHook() }), leaseTtlMs, options);
    this.workerSlotOptions = options?.workerSlots ?? resolveWorkerSlotOptions();
  }

  capacityLeaseStore(providerIds: string[]) { return new PostgresCapacityLeaseStore(this.sql, (id) => this.loadRun(id).catch(() => null), providerIds); }

  /** Raw client for stages that write their own tables (deferred indexing). */
  get stageSql(): Sql<Record<string, unknown>> { return this.sql; }

  get mediaJournal(): PostgresMediaJournal { return new PostgresMediaJournal(this.sql); }

  async close(): Promise<void> {
    await this.runEvents.close().catch((error) => {
      console.warn(`[run-events] final flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.sql.end();
  }

  get pageTasks(): PageTaskStore { return new PageTaskStore(this.sql, this.creditLeases); }

  get workerSlots(): WorkerSlotStore { return new WorkerSlotStore(this.sql, this.workerSlotOptions); }

  /**
   * This worker's row in the capability registry (worker-capabilities.ts):
   * what its build supports, with credit leases and early lexical search
   * advertised only when their config and schema are in place.
   */
  capabilityRegistry(options: Omit<WorkerCapabilityRegistryOptions, "sql" | "capabilities">): WorkerCapabilityRegistry {
    const lexicalColumnPresent = lexicalColumnProbe(this.sql);
    const ocrSettlement = ocrPageClassSettlementProbe(this.sql);
    const piiFindingsTable = piiFindingsTableProbe(this.sql);
    return new WorkerCapabilityRegistry({
      ...options,
      sql: this.sql,
      capabilities: () => resolveWorkerCapabilities({
        creditLeasesActive: () => this.creditLeases.active(),
        ocrPageClassSettlement: ocrSettlement,
        lexicalColumnPresent,
        piiFindingsTable,
        firstPassBatch: () => sandboxedPdfBatchProvider() !== null,
      }),
      config: () => advertisedWorkerConfig(),
    });
  }

  private visionAttemptBackend: PostgresVisionAttemptBackend | null = null;

  /** The shared vision attempt ledger every vision request of a run is admitted against (lib/vision-attempt-guard.ts). */
  get visionAttempts(): PostgresVisionAttemptBackend {
    this.visionAttemptBackend ??= new PostgresVisionAttemptBackend(this.sql);
    return this.visionAttemptBackend;
  }

  private pageReaderBudgetBackend: PostgresPageReaderOrgBudget | null = null;

  /** The page reader's fleet-wide org daily spend ledger (ocr/page-reader-budget.ts, migration 0163). */
  get pageReaderBudget(): PostgresPageReaderOrgBudget {
    this.pageReaderBudgetBackend ??= new PostgresPageReaderOrgBudget(this.sql);
    return this.pageReaderBudgetBackend;
  }

  /**
   * Whether every live worker advertises `capability` in the capability registry (worker_capabilities, migration 0055):
   * at least one row seen within the live window and not stopped, and none of them without it. Any error reads as no.
   * The app's own gate also checks Temporal's live pollers (server services/worker-fleet.ts); a worker cannot, so a
   * poller from before the handshake is not seen here. Every build since migration 0055 registers.
   */
  async fleetAdvertises(capability: WorkerCapability): Promise<boolean> {
    try {
      const [row] = await this.sql<{ live: number; lacking: number }[]>`
        select count(*)::int as live, count(*) filter (where not (${capability} = any(capabilities)))::int as lacking
        from worker_capabilities
        where stopped_at is null and last_seen_at > now() - interval '90 seconds'
      `;
      return (row?.live ?? 0) > 0 && (row?.lacking ?? 1) === 0;
    } catch (error) {
      console.warn(`[worker-capabilities] fleet check for ${capability} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Whether the app has enforced billing (Stripe configured); false before migration 0026. */
  async loadMeteringEnforced(): Promise<boolean> {
    if (!(await this.tables.exists("billing_runtime"))) return false;
    const [row] = await this.sql<{ metering_enforced: boolean }[]>`
      select metering_enforced from billing_runtime where id = true limit 1
    `;
    return row?.metering_enforced ?? false;
  }
}
