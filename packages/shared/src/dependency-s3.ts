import type { InitializeMiddleware, FinalizeRequestMiddleware, MiddlewareStack, MetadataBearer } from "@smithy/types";
import { startDependencySpan } from "./telemetry.js";

const installed = new WeakSet<object>();
/** Observe S3 commands and attempts without reading a body or changing SDK retries. */
export function instrumentS3Client<T extends { middlewareStack: MiddlewareStack<any, any> }>(client: T, endpoint?: string | null): T {
  if (installed.has(client)) return client;
  installed.add(client);
  const host = endpoint ? new URL(endpoint).hostname : undefined;
  const provider = host?.endsWith("backblazeb2.com") ? "backblaze" : host?.endsWith("tigris.dev") ? "tigris" : host?.endsWith("amazonaws.com") || !host ? "aws" : "s3-compatible";
  const attributes = (operation: string, phase: string) => ({ "rpc.system": "aws-api", "rpc.service": "S3", "rpc.method": operation,
    "docslurp.dependency.type": "s3", "docslurp.dependency.provider": provider, "docslurp.dependency.operation": operation,
    "docslurp.dependency.phase": phase, ...(host ? { "server.address": host } : {}) });
  const command: InitializeMiddleware<any, MetadataBearer> = (next, context) => async args => {
    const operation = (context.commandName ?? "UnknownCommand").replace(/Command$/, "");
    const span = startDependencySpan(`s3.${operation}`, { ...attributes(operation, "command"),
      "aws.s3.bucket": typeof args.input?.Bucket === "string" ? args.input.Bucket : undefined,
      "aws.s3.key": typeof args.input?.Key === "string" ? args.input.Key : undefined,
    });
    try {
      const result = await span.run(() => next(args));
      const output = result.output as MetadataBearer & { Body?: { once?: (event: string, callback: (...args: any[]) => void) => unknown }; ContentLength?: number };
      const metadata = output?.$metadata;
      span.set({ "http.response.status_code": metadata?.httpStatusCode, "http.request.resend_count": metadata?.attempts === undefined ? undefined : Math.max(0, metadata.attempts - 1),
        "aws.requestId": metadata?.requestId, "http.response.body.size": output?.ContentLength });
      // Adding end/error/close listeners does not put a Node Readable into flowing mode.
      if (output?.Body?.once) {
        let complete = false;
        output.Body.once("end", () => { complete = true; span.end(); });
        output.Body.once("error", error => span.end(error));
        output.Body.once("close", () => span.end(complete ? undefined : Object.assign(new Error(), { name: "AbortError" })));
      } else span.end();
      return result;
    } catch (error) { span.end(error); throw error; }
  };
  const attempt: FinalizeRequestMiddleware<any, MetadataBearer> = (next, context) => async args => {
    const operation = (context.commandName ?? "UnknownCommand").replace(/Command$/, "");
    const span = startDependencySpan(`s3.${operation}.attempt`, attributes(operation, "response_headers"));
    const request = args.request as { hostname?: string; method?: string };
    span.set({ "server.address": request.hostname, "http.request.method": request.method });
    try {
      const result = await span.run(() => next(args));
      span.set({ "http.response.status_code": result.output?.$metadata?.httpStatusCode });
      return result;
    } catch (error) { span.end(error); throw error; }
    finally { span.end(); }
  };
  client.middlewareStack.add(command, { step: "initialize", name: "docslurpS3CommandTelemetry" });
  client.middlewareStack.addRelativeTo(attempt, { relation: "after", toMiddleware: "retryMiddleware", name: "docslurpS3AttemptTelemetry" });
  return client;
}
