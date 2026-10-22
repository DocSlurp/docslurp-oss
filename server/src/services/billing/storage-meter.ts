import { PRICE_CARD, dailyStorageCredits, daysInUtcMonth, unitChargeMetadata } from "@docslurp/shared";
import { sql, type SqlClient } from "../../db.js";
import { recordCostEvent } from "../../lib/ai-usage.js";
import { STORAGE_USAGE_METRIC, STORAGE_USAGE_PROVIDER } from "../usage-attribution.js";
import { debitOrgCredits } from "./credits.js";
import { getOrgStorage } from "./overview.js";

const BYTES_PER_GB = 1024 ** 3;
const ORGS_PER_SWEEP = 200;

let warnedOverride = false;

/**
 * The daily storage meter runs whenever Stripe is configured (metering is
 * enforced), or when `DOCSLURP_BILL_STORAGE=true` turns it on without Stripe.
 */
export function isStorageBillingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.DOCSLURP_BILL_STORAGE?.trim().toLowerCase();
  if (env.STRIPE_SECRET_KEY?.trim()) {
    if (flag === "false" && !warnedOverride) {
      warnedOverride = true;
      console.warn("[billing] DOCSLURP_BILL_STORAGE=false ignored: metering is enforced while Stripe is configured");
    }
    return true;
  }
  return flag === "true";
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Charge one day of storage per org per UTC day (design gotcha 10) at
 * PRICE_CARD.storageGbMonth / days in the month, on every stored byte
 * (objects + indexes; no included GB). The
 * storage_meter_days primary key makes each (org, day) charge idempotent
 * across sweeps and instances; the Usage Event id is derived from the same
 * key, and credits are debited only when the event row is new.
 */
export async function runStorageMeter(options: { now?: Date } = {}): Promise<{ metered: number; charged: number }> {
  if (!isStorageBillingEnabled()) {
    return { metered: 0, charged: 0 };
  }
  const day = utcDay(options.now ?? new Date());
  // Usage is attributed to the creator, or to an owner once the creator's
  // account is deleted. Deleted orgs have no workspaces left to meter.
  const orgs = await sql<{ id: string; created_by_user_id: string }[]>`
    select o.id, coalesce(o.created_by_user_id, (
      select om.user_id from org_memberships om
      where om.org_id = o.id and om.role = 'owner'
      order by om.created_at limit 1
    )) as created_by_user_id
    from organizations o
    where o.deleted_at is null
      and not exists (select 1 from storage_meter_days d where d.org_id = o.id and d.day = ${day}::date)
      and exists (
        select 1 from workspaces w
        join workspace_corpus_stats s on s.workspace_id = w.id
        where w.org_id = o.id and (s.source_bytes > 0 or s.page_count > 0)
      )
    limit ${ORGS_PER_SWEEP}
  `;

  let charged = 0;
  for (const org of orgs) {
    try {
      if (await meterOrgDay(org, day)) charged += 1;
    } catch (error) {
      console.error(`[storage-meter] orgId=${org.id} day=${day} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { metered: orgs.length, charged };
}

async function meterOrgDay(org: { id: string; created_by_user_id: string }, day: string): Promise<boolean> {
  const storage = await getOrgStorage(org.id);
  const bytes = storage.objectBytes + storage.indexBytes;
  const daysInMonth = daysInUtcMonth(day);
  const credits = dailyStorageCredits(bytes, daysInMonth);
  const charge = { totalCredits: credits };

  return sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    const inserted = await client`
      insert into storage_meter_days (org_id, day, object_bytes, index_bytes, credits)
      values (${org.id}, ${day}::date, ${Math.round(storage.objectBytes)}, ${Math.round(storage.indexBytes)}, ${charge.totalCredits})
      on conflict (org_id, day) do nothing
      returning org_id
    `;
    if (inserted.length === 0 || !(charge.totalCredits > 0)) {
      return false;
    }
    const recorded = await recordCostEvent({
      userId: org.created_by_user_id,
      scope: { orgId: org.id },
      client,
      event: {
        id: `storage:${org.id}:${day}`,
        provider: STORAGE_USAGE_PROVIDER,
        model: "storage-meter",
        metric: STORAGE_USAGE_METRIC,
        amount: bytes / BYTES_PER_GB,
        unit: "gb-day",
        costCents: charge.totalCredits,
        metadata: unitChargeMetadata({
          day,
          daysInMonth,
          storageGbMonth: PRICE_CARD.storageGbMonth,
          objectBytes: storage.objectBytes,
          indexBytes: storage.indexBytes,
          sourceBytes: storage.sourceBytes,
          pages: storage.pages,
          // Artifact and index bytes are estimated from page counts.
          estimate: true,
        }),
      },
    });
    if (!recorded) {
      return false;
    }
    await debitOrgCredits(client, {
      orgId: org.id,
      credits: charge.totalCredits,
      userId: org.created_by_user_id,
      reason: "storage",
      metadata: { day, usageEventId: `storage:${org.id}:${day}` },
    });
    return true;
  }) as Promise<boolean>;
}
