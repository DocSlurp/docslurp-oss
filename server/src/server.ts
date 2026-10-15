import { publicErrorMiddleware } from "./lib/public-errors.js";
import { sessionToolRoutes } from "./routes/session-tools.js";
import { existsSync } from "node:fs";
import { initializeObservability } from "@docslurp/shared/observability";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bodyLimit } from "hono/body-limit";
import { searchCompatRoutes } from "./routes/search-compat.js";
import { serviceCors } from "./middleware/widget-cors.js";
import { Hono } from "hono";

import { env } from "./config.js";
import { seedNonProductionUsers } from "./lib/seed-users.js";
import { initializePrivateModelEndpoints } from "./lib/privacy.js";
import { requestContextMiddleware } from "./lib/request-context.js";
import { multipartBodyLimit } from "./lib/upload-policy.js";
import { emitPostHogApiLog } from "./lib/posthog-ai-observability.js";
import { apiActorRateLimit, apiIpRateLimit } from "./middleware/rate-limit.js";
import { sessionAuth } from "./middleware/session-auth.js";
import { aiRoutes } from "./routes/ai.js";
import { chatCompletionsRoutes } from "./routes/chat-completions.js";
import { documentsRoutes } from "./routes/documents.js";
import { extractorRoutes } from "./routes/extractors.js";
import { docsRoutes } from "./routes/docs.js";
import { healthRoutes } from "./routes/health.js";
import { organizationsRoutes } from "./routes/organizations.js";
import { runsRoutes } from "./routes/runs.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { apiKeysRoutes } from "./routes/api-keys.js";
import { searchRoutes, workspaceChatRoutes } from "./routes/search.js";
import { indexStalenessRoutes } from "./routes/index-staleness.js";
import { workspaceGraphRoutes } from "./routes/workspace-graph.js";
import { artifactsRoutes } from "./routes/artifacts.js";
import { inviteRoutes, metaRoutes, shellRoutes, waitlistRoutes } from "./routes/frontend.js";
import { filesRoutes } from "./routes/files.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { mcpRoutes } from "./routes/mcp.js";
import { mcpOAuthRoutes, mcpOAuthMetadataRoutes } from "./routes/mcp-oauth.js";
import { suggestRoutes } from "./routes/suggest.js";
import { algoliaCompatRoutes } from "./routes/algolia-compat.js";
import { authRoutes } from "./routes/auth.js";
import { samlCallbackRoutes, ssoRoutes } from "./routes/sso.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { billingRoutes } from "./routes/billing.js";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.js";
import { secretsRoutes } from "./routes/secrets.js";
import { userSettingsRoutes } from "./routes/user-settings.js";
import { accountRoutes } from "./routes/account.js";
import { startCreditDebitFlusher, stopCreditDebitFlusher } from "./services/billing/credit-debit-flusher.js";
import { syncMeteringEnforcement } from "./services/billing/metering.js";
import { startMaintenanceSweeper, stopMaintenanceSweeper } from "./services/maintenance-sweeper.js";
import { startAlertEvaluator, stopAlertEvaluator } from "./services/alerts/alert-evaluator.js";
import { startWorkerFleetRefresher, stopWorkerFleetRefresher } from "./services/worker-fleet.js";
import { startRunStartRecovery, stopRunStartRecovery } from "./services/run-start-recovery.js";
import { startWebhookOutboxListener, stopWebhookOutboxListener } from "./services/webhooks.js";
import { startOrgSpendChangedListener, stopOrgSpendChangedListener } from "./services/spend-paused-runs.js";
import { replaceProcessTask } from "./lib/process-singleton.js";
import { startDbWatchdog } from "./services/db-watchdog.js";
import { workspaceRefPath } from "./middleware/workspace-ref-path.js";
import { spendAwareErrorHandler } from "./services/billing/spend-guard.js";
import { warmDefaultLocalEmbedding } from "./lib/ai.js";

const execFileAsync = promisify(execFile);
/**
 * The repository root is the nearest ancestor holding drizzle.config.ts. A fixed
 * relative hop breaks once the server is bundled (dist/server/chunks/... in the
 * image resolves to /app/app, not /app), which silently skipped migrations.
 */
function findRepoRoot(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "drizzle.config.ts"))) return dir;
    if (dirname(dir) === dir) return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  }
}
const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

