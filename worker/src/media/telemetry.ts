import { emitTelemetryLog as emit } from "@docslurp/shared/observability";
/** Match the shared SigNoz content-safe attribute allowlist. */
export function emitTelemetryLog(args: { severityText: "info" | "warn" | "error"; body: string;
  attributes?: Record<string, string | number> }) {
  const scope = new Set(["orgId", "workspaceId", "runId", "documentId"]);
  emit({ ...args, attributes: Object.fromEntries(Object.entries(args.attributes ?? {}).map(([key, value]) =>
    [scope.has(key) ? `docslurp.${key}` : `docslurp.media.${key}`, value])) });
}
