import { closeDirectUploadLockPool } from "./lib/direct-upload-locks.js";
import { tigrisUploadWebhookRoutes } from "./routes/tigris-upload-webhook.js";
import { startDirectUploadReconciler, stopDirectUploadReconciler } from "./services/direct-upload-reconciler.js";
import { apiPublicErrorMiddleware } from "./lib/public-errors.js";
import { nativeBodyLimit, nativeErrorHandler } from "./lib/api-error.js";
import { sessionToolRoutes } from "./routes/session-tools.js";
import { existsSync } from "node:fs";
import { initializeObservability } from "@docslurp/shared/observability";
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
import { extractorRoutes } from "./routes/extractors.js";
import { docsRoutes } from "./routes/docs.js";
import { healthRoutes } from "./routes/health.js";
import { organizationsRoutes } from "./routes/organizations.js";
import { runsRoutes } from "./routes/runs.js";
import { jobsRoutes } from "./routes/jobs.js";
import { uploadEstimateRoutes, uploadsRoutes } from "./routes/uploads.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { apiKeysRoutes } from "./routes/api-keys.js";
import { searchRoutes, searchesRoutes, workspaceChatRoutes } from "./routes/search.js";
import { webRoutes } from "./routes/web.js";
import { workspaceGraphRoutes } from "./routes/workspace-graph.js";
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
import { workspaceRefPath } from "./middleware/workspace-ref-path.js";
import { spendAwareErrorHandler } from "./services/billing/spend-guard.js";
import { UnreadableSourceError } from "./services/source-metadata.js";
import { warmDefaultLocalEmbedding } from "./lib/ai.js";
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
export { drainSearchSessionWrites } from "./search/session.js";

export function createApiApp(): Hono {
  const app = new Hono();
  // Spend blocked by credits, budget caps or entitlement is a 402, not a 500.
  // Native paths answer thrown errors in the error envelope; protocol surfaces keep their shapes.
  app.onError(nativeErrorHandler((error, c) => {
    // The request span records it (message, stack) once the response is sent.
    setCurrentRequestError(error);
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
  // `/v1/workspaces/:slug|default/...` → resolved workspace UUID routes.
  const workspaceRefs = workspaceRefPath([workspacesRoutes, connectorsRoutes, secretsRoutes, workspaceGraphRoutes]);
  app.use("/v1/workspaces/:workspaceRef", workspaceRefs);
  app.use("/v1/workspaces/:workspaceRef/*", workspaceRefs);

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
  app.route("/v1/runs", runsRoutes);
  app.route("/v1/jobs", jobsRoutes);
  app.route("/v1/workspaces", workspacesRoutes);
  app.route("/v1/documents", documentsRoutes);
  app.route("/v1/exports", exportsRoutes);
  app.route("/v1/extractors", extractorRoutes);
  // Deprecated alias of /v1/uploads, kept while browser-key uploads depend on its widget CORS policy (middleware/widget-cors.ts).
  app.route("/v1/ingest", uploadsRoutes);
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
  app.route("/v1/chat", workspaceChatRoutes);
  app.route("/v1", chatCompletionsRoutes);
  app.route("/v1", suggestRoutes);
  app.route("/v1/mcp", mcpRoutes);
  app.route("/v1/session-tools", sessionToolRoutes);
  app.route("/compat/algolia", algoliaCompatRoutes);
  app.route("/compat", searchCompatRoutes);
  app.route("/v1/auth", samlCallbackRoutes);
  app.route("/v1/workspaces", connectorsRoutes);
  app.route("/v1/billing", billingRoutes);
  app.route("/v1/admin/billing", adminBillingRoutes);
  app.route("/v1/workspaces", secretsRoutes);
  app.route("/v1/workspaces", workspaceGraphRoutes);
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
// LISTEN subscriptions retry until their dependency returns (lib/start-with-retry.ts).
let listenerStarts: StartWithRetry[] = [];

/** Stops this module instance's timers and LISTEN subscription. */
async function stopApiBackgroundTasks(): Promise<void> {
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
      // Invalid private endpoint config fails startup; the /models probe never blocks it.
      initializePrivateModelEndpoints();
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
      startMaintenanceSweeper();
      startDirectUploadReconciler();
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
      // Loud when limits are per instance (no Redis) or disabled.
      logRateLimitBackendAtStartup();
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
