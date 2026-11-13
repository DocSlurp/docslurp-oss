import { realtimeMetrics } from "./realtime/broker.js";
import { chartExportDefaultsWarnings, chartExportSwitchWarning } from "@docslurp/shared";
import { loadPricingProvider, pricingDurableStateFromSql } from "@docslurp/shared/pricing-loader";
import { sql as pricingStateSql } from "./db.js";
import { closeDirectUploadLockPool } from "./lib/direct-upload-locks.js";
import { tigrisUploadWebhookRoutes } from "./routes/tigris-upload-webhook.js";
import { startDirectUploadReconciler, stopDirectUploadReconciler } from "./services/direct-upload-reconciler.js";
import { apiPublicErrorMiddleware } from "./lib/public-errors.js";
import { nativeBodyLimit, nativeErrorHandler } from "./lib/api-error.js";
import { sessionToolRoutes } from "./routes/session-tools.js";
import { existsSync } from "node:fs";
import { initializeObservability } from "@docslurp/shared/observability";
import { startRevisionMaintenance } from "./realtime/revision-maintenance.js";
import { envFlags, formatEnvFlags } from "@docslurp/shared/env-flags";
import { QuoteSettingsError, startLiveModelPriceRefresh } from "@docslurp/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { searchCompatRoutes } from "./routes/search-compat.js";
import { serviceCors } from "./middleware/widget-cors.js";
import { Hono } from "hono";

import { env } from "./config.js";
import { seedNonProductionUsers } from "./lib/seed-users.js";
import { initializePrivateModelEndpoints } from "./lib/privacy.js";
import { setCurrentRequestError, requestContextMiddleware } from "./lib/request-context.js";
import { multipartBodyLimit } from "./lib/upload-policy.js";
import { emitPostHogApiLog } from "./lib/posthog-ai-observability.js";
import { apiActorRateLimit, apiIpRateLimit, logRateLimitBackendAtStartup, warnSelfHostedBrowserKeysWithoutTrustedProxy } from "./middleware/rate-limit.js";
import { chatConcurrencyLimit } from "./middleware/chat-concurrency.js";
import { sessionAuth } from "./middleware/session-auth.js";
import { chatCompletionsRoutes } from "./routes/chat-completions.js";
import { documentsRoutes } from "./routes/documents.js";
import { exportsRoutes } from "./routes/exports.js";
import { configureApiExtractorIdAliases, extractorRoutes } from "./routes/extractors.js";
import { docsRoutes } from "./routes/docs.js";
import { healthRoutes } from "./routes/health.js";
import { organizationsRoutes } from "./routes/organizations.js";
import { runsRoutes } from "./routes/runs.js";
import { jobsRoutes } from "./routes/jobs.js";
import { uploadEstimateRoutes, uploadsRoutes } from "./routes/uploads.js";
import { estimateRoutes } from "./routes/estimate.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { projectsRoutes } from "./routes/projects.js";
import { chatInstructionsRoutes } from "./routes/chat-instructions.js";
import { assertOutputModerationConfig } from "./services/chat-output-moderation.js";
import { warnOrgLimitAboveOneWithUniqueIndex } from "./services/org-membership-limit.js";
import { apiKeysRoutes } from "./routes/api-keys.js";
import { searchRoutes, searchesRoutes, projectChatRoutes } from "./routes/search.js";
import { webRoutes } from "./routes/web.js";
import { projectGraphRoutes } from "./routes/project-graph.js";
import { artifactsRoutes } from "./routes/artifacts.js";
import { inviteRoutes, metaRoutes, dashboardRoutes, waitlistRoutes } from "./routes/frontend.js";
import { filesRoutes } from "./routes/files.js";
import { capabilitiesRoutes } from "./routes/capabilities.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { mcpRoutes } from "./routes/mcp.js";
import { mcpOAuthRoutes, mcpOAuthMetadataRoutes } from "./routes/mcp-oauth.js";
import { suggestRoutes } from "./routes/suggest.js";
import { algoliaCompatRoutes } from "./routes/algolia-compat.js";
import { authRoutes } from "./routes/auth.js";
import { samlCallbackRoutes, ssoRoutes } from "./routes/sso.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { adminBillingRoutes } from "./routes/admin-billing.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { clientSurfaceMiddleware, clientSurfaceRecorder } from "./services/client-surface.js";
import { drainSearchSessionWrites as drainSessionWrites } from "./search/session.js";
import { drainSearchCharges } from "./search/lean-logging.js";
import { billingRoutes } from "./routes/billing.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { secretsRoutes } from "./routes/secrets.js";
import { userSettingsRoutes } from "./routes/user-settings.js";
import { accountRoutes } from "./routes/account.js";
import { whoamiRoutes } from "./routes/whoami.js";
import { extractsRoutes } from "./routes/extracts.js";
import { startCreditDebitFlusher, stopCreditDebitFlusher } from "./services/billing/credit-debit-flusher.js";
import { syncMeteringEnforcement } from "./services/billing/metering.js";
import { startMaintenanceSweeper, stopMaintenanceSweeper } from "./services/maintenance-sweeper.js";
import { startAlertEvaluator, stopAlertEvaluator } from "./services/alerts/alert-evaluator.js";
import { startWorkerFleetRefresher, stopWorkerFleetRefresher } from "./services/worker-fleet.js";
import { startRunStartRecovery, stopRunStartRecovery } from "./services/run-start-recovery.js";
import { startWithRetry, type StartWithRetry } from "./lib/start-with-retry.js";
import { startWebhookOutboxListener, stopWebhookOutboxListener } from "./services/webhooks.js";
import { startOrgSpendChangedListener, stopOrgSpendChangedListener } from "./services/spend-paused-runs.js";
import { replaceProcessTask } from "./lib/process-singleton.js";
import { startDbWatchdog } from "./services/db-watchdog.js";
import { projectRefPath } from "./middleware/project-ref-path.js";
import { spendAwareErrorHandler } from "./services/billing/spend-guard.js";
import { UnreadableSourceError } from "./services/source-metadata.js";
import { warmDefaultLocalEmbedding } from "./lib/ai.js";
import { rejectLegacyProjectSelection } from "./lib/reject-legacy-project-selection.js";
import { rejectNulBytes } from "./lib/reject-nul.js";
import { registerProviderPolicy } from "./lib/provider-policy.js";

