import { isBillingEnforced, storageCreditsPerMonth } from "@docslurp/shared";

import { sql } from "../../db.js";

export type RetainedVersionStorage = { bytes: number; pages: number; monthlyCredits: number | null; billingEnforced: boolean };

/**
 * Archived (retained, non-current) versions that still hold files: browsable but never searchable.
 * Exposed separately from the storage totals so the billing page can show what retention costs.
 * `monthlyCredits` is their source bytes at PRICE_CARD.storageGbMonth and is null when the deployment
 * does not bill.
 */
export async function getRetainedVersionStorage(
  orgId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<RetainedVersionStorage> {
  const [row] = await sql<{ bytes: string | number; pages: string | number }[]>`
    select coalesce(sum(file_size), 0)::text as bytes, coalesce(sum(page_count), 0)::text as pages
    from documents
    where org_id = ${orgId} and archived_at is not null and purged_at is null
  `;
  const bytes = Number(row?.bytes ?? 0);
  const pages = Number(row?.pages ?? 0);
  return {
    bytes,
    pages,
    billingEnforced: isBillingEnforced(env),
    monthlyCredits: isBillingEnforced(env) ? storageCreditsPerMonth(bytes) : null,
  };
}
