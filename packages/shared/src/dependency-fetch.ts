import { startDependencySpan } from "./telemetry.js";

/** Instrument provider transport through response consumption, including streamed output. */
export function instrumentFetch(provider: string, operation: string, http: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const span = startDependencySpan(`${provider}.${operation}`, {
      "docslurp.dependency.type": "http", "docslurp.dependency.provider": provider,
      "docslurp.dependency.operation": operation, "docslurp.dependency.phase": "request",
      "server.address": url.hostname, "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      "http.request.method": method,
    });
    let response: Response;
    try { response = await span.run(() => http(input, init)); }
    catch (error) { span.end(error); throw error; }
    span.set({ "http.response.status_code": response.status,
      "docslurp.providerRequestId": response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
    });
    const statusError = !response.ok ? Object.assign(new Error(), { name: `HTTP_${response.status}` }) : undefined;
    if (!response.body || response.status === 0) { span.end(statusError); return response; }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await span.run(() => reader.read());
          if (result.done) {
            span.set({ "http.response.body.size": bytes }); span.end(statusError); controller.close();
          } else { bytes += result.value.byteLength; controller.enqueue(result.value); }
        } catch (error) { span.end(error); controller.error(error); }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); }
        finally { span.end(statusError ?? Object.assign(new Error(), { name: "AbortError" })); }
      },
    }, { highWaterMark: 0 });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
    return wrapped;
  };
}