// OpenRouter requests made while serving a request follow its org's China-provider setting.
registerProviderPolicy();

const execFileAsync = promisify(execFile);

/** Largest declared JSON body accepted before validation on non-upload `/v1/*` routes. */
const JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;
/**
 * The repository root is the nearest ancestor holding drizzle.config.ts, or a
 * core/ checkout of it (the private app repo pins this repository as a submodule
 * there). A fixed relative hop breaks once the server is bundled
 * (dist/server/chunks/... in the image resolves to /app/app, not /app), which
 * silently skipped migrations.
 */
function findRepoRoot(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "drizzle.config.ts"))) return dir;
    if (existsSync(resolve(dir, "core/drizzle.config.ts"))) return resolve(dir, "core");
    if (dirname(dir) === dir) return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  }
}
const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

export { IN_PROCESS_ENV_KEY } from "./lib/client-ip.js";
export { forwardRequest } from "./lib/forward-request.js";
/** Commit pending write-behind search writes (sessions, usage) before the host exits; resolves after `timeoutMs` at most. */
export async function drainSearchSessionWrites(timeoutMs?: number): Promise<void> {
  const started = Date.now();
  await Promise.all([drainSessionWrites(timeoutMs), clientSurfaceRecorder.flush()]);
  // Then batched search charges and usage (lean-logging.ts): session persists enqueue usage, so they drain first, and
  // searches still finishing write at once from here on.
  await drainSearchCharges(timeoutMs === undefined ? 5_000 : Math.max(500, timeoutMs - (Date.now() - started)));
}

