import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Organization isolation (AGENTS.md): every process-wide cache, memo or reuse
 * map must be keyed so that one organization's value is never served to,
 * reused by or observable from another. This test lists every module-level
 * mutable Map and every TtlLruCache in server, worker and packages, and fails
 * until each new one is classified here with why it cannot cross
 * organizations. Classifying a cache is a review step, not a formality: if
 * its key does not include the org (or an id that belongs to exactly one org
 * and is only used after access was checked), key it with
 * `orgScopedCacheKey` from @docslurp/shared and add a cross-org negative test.
 *
 * Classes:
 * - org: the key includes the organization id.
 * - tenant-id: keyed by one project, run, document or API key id, which belongs to exactly one
 *   organization, and only filled or read after that id's access was checked.
 * - per-job: keyed by an object or id of one job/request; dropped with it.
 * - operational: holds no customer-derived value (config, prices, models, connections, timers,
 *   counters, process-wide guards).
 * - own-input: the value is a pure function of the caller's own input and contains nothing
 *   derived from any other tenant's data.
 */
type CacheClass = "org" | "tenant-id" | "per-job" | "operational" | "own-input";

const REGISTRY: Record<string, { class: CacheClass; why: string }> = {
  "packages/sdk/src/embed/offline-search.ts#pipelineCache": { class: "operational", why: "client-side model pipeline by model id" },
  "packages/shared/src/automatic-model-selection.ts#familyPatterns": { class: "operational", why: "compiled regex per model family" },
  "packages/shared/src/client-ip.ts#proxyCache": { class: "operational", why: "parsed trusted-proxy config" },
  "packages/shared/src/endpoint-prices.ts#inFlight": { class: "operational", why: "provider price listings" },
  "packages/shared/src/endpoint-prices.ts#lastAttempt": { class: "operational", why: "provider price listings" },
  "packages/shared/src/endpoint-prices.ts#listings": { class: "operational", why: "provider price listings" },
  "packages/shared/src/extractor-aliases.ts#installed": { class: "operational", why: "extractor alias table" },
  "packages/shared/src/lancedb-ddb.ts#proxies": { class: "operational", why: "storage proxy per endpoint config" },
  "packages/shared/src/lancedb-s3-cache.ts#caches": { class: "tenant-id", why: "disk block cache per directory; blocks keyed by namespace+bucket+full object key, and object keys carry the org/project prefix" },
  "packages/shared/src/lancedb-s3-trace.ts#proxies": { class: "operational", why: "storage proxy per endpoint config" },
  "packages/shared/src/lancedb-s3-trace.ts#usableCaches": { class: "operational", why: "whether a cache directory is usable" },
  "packages/shared/src/openrouter-routing.ts#regionBlockedModels": { class: "operational", why: "model availability" },
  "server/src/lib/ai.ts#localEmbeddingPipelineCache": { class: "operational", why: "local model pipelines by model id" },
  "server/src/lib/billed-write-behind.ts#allowances": { class: "org", why: "keyed by org id" },
  "server/src/lib/capability-tokens.ts#derivedKeys": { class: "operational", why: "HKDF subkeys by fixed label" },
  "server/src/lib/provider-policy.ts#cache": { class: "tenant-id", why: "org:<id>, ws:<projectId>, user:<id> policy flags" },
  "server/src/middleware/chat-concurrency.ts#inFlight": { class: "tenant-id", why: "concurrency counters per actor" },
  "server/src/middleware/rate-limit.ts#spendCache": { class: "tenant-id", why: "keyed by API key id" },
  "server/src/search/deferred/page-vector-locator.ts#cache": { class: "tenant-id", why: "projectId+model; read only by an access-checked project search" },
  "server/src/search/deferred/page-vector-locator.ts#inflight": { class: "tenant-id", why: "projectId+model+stamp" },
  "server/src/search/deferred/request-policy.ts#keyCache": { class: "tenant-id", why: "live API key row by key id" },
  "server/src/search/eligible-documents.ts#TtlLruCache": { class: "tenant-id", why: "eligibility/availability per project scope, after access checks" },
  "server/src/search/eligible-documents.ts#keysByProject": { class: "tenant-id", why: "invalidation index by project" },
  "server/src/search/eligible-documents.ts#lastInvalidatedAt": { class: "tenant-id", why: "invalidation timestamps by project" },
  "server/src/search/eligible-documents.ts#pendingInvalidations": { class: "tenant-id", why: "invalidation timers by project" },
  "server/src/search/eligible-documents.ts#runProjects": { class: "tenant-id", why: "run id to its project" },
  "server/src/search/embedding-cache.ts#TtlLruCache": { class: "org", why: "embeddingCacheKey requires and hashes the org id" },
  "server/src/search/lancedb.ts#connections": { class: "operational", why: "connections per database URI" },
  "server/src/search/lancedb.ts#lastPrewarm": { class: "tenant-id", why: "prewarm timestamps per project table" },
  "server/src/search/lancedb.ts#missingTables": { class: "tenant-id", why: "negative lookups per per-org/project table URI" },
  "server/src/search/lancedb.ts#missingWithDocumentsLoggedAt": { class: "operational", why: "log throttle" },
  "server/src/search/lancedb.ts#tables": { class: "tenant-id", why: "open handles per per-org/project table URI+name" },
  "server/src/search/lean-logging.ts#open": { class: "org", why: "usage batches keyed by user, org, project and key" },
  "server/src/search/relevance.ts#preparedQueries": { class: "org", why: "tokenized query terms keyed by request org + query; no org, no cache" },
  "server/src/search/response-cache.ts#generations": { class: "tenant-id", why: "invalidation generation per project" },
  "server/src/search/response-cache.ts#partitionBytes": { class: "org", why: "byte totals per org partition" },
  "server/src/search/response-cache.ts#partitions": { class: "org", why: "partitioned by org; key hashes orgs, user, key, projects, request" },
  "server/src/search/result-cache.ts#TtlLruCache": { class: "org", why: "resultCacheKey requires and hashes the org id" },
  "server/src/search/session.ts#backgroundQueues": { class: "org", why: "session write queues per org" },
  "server/src/search/session.ts#pendingSessionWrites": { class: "per-job", why: "per search session id" },
  "server/src/search/session.ts#waitingByOrg": { class: "org", why: "counters per org" },
  "server/src/services/api-key-usage.ts#pagesToday": { class: "tenant-id", why: "per API key id" },
  "server/src/services/api-key-usage.ts#pendingIps": { class: "tenant-id", why: "per API key id" },
  "server/src/services/api-key-usage.ts#pendingRequests": { class: "tenant-id", why: "per API key id" },
  "server/src/services/materialization-policy.ts#issuerCache": { class: "tenant-id", why: "live API key row by key id" },
  "server/src/services/project-summary-tree-jobs.ts#statusEstimates": { class: "tenant-id", why: "per project id" },
  "server/src/services/search.ts#nativeFallbackLogged": { class: "operational", why: "log throttle" },
  "server/src/services/search.ts#projectOrgs": { class: "tenant-id", why: "project to its org, for admission fairness" },
  "server/src/services/spend-paused-runs.ts#pendingOrgSweeps": { class: "org", why: "timers per org" },
  "server/src/services/visual-candidates.ts#chatCache": { class: "org", why: "keyed org:project" },
  "server/src/services/web/service.ts#cache": { class: "org", why: "orgScopedCacheKey(org, project, user, input); org-less calls skip it" },
  "server/src/services/web/service.ts#orgCalls": { class: "org", why: "rate counters per org" },
  "worker/src/db/superseded-purge.ts#pendingHistoryPrunes": { class: "tenant-id", why: "per table URI" },
  "worker/src/graph/legacy-keys.ts#healed": { class: "tenant-id", why: "once-per-project migration guard" },
  "worker/src/lib/unicode-text.ts#segmenters": { class: "operational", why: "Intl.Segmenter per locale" },
  "worker/src/lib/vision-attempt-guard.ts#pendingOverruns": { class: "per-job", why: "overrun requests per run id" },
  "worker/src/media/rates.ts#verifiedUntil": { class: "operational", why: "provider rate check" },
  "worker/src/ocr/page-reader-warm.ts#runs": { class: "per-job", why: "warm state per run id" },
  "worker/src/pipeline/first-pass.ts#results": { class: "per-job", why: "runId+documentId" },
  "worker/src/pipeline/run-milestones.ts#finalStages": { class: "per-job", why: "final stage per run id" },
  "worker/src/pipeline/shard-calibration.ts#cache": { class: "operational", why: "aggregate shard timing profiles by executor; no customer content" },
  "worker/src/pipeline/shard-calibration.ts#warned": { class: "operational", why: "log throttle" },
  "worker/src/routing/runtime.ts#cachedPacks": { class: "operational", why: "routing policy packs" },
  "worker/src/routing/runtime.ts#reportedMarginRefusals": { class: "operational", why: "log throttle" },
  "worker/src/sandbox/scratch-sweep.ts#sweepers": { class: "operational", why: "sweep timers per directory" },
  "worker/src/sandbox/source-integrity.ts#staged": { class: "per-job", why: "per document id" },
  "worker/src/stages/embedding-runtime.ts#localEmbeddingPipelineCache": { class: "operational", why: "local model pipelines by model id" },
  "worker/src/stages/lancedb-maintenance.ts#ftsFailures": { class: "tenant-id", why: "per table" },
  "worker/src/stages/lancedb-writer.ts#tableQueues": { class: "tenant-id", why: "write queues per table" },
  "worker/src/stages/local-embedding-thread.ts#pipelines": { class: "operational", why: "model pipelines by model id" },
  "worker/src/stages/vision-extract.ts#LADDER_TASK_PLANS": { class: "per-job", why: "runId:documentId:ladder" },
  "worker/src/temporal/page-shard-profiles.ts#registeredProfiles": { class: "operational", why: "registered cost profiles" },
  "worker/src/tools/python-deps.ts#attempted": { class: "operational", why: "dependency installs" },
  "worker/src/tools/runner.ts#stagedDefinitionUse": { class: "operational", why: "tool definition refcounts" },
  "worker/src/tools/vendor-bundles.ts#failures": { class: "operational", why: "vendor bundle installs" },
  "worker/src/tools/vendor-bundles.ts#inflight": { class: "operational", why: "vendor bundle installs" },
  "worker/src/tools/vision-stream.ts#streamingUnsupported": { class: "operational", why: "provider capability by route" },
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_ROOTS = ["server/src", "worker/src", "packages"].filter((root) => existsSync(join(repoRoot, root)));
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "test", "testdata", "benchmarks", ".astro"]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|mts)$/.test(entry) && !/\.test\.|\.spec\.|\.d\.ts$/.test(entry)) files.push(path);
  }
  return files;
}

