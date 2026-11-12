/**
 * Cutover for PR #339 (scan what we parse): reprocess live documents that have no parse decision from the current scan.
 * Until they are reprocessed (which re-runs quarantine first), every parser, the page renderer and materialization refuse
 * them, and the API answers page images with 409 quarantine_rescan_required.
 *
 *   pnpm -C server exec tsx scripts/reprocess-unscanned-documents.ts [--dry-run | --apply]
 *     [--org=<orgId> ...] [--batch-size=50] [--limit=1000] [--all-types] [--pause-ms=0]
 *
 * Dry run is the default: it lists candidates per organization and changes nothing. --apply reprocesses them as each
 * organization's earliest owner, in batches of --batch-size documents (one bulk reprocess per batch), pausing --pause-ms
 * between batches. Reprocesses are billed to the organization like any reprocess (credits are checked per batch; a refused
 * batch is reported, not retried). Only PDFs by default (page images and materialization read PDFs); --all-types includes
 * every completed document. Documents whose newer version is already queued or processing are skipped, so a re-run resumes.
 * See docs/self-host/operations.md.
 */
import "../src/env.js";

const usage = "Usage: tsx scripts/reprocess-unscanned-documents.ts [--dry-run | --apply] [--org=<orgId> ...] [--batch-size=50] [--limit=1000] [--all-types] [--pause-ms=0]";
const args = process.argv.slice(2);
const known = /^(--apply|--dry-run|--all-types|--org=[\w-]{1,128}|--batch-size=\d{1,4}|--limit=\d{1,7}|--pause-ms=\d{1,6})$/;
if (args.some((arg) => !known.test(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) {
  console.error(usage);
  process.exit(2);
}
const numberArg = (name: string, fallback: number) => Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const apply = args.includes("--apply");
const orgIds = args.filter((arg) => arg.startsWith("--org=")).map((arg) => arg.slice("--org=".length));
const batchSize = numberArg("batch-size", 50);
const limit = numberArg("limit", 1000);
const pauseMs = numberArg("pause-ms", 0);
if (batchSize < 1 || batchSize > 500 || limit < 1) {
  console.error(`${usage}\n--batch-size must be 1-500 and --limit at least 1`);
  process.exit(2);
}

// Import the database only after argument validation.
const { sql } = await import("../src/db.js");
const { selectRescanCandidates, organizationOwner } = await import("../src/services/parse-source-rescan.js");
try {
  // postgres.js loads array types with the connection's first query; the candidate query binds arrays.
  await sql`select 1`;
  const candidates = await selectRescanCandidates(sql, {
    limit,
    ...(orgIds.length ? { orgIds } : {}),
    ...(args.includes("--all-types") ? {} : { mimeTypes: ["application/pdf"] }),
  });
  const byOrg = new Map<string, string[]>();
  for (const candidate of candidates) byOrg.set(candidate.orgId, [...(byOrg.get(candidate.orgId) ?? []), candidate.id]);
  const summary = { mode: apply ? "apply" : "dry-run", limit, batchSize, candidates: candidates.length, limitReached: candidates.length >= limit, orgs: [] as unknown[] };
  const { bulkReprocessDocuments } = apply ? await import("../src/services/documents.js") : { bulkReprocessDocuments: null };
  for (const [orgId, ids] of byOrg) {
    const owner = await organizationOwner(sql, orgId);
    const org: Record<string, unknown> = { orgId, documents: ids.length, owner: owner ? "found" : "missing" };
    summary.orgs.push(org);
    if (!apply) { org.sampleDocumentIds = ids.slice(0, 5); continue; }
    if (!owner || !bulkReprocessDocuments) { org.skipped = ids.length; continue; }
    const runs: string[] = []; let failed = 0; const errors: string[] = [];
    for (let start = 0; start < ids.length; start += batchSize) {
      const batch = ids.slice(start, start + batchSize);
      try {
        const result = await bulkReprocessDocuments(batch, owner);
        runs.push(...result.runs.map((run) => run.id));
        failed += result.failed.reduce((total, group) => total + group.documentIds.length, 0);
        for (const group of result.failed) errors.push(group.code ?? "failed");
      } catch (error) {
        failed += batch.length;
        errors.push((error as { code?: string } | null)?.code ?? (error instanceof Error ? error.name : "error"));
        // Raw text stays in this operator's log, never in a customer-facing surface.
        console.error(`[reprocess-unscanned] org=${orgId} batch=${start / batchSize} error=${error instanceof Error ? error.message : String(error)}`);
      }
      if (pauseMs > 0 && start + batchSize < ids.length) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    Object.assign(org, { runs, submittedDocuments: ids.length - failed, failedDocuments: failed, errors: [...new Set(errors)] });
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await sql.end();
}