export function createApiApp(): Hono {
  const app = new Hono();
  // Spend blocked by credits, budget caps or entitlement is a 402, not a 500.
  // Native paths answer thrown errors in the error envelope; protocol surfaces keep their shapes.
  app.onError(nativeErrorHandler((error, c) => {
    // The request span records it (message, stack) once the response is sent.
    setCurrentRequestError(error);
    if (error instanceof QuoteSettingsError) return c.json({ error: error.message, code: error.code }, 400);
    return error instanceof UnreadableSourceError
      ? c.json({ error: error.message, code: error.code }, error.statusCode)
      : spendAwareErrorHandler(error, c);
  }));

  // Authentication is served first, ahead of the global middleware below: these
  // paths never ran the API IP limit, request context or widget CORS.
  app.route("/", authRoutes);

  app.use("*", requestContextMiddleware);
  app.use("*", apiPublicErrorMiddleware);
  app.use("*", apiIpRateLimit);
  app.use("*", serviceCors(env.corsAllowedOrigins));
  app.use("/dashboard/*", sessionAuth);
  app.use("/v1/*", sessionAuth);
  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "GET" && c.req.header("X-Docslurp-Realtime-Fallback") === "1") realtimeMetrics.fallbackRequests++;
    await next();
  });
  // Records which client surface (web, SDK, CLI, MCP, ...) each user reaches us through.
  app.use("/v1/*", clientSurfaceMiddleware);
  app.use("/compat/*", clientSurfaceMiddleware);
  app.use("/v1/*", apiActorRateLimit);
  // In-flight AI chat turns per API key (and per visitor of a browser key), streams included.
  app.use("/v1/*", chatConcurrencyLimit);
  app.use("/v1/mcp", nativeBodyLimit(1024 * 1024));
  app.use("/oauth/mcp/*", nativeBodyLimit(16 * 1024));
  // Bound actual bytes before NUL inspection or any route reader. Select the
  // smallest applicable cap first, so JSON uploads cannot buffer the file cap.
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/mcp") return next(); // protocol-specific cap above
    const upload = /^\/v1\/(?:uploads|ingest|extracts)(?:\/|$)/.test(c.req.path);
    const json = /\bjson\b/i.test(c.req.header("content-type") ?? "");
    if (upload && !json) {
      if (/\/bulk\/?$/.test(c.req.path)) return multipartBodyLimit(env.maxMultipartUploadBytes)(c, next);
      return nativeBodyLimit(env.maxUploadBytes)(c, next);
    }
    return nativeBodyLimit(JSON_BODY_MAX_BYTES)(c, next);
  });

  app.use(
    "/webhooks/stripe",
    nativeBodyLimit(1024 * 1024)
  );
  app.use("/webhooks/tigris/uploads", nativeBodyLimit(1024 * 1024));
  // The Algolia adapter reads JSON itself; bound it like the other compat adapters.
  app.use("/compat/algolia/*", nativeBodyLimit(256 * 1024));
  app.use("*", rejectNulBytes);
  app.use("/v1/*", rejectLegacyProjectSelection);
  // `/v1/projects/:slug|default/...` → resolved project UUID routes.
  const projectRefs = projectRefPath([projectsRoutes, chatInstructionsRoutes, connectorsRoutes, secretsRoutes, projectGraphRoutes]);
  app.use("/v1/projects/:projectRef", projectRefs);
  app.use("/v1/projects/:projectRef/*", projectRefs);

  app.route("/", healthRoutes);
  app.route("/", docsRoutes);
  app.route("/", mcpOAuthMetadataRoutes);
  app.route("/oauth/mcp", mcpOAuthRoutes);
  app.route("/meta", metaRoutes);
  app.route("/dashboard/bootstrap", dashboardRoutes);
  app.route("/v1/invites", inviteRoutes);
  app.route("/v1/waitlist", waitlistRoutes);
  app.route("/v1/organizations", organizationsRoutes);
  app.route("/v1/organizations", ssoRoutes);
  app.get("/v1/realtime", c => c.json({ error: "WebSocket Upgrade required" }, process.env.REALTIME_ENABLED === "true" ? 426 : 404));
  app.route("/v1/runs", runsRoutes);
  app.route("/v1/jobs", jobsRoutes);
  app.route("/v1/projects", projectsRoutes);
  app.route("/v1/projects", chatInstructionsRoutes);
  app.route("/v1/documents", documentsRoutes);
  app.route("/v1/exports", exportsRoutes);
  app.route("/v1/extractors", extractorRoutes);
  // Deprecated alias of /v1/uploads, kept while browser-key uploads depend on its widget CORS policy (middleware/widget-cors.ts).
  app.route("/v1/ingest", uploadsRoutes);
  app.route("/v1/estimate", estimateRoutes);
  app.route("/v1/uploads", uploadEstimateRoutes);
  app.route("/v1/uploads", uploadsRoutes);
  app.route("/v1/extracts", extractsRoutes);
  app.route("/v1/webhooks", webhooksRoutes);
  app.route("/v1/artifacts", artifactsRoutes);
  app.route("/v1/files", filesRoutes);
  app.route("/v1/api-keys", apiKeysRoutes);
  app.route("/v1/capabilities", capabilitiesRoutes);
  app.route("/v1/notifications", notificationsRoutes);
  app.route("/v1/feedback", feedbackRoutes);
  app.route("/v1/search", searchRoutes);
  app.route("/v1/web", webRoutes);
  app.route("/v1/searches", searchesRoutes);
  app.route("/v1/chat", projectChatRoutes);
  app.route("/v1", chatCompletionsRoutes);
  app.route("/v1", suggestRoutes);
  app.route("/v1/mcp", mcpRoutes);
  app.route("/v1/session-tools", sessionToolRoutes);
  app.route("/compat/algolia", algoliaCompatRoutes);
  app.route("/compat", searchCompatRoutes);
  app.route("/v1/auth", samlCallbackRoutes);
  app.route("/v1/projects", connectorsRoutes);
  app.route("/v1/billing", billingRoutes);
  app.route("/v1/admin/billing", adminBillingRoutes);
  app.route("/v1/admin/users", adminUsersRoutes);
  app.route("/v1/projects", secretsRoutes);
  app.route("/v1/projects", projectGraphRoutes);
  app.route("/v1/user-settings", userSettingsRoutes);
  app.route("/v1/account", accountRoutes);
  app.route("/v1/whoami", whoamiRoutes);
  app.route("/webhooks", stripeWebhookRoutes);
  app.route("/webhooks", tigrisUploadWebhookRoutes);

  return app;
}