/** Module-level `const|let name = new Map()` (empty, so mutable) and any `new TtlLruCache`/`new LRUCache`. */
function discoveredCaches(): string[] {
  const found = new Set<string>();
  const moduleMap = /^(?:export\s+)?(?:const|let)\s+(\w+)\b[^=]*=\s*new\s+Map\s*(?:<.*>)?\s*\(\s*\)\s*;?\s*(?:\/\/.*)?$/;
  const lru = /\bnew\s+(?:TtlLruCache|LRUCache)\b/;
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      const path = relative(repoRoot, file).split("\\").join("/");
      const text = readFileSync(file, "utf8");
      // Join generic arguments split across lines so `new Map<\n  K,\n  V\n>()` is seen.
      const joined = text.replace(/new\s+Map\s*<([^()]*?)>\s*\(/gs, (match) => match.replace(/\s*\n\s*/g, " "));
      for (const line of joined.split("\n")) {
        const map = moduleMap.exec(line);
        if (map) found.add(`${path}#${map[1]}`);
        if (lru.test(line)) found.add(`${path}#${/LRUCache/.test(line) && !/TtlLruCache/.test(line) ? "LRUCache" : "TtlLruCache"}`);
      }
    }
  }
  return [...found].sort();
}

describe("organization isolation: process-wide caches", () => {
  const discovered = discoveredCaches();

  it("classifies every module-level cache or memo map", () => {
    const unclassified = discovered.filter((id) => !(id in REGISTRY));
    expect(unclassified, "classify each new cache in org-isolation-caches.test.ts (or key it with orgScopedCacheKey)").toEqual([]);
  });

  it("keeps the registry free of entries that no longer exist", () => {
    const discoveredSet = new Set(discovered);
    expect(Object.keys(REGISTRY).filter((id) => !discoveredSet.has(id))).toEqual([]);
  });

  it("gives every entry a reason", () => {
    expect(Object.entries(REGISTRY).filter(([, entry]) => entry.why.trim().length < 8).map(([id]) => id)).toEqual([]);
  });
});
