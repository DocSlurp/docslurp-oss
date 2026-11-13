import type { Context } from "hono";
import type { RunOrigin } from "@docslurp/shared";

import { isFirstPartyAppActor } from "./first-party-app.js";

declare module "hono" {
  interface ContextVariableMap {
    /** Set by internal adapters (MCP tools) that replay a request into a route: always `machine`. */
    runOrigin: RunOrigin;
  }
}

/**
 * Where a run created by this request comes from, decided only from authentication: a first-party app cookie session is
 * `app`; API keys of any kind, CLI and MCP OAuth tokens, WebMCP session tools, connectors and internal callers are
 * `machine`. Never read from a request field, so a client cannot claim the app's defaults.
 */
export function runOriginOf(c: Context): RunOrigin {
  if (c.get("runOrigin") === "machine") return "machine";
  return isFirstPartyAppActor(c.get("requestActor")) && !c.get("apiKey") ? "app" : "machine";
}