export const apiApp = createApiApp();

/** Same entrypoint as the release command and compose `migrate` service (advisory-locked). */
async function runStartupMigrations(): Promise<void> {
  await execFileAsync("node", [resolve(repoRoot, "server/db/migrate.mjs")], {
    cwd: repoRoot,
    env: process.env
  });
}

function shouldRunStartupMigrations(): boolean {
  const override = process.env.RUN_STARTUP_MIGRATIONS?.trim().toLowerCase();
  if (override === "true") {
    return true;
  }
  if (override === "false") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

let startupPromise: Promise<void> | null = null;
let stopRevisionMaintenance: (() => Promise<void>) | undefined;
// LISTEN subscriptions retry until their dependency returns (lib/start-with-retry.ts).
let listenerStarts: StartWithRetry[] = [];

/** Stops this module instance's timers and LISTEN subscription. */
async function stopApiBackgroundTasks(): Promise<void> {
  await stopRevisionMaintenance?.();
  for (const pending of listenerStarts) pending.stop();
  listenerStarts = [];
  stopMaintenanceSweeper();
  await stopDirectUploadReconciler();
  await closeDirectUploadLockPool();
  stopAlertEvaluator();
  stopCreditDebitFlusher();
  stopRunStartRecovery();
  stopWorkerFleetRefresher();
  await stopWebhookOutboxListener().catch((error: unknown) => {
    console.error(`[webhook-outbox] unlisten failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await stopOrgSpendChangedListener().catch((error: unknown) => {
    console.error(`[spend-paused-runs] unlisten failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function ensureApiStartup(): Promise<void> {
  if (!startupPromise) {
    startupPromise = (async () => {
      initializeObservability({ serviceName: "docslurp-api" });
      // An unknown DOCSLURP_CHART_EXPORT (or default) value is off (fail closed); say so once.
      const chartExportWarning = chartExportSwitchWarning(process.env);
      if (chartExportWarning) console.warn(chartExportWarning);
      for (const warning of chartExportDefaultsWarnings(process.env)) console.warn(warning);
      // The pricing provider (DOCSLURP_PRICING_PLUGIN) prices every quote and charge; the service profile refuses to
      // start without one rather than price with the open default.
      // Its durable state (pricing_provider_state, 0131) is read-only through this process's pool; only the operator raises it.
      // It also refuses to start when this process's role could move the mark (refusePricingStateWriter, council M #1).
      await loadPricingProvider(process.env, { durableState: pricingDurableStateFromSql(pricingStateSql), sql: pricingStateSql });
      // Invalid private endpoint config fails startup; the /models probe never blocks it.
      initializePrivateModelEndpoints();
      // Legacy extractor ids must be installed before any stored or incoming config is parsed; a bad alias fails startup.
      configureApiExtractorIdAliases();
      if (shouldRunStartupMigrations()) {
        await runStartupMigrations();
      }

      await seedNonProductionUsers();
      // Publish billing enforcement before any worker reads it (the sweep repeats it).
      await syncMeteringEnforcement().catch((error: unknown) => {
        console.error(`[billing] metering enforcement sync failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      // After a dev module reload, stop the previous instance's tasks first:
      // they would keep running (and querying) alongside the new ones.
      await replaceProcessTask("api-background-tasks", stopApiBackgroundTasks)?.();
      stopRevisionMaintenance = startRevisionMaintenance(env.databaseUrl);
      startMaintenanceSweeper();
      startDirectUploadReconciler();
      // Live OpenRouter list prices for receipt-less usage; hardcoded tables until (or unless) they load.
      startLiveModelPriceRefresh();
      // Leader-elected alert checks; logs [alert] lines and posts ALERT_WEBHOOK_URL.
      startAlertEvaluator();
      // Apply workers' pending credit debits to org pools every few seconds.
      startCreditDebitFlusher();
      // Start queued runs whose workflow start was deferred or lost (also at boot).
      startRunStartRecovery();
      // Worker capability handshake: keep the fleet view warm for gated flags (services/worker-fleet.ts).
      startWorkerFleetRefresher();
      // Not awaited: a database that is down at boot must not block startup, and the
      // listener keeps retrying with backoff while the maintenance sweep covers the gap.
      listenerStarts.push(startWithRetry("webhook-outbox", startWebhookOutboxListener));
      // Top-ups, auto-recharge, budget/plan changes and released leases resume
      // spend-paused runs at once (the maintenance sweep is the fallback).
      listenerStarts.push(startWithRetry("spend-paused-runs", startOrgSpendChangedListener));

      // Restart the machine when the DB pool hangs on dead sockets (services/db-watchdog.ts).
      if (process.env.NODE_ENV === "production") startDbWatchdog();

      // Load the local query-embedding model in the background so the first
      // search after a deploy or machine start doesn't pay the cold load (~29 s).
      if (process.env.NODE_ENV === "production") {
        setTimeout(() => {
          const started = Date.now();
          warmDefaultLocalEmbedding()
            .then((model) => { if (model) console.log(`[search] warmed local embedding model=${model} ms=${Date.now() - started}`); })
            .catch((error: unknown) => console.error(`[search] embedding warm-up failed: ${error instanceof Error ? error.message : String(error)}`));
        }, 1_000).unref();
      }

      console.log(`[api] cors_allowed_origins=${env.corsAllowedOrigins.join(",")}`);
      // Boolean env flags this process booted with (MEDIA_REMOTE_ENABLED, AI_RATE_LIMIT_ENABLED, ...); unset ones
      // use code defaults. Console only (SigNoz via Fly logs): the startup event below can export to PostHog.
      console.log(`[api] env-flags ${formatEnvFlags(envFlags())}`);
      // Loud when limits are per instance (no Redis) or disabled.
      logRateLimitBackendAtStartup();
      // A bad CHAT_OUTPUT_MODERATION value fails the boot, not a chat turn.
      assertOutputModerationConfig();
      // DOCSLURP_MAX_ORGS_PER_USER above 1 while migration 0127's unique index still refuses a second membership.
      void warnOrgLimitAboveOneWithUniqueIndex(async () => {
        const { sql } = await import("./db.js");
        const [row] = await sql<{ present: boolean }[]>`select to_regclass('public.org_memberships_one_org_per_user') is not null as present`;
        return Boolean(row?.present);
      });
      void warnSelfHostedBrowserKeysWithoutTrustedProxy(async () => {
        const { sql } = await import("./db.js");
        return (await sql`select 1 from api_keys where key_type = 'client' and revoked_at is null limit 1`).length > 0;
      });
      emitPostHogApiLog({
        severityText: "info",
        eventName: "docslurp.api.startup_completed",
        body: "API startup complete",
        attributes: {
          startup_migrations_enabled: shouldRunStartupMigrations(),
        },
      });
    })().catch((error: unknown) => {
      // A transient failure (database restarting during migrations or seeding) must not
      // wedge every later call on one rejected promise: let the next caller retry.
      startupPromise = null;
      throw error;
    });
  }

  return startupPromise;
}
