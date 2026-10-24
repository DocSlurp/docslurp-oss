import { platformVendorScope, vendorBalanceMonitor, vendorBillingReason, VendorErrorFrames } from "./vendor-balance-alerts.js";
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
    // RequestInit.headers replaces Request headers; it does not merge them.
    const headers = new Headers(init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined);
    const vendorScope = platformVendorScope(provider, url, headers);
    if (vendorScope && !response.ok) vendorBalanceMonitor.observe(vendorScope, provider, operation, response.status);
    if (vendorScope && [400, 403, 429].includes(response.status)) {
      const reader = response.clone().body?.getReader();
      if (reader) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("bounded billing preview")), 1000); });
        let prefix = "";
        try {
          while (prefix.length < 16384) {
            const chunk = await Promise.race([reader.read(), deadline]);
            if (chunk.done) break;
            prefix += new TextDecoder().decode(chunk.value.subarray(0, 16384 - prefix.length));
            if (vendorBillingReason(response.status, prefix)) break;
          }
          vendorBalanceMonitor.observe(vendorScope, provider, operation, response.status, prefix);
        } catch { /* Missing/unreadable evidence is not a billing incident. */ }
        finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
      }
    }
    let upstreamError = false;
    let errorTail = "";
    const sse = response.headers.get("content-type")?.includes("text/event-stream") ? new VendorErrorFrames() : null;
    const textDecoder = new TextDecoder();
    const inspectSse = (fragment: string, finish = false) => {
      for (const error of sse?.push(fragment, finish) ?? []) {
        upstreamError = true;
        if (vendorScope && vendorBillingReason(200, error)) vendorBalanceMonitor.observe(vendorScope, provider, operation, 200, error);
      }
    };
    const statusError = !response.ok ? Object.assign(new Error(), { name: `HTTP_${response.status}` }) : undefined;
    if (!response.body || response.status === 0) {
      if (vendorScope && response.ok) vendorBalanceMonitor.observe(vendorScope, provider, operation, response.status);
      span.end(statusError); return response;
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await span.run(() => reader.read());
          if (result.done) {
            if (sse) inspectSse(textDecoder.decode(), true);
            if (vendorScope && response.ok && !upstreamError && !sse?.uninspectable) vendorBalanceMonitor.observe(vendorScope, provider, operation, response.status);
            span.set({ "http.response.body.size": bytes }); span.end(statusError); controller.close();
          } else {
            if (vendorScope && response.ok) {
              for (let offset = 0; offset < result.value.byteLength; offset += 16384) {
                const fragment = textDecoder.decode(result.value.subarray(offset, offset + 16384), { stream: true });
                if (sse) inspectSse(fragment);
                else {
                  const scan = errorTail + fragment;
                  upstreamError ||= /"error"\s*:/.test(scan);
                  errorTail = scan.slice(-64);
                }
              }
            }
            bytes += result.value.byteLength; controller.enqueue(result.value);
          }
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
