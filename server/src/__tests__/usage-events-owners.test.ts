import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Spend has one attribution rule (the usage_attribution view, read through
 * server/src/services/usage-attribution.ts) and two write-side ledgers. Any
 * other module querying usage_events directly is hand-written spend SQL that
 * will drift (architect gaps A6, A7). Read spend through usage-attribution.ts
 * or the view; record usage through a ledger.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// The one-off model URI backfill reads usage rows for their model labels only (never spend) and adds
// `metadata.modelUri` to existing rows; it records no usage.
const MODEL_URI_BACKFILL = "server/src/services/model-uri-backfill.ts";
// Found once the check ran from server/ (it used to scan nothing there): the worker ledger's own existence check for a
// skipped OCR charge (migration 0185), and the vision receipt reconciliation, which swaps estimated receipt metadata for
// provider receipts with a tenant-scoped compare-and-swap and never changes spend.
const LEDGER_STORE = "worker/src/db/usage-event-store.ts";
const RECEIPT_RECONCILIATION = "worker/src/db/vision-receipt-reconciliation.ts";
const READ_OWNERS = new Set(["server/src/services/usage-attribution.ts", MODEL_URI_BACKFILL, LEDGER_STORE, RECEIPT_RECONCILIATION]);
const WRITE_OWNERS = new Set([
  "server/src/lib/ai-usage.ts",
  LEDGER_STORE,
  MODEL_URI_BACKFILL,
  RECEIPT_RECONCILIATION,
]);

// app/src is absent from the open-source export; roots that do not exist are skipped. Resolved from the repository
// root, so the check scans the same files whether vitest runs from server/ or from the root.
const SOURCE_ROOTS = ["app/src", "server/src", "worker/src", "packages"].filter((root) => existsSync(join(repoRoot, root)));
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "test", "testdata", ".astro"]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mts|js|mjs|astro)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function offenders(pattern: RegExp, owners: Set<string>): string[] {
  const found: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      const path = relative(repoRoot, file).split("\\").join("/");
      if (owners.has(path)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (pattern.test(line)) found.push(`${path}:${index + 1}`);
      });
    }
  }
  return found;
}

describe("usage_events ownership", () => {
  it("scans the server and worker sources", () => {
    expect(SOURCE_ROOTS).toEqual(expect.arrayContaining(["server/src", "worker/src"]));
  });

  it("reads usage_events only in usage-attribution.ts", () => {
    expect(offenders(/\b(?:from|join)\s+usage_events\b/i, READ_OWNERS)).toEqual([]);
  });

  it("writes usage_events only through the API and worker ledgers", () => {
    expect(offenders(/\b(?:into|update)\s+usage_events\b/i, WRITE_OWNERS)).toEqual([]);
  });

  it("leaves project_runs.spent_cents to the usage_events trigger (migration 0056)", () => {
    // The run cost cap reads it; any other writer would drift from the ledger.
    expect(offenders(/\bspent_cents\s*=(?!=)/i, new Set())).toEqual([]);
  });
});
