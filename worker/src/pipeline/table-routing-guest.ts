/**
 * VM guest: scan the HTML tables in a document's extracted pages for table repair and table routing.
 *
 * Runs only inside the credential-free parser VM in the service profile (`scripts/table-routing.mjs`, which calls
 * `enterTableScanGuest` first); the host never scans HTML tables there (`@docslurp/shared` `scanPageTables` refuses). The
 * result is typed data per page (table spans, cell texts, row/column counts) that the host validates
 * (`table-routing-vm.ts`) before the shared repair and reliability checks read it: no HTML from the guest is copied into a
 * page except as cell text the host escapes.
 */
import { scanPageTables, type HtmlTableScan } from "@docslurp/shared/page-table-routing";

export { enterTableScanGuest } from "@docslurp/shared/page-table-routing";

/** Pages in one VM job. */
export const TABLE_ROUTING_MAX_PAGES = 4096;

/** Each page's scan; null for a page the scanner failed on (the host treats it as unread). */
export function scanTableRoutingBatch(pages: unknown): Array<HtmlTableScan | null> {
  if (!Array.isArray(pages) || pages.length > TABLE_ROUTING_MAX_PAGES) throw new Error("invalid table routing batch");
  return pages.map((page) => {
    if (typeof page !== "string") return null;
    try {
      return scanPageTables(page);
    } catch {
      return null;
    }
  });
}
