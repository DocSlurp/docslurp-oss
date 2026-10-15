import { serve } from "@hono/node-server";
import { ensureApiStartup, apiApp } from "./server.js";

// transformers.js can leave a rejected shared download promise unhandled when the preferred dtype file is
// missing and the loader falls back (see lib/ai.ts). A standalone server must log that, not exit.
process.on("unhandledRejection", (reason) => {
  console.error("[docslurp-server] unhandled rejection", reason instanceof Error ? reason.message : reason);
});

const port = Number.parseInt(process.env.PORT ?? "", 10) || 8787;

// Same startup the Astro app triggers in-process (migrations, background tasks).
await ensureApiStartup();

const server = serve({ fetch: apiApp.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`[docslurp-server] listening on http://${info.address}:${info.port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