export function createApiApp(): Hono {
  const app = new Hono();
  // Spend blocked by credits, budget caps or entitlement is a 402, not a 500.
  app.onError(spendAwareErrorHandler);

  // Authentication is served first, ahead of the global middleware below: these
  // paths never ran the API IP limit, request context or widget CORS.
  app.route("/", authRoutes);

  app.use("*", requestContextMiddleware);
  app.use("*", publicErrorMiddleware);
  app.use("*", apiIpRateLimit);
  app.use("*", serviceCors(env.corsAllowedOrigins));
  app.use("/v1/mcp", bodyLimit({ maxSize: 1024 * 1024 }));
  app.use("/oauth/mcp/*", bodyLimit({ maxSize: 16 * 1024 }));
  // The bulk path buffers multipart bodies in memory (parseBody); keep it small
  // and send large files to direct upload sessions (upload-policy.ts).
  app.use(
    "/v1/ingest/bulk",
    multipartBodyLimit(env.maxMultipartUploadBytes)
  );
  app.use(
    "/v1/ingest/*",
    bodyLimit({
      maxSize: env.maxUploadBytes
    })
  );

  app.use(
    "/webhooks/stripe",
    bodyLimit({
      maxSize: 1024 * 1024
    })
  );
  app.use("/v1/*", sessionAuth);
  app.use("/v1/*", apiActorRateLimit);
  // `/v1/workspaces/:slug|default/...` → resolved workspace UUID routes.
  const workspaceRefs = workspaceRefPath([workspacesRoutes, connectorsRoutes, secretsRoutes, workspaceGraphRoutes]);
  app.use("/v1/workspaces/:workspaceRef", workspaceRefs);
  app.use("/v1/workspaces/:workspaceRef/*", workspaceRefs);

  app.route("/", healthRoutes);
  app.route("/", docsRoutes);
  app.route("/", mcpOAuthMetadataRoutes);
  app.route("/oauth/mcp", mcpOAuthRoutes);
  app.route("/meta", metaRoutes);
  app.route("/v1/shell", shellRoutes);
  app.route("/v1/invites", inviteRoutes);
  app.route("/v1/waitlist", waitlistRoutes);
  app.route("/v1/ai", aiRoutes);
  app.route("/v1/organizations", organizationsRoutes);
  app.route("/v1/organizations", ssoRoutes);
  app.route("/v1/runs", runsRoutes);
  app.route("/v1/workspaces", workspacesRoutes);
  app.route("/v1/documents", documentsRoutes);
  app.route("/v1/extractors", extractorRoutes);
  app.route("/v1/ingest", uploadsRoutes);
  app.route("/v1/webhooks", webhooksRoutes);
  app.route("/v1/artifacts", artifactsRoutes);
  app.route("/v1/files", filesRoutes);
  app.route("/v1/api-keys", apiKeysRoutes);
  app.route("/v1/notifications", notificationsRoutes);
  app.route("/v1/search", searchRoutes);
  app.route("/v1/chat", workspaceChatRoutes);
  app.route("/v1", chatCompletionsRoutes);
  app.route("/v1", suggestRoutes);
  app.route("/v1/runs", indexStalenessRoutes);
  app.route("/v1/mcp", mcpRoutes);
  app.route("/v1/session-tools", sessionToolRoutes);
  app.route("/compat/algolia", algoliaCompatRoutes);
  app.route("/compat", searchCompatRoutes);
  app.route("/v1/auth", samlCallbackRoutes);
  app.route("/v1/workspaces", connectorsRoutes);
  app.route("/v1/billing", billingRoutes);
  app.route("/v1/workspaces", secretsRoutes);
  app.route("/v1/workspaces", workspaceGraphRoutes);
  app.route("/v1/user-settings", userSettingsRoutes);
  app.route("/v1/account", accountRoutes);
  app.route("/webhooks", stripeWebhookRoutes);

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

/** Stops this module instance's timers and LISTEN subscription. */
async function stopApiBackgroundTasks(): Promise<void> {
  stopMaintenanceSweeper();
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
      // Leader-elected alert checks; logs [alert] lines and posts ALERT_WEBHOOK_URL.
      startAlertEvaluator();
      // Apply workers' pending credit debits to org pools every few seconds.
      startCreditDebitFlusher();
      // Start queued runs whose workflow start was deferred or lost (also at boot).
      startRunStartRecovery();
      // Worker capability handshake: keep the fleet view warm for gated flags (services/worker-fleet.ts).
      startWorkerFleetRefresher();
      await startWebhookOutboxListener().catch((error: unknown) => {
        console.error(`[webhook-outbox] listener failed; relying on the maintenance sweep: ${error instanceof Error ? error.message : String(error)}`);
      });
      // Top-ups, auto-recharge, budget/plan changes and released leases resume
      // spend-paused runs at once (the maintenance sweep is the fallback).
      await startOrgSpendChangedListener().catch((error: unknown) => {
        console.error(`[spend-paused-runs] listener failed; relying on the maintenance sweep: ${error instanceof Error ? error.message : String(error)}`);
      });

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
      emitPostHogApiLog({
        severityText: "info",
        body: "api_startup_complete",
        attributes: {
          startup_migrations_enabled: shouldRunStartupMigrations(),
        },
      });
    })();
  }

  return startupPromise;
}
