import { platformVendorScope, vendorBalanceMonitor, vendorBillingReason, VendorErrorFrames } from "./vendor-balance-alerts.js";
import { startDependencySpan } from "./telemetry.js";
import { LlmResponseScanner, llmRequestAttributes } from "./llm-span-attributes.js";

const LLM_GENERATION_PATHS = new Set(["/api/v1/chat/completions", "/api/v1/completions", "/api/v1/responses"]);

const GENERIC_ERROR = JSON.stringify({ error: { message: "Provider request failed", type: "provider_error" } });

/** Buffer one SSE event (or one JSON envelope) before releasing any of its bytes. */
function redactProviderBody(body: ReadableStream<Uint8Array>, eventStream: boolean, responseFormat: "json" | "password-range"): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "", line = "";
  let lines: string[] = [];
  let afterCR = false, size = 0;
  const failure = () => eventStream ? `data: ${GENERIC_ERROR}\n\n` : GENERIC_ERROR;
  const sanitize = (frame: string[]) => {
    // Only data and protocol event names belong to the public generated stream.
    const fields = frame.map(raw => {
      const colon = raw.indexOf(":");
      return [colon < 0 ? raw : raw.slice(0, colon), colon < 0 ? "" : raw.slice(colon + 1).replace(/^ /, "")];
    });
    const event = fields.filter(([key]) => key === "event").at(-1)?.[1];
    const data = eventStream ? fields.filter(([key]) => key === "data").map(([, value]) => value).join("\n") : frame[0];
    if (["error", "response.failed", "response.error"].includes(event ?? "")) return failure();
    if (!data?.trim()) return "";
    if (eventStream && data.trim() === "[DONE]") return "data: [DONE]\n\n";
    // The password-range service returns only SHA-1 suffix/count records.
    // Validate the representation before releasing it, regardless of upstream MIME.
    if (responseFormat === "password-range") {
      const records = data.split(/\r?\n/).filter(record => record.trim());
      if (!records.length || records.some(record => !/^[0-9A-F]{35}:\d{1,12}$/i.test(record))) throw new Error("Invalid provider response");
      return data;
    }
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new Error("Invalid provider response"); }
    if (value && typeof value === "object") {
      const envelope = value as Record<string, unknown>;
      const response = envelope.response as Record<string, unknown> | undefined;
      if (envelope.error != null || ["error", "response.failed", "response.error"].includes(String(envelope.type)) ||
          (response && typeof response === "object" && (response.error != null || response.status === "failed"))) return failure();
    }
    if (!eventStream) return data;
    if (event && !/^(?:message|completion|ping|content_block_(?:start|delta|stop)|message_(?:start|delta|stop)|response\.[a-z0-9_.]+)$/.test(event)) throw new Error("Invalid provider response");
    return `${event ? `event: ${event}\n` : ""}${fields.filter(([key]) => key === "data").map(([, value]) => `data: ${value}\n`).join("")}\n`;
  };
  const consume = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!eventStream) { pending += text; if (pending.length > 16 * 1024 * 1024) throw new Error("Provider response exceeds limit"); return; }
    for (const character of text) {
      if (afterCR) { afterCR = false; if (character === "\n") continue; }
      if (++size > 1024 * 1024) throw new Error("Provider response exceeds limit");
      if (character === "\r" || character === "\n") {
        afterCR = character === "\r";
        if (line) { lines.push(line); line = ""; }
        else { const output = sanitize(lines); if (output) controller.enqueue(encoder.encode(output)); lines = []; size = 0; }
      } else line += character;
    }
  };
  const sanitized = () => body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Decode bounded slices; never concatenate an unbounded upstream chunk.
      try { for (let offset = 0; offset < chunk.byteLength; offset += 16384) consume(decoder.decode(chunk.subarray(offset, offset + 16384), { stream: true }), controller); }
      catch { throw new Error("Invalid provider response or response exceeds limit"); }
    },
    flush(controller) {
      try {
        consume(decoder.decode(), controller);
        if (eventStream) { if (line) lines.push(line); if (lines.length) controller.enqueue(encoder.encode(sanitize(lines))); }
        else if (pending) controller.enqueue(encoder.encode(sanitize([pending])));
      } catch { throw new Error("Invalid provider response"); }
    },
  }));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= sanitized().getReader();
      try {
        const result = await reader.read();
        if (result.done) controller.close(); else controller.enqueue(result.value);
      } catch { controller.error(new Error("Invalid provider response or response exceeds limit")); }
    },
    async cancel(reason) { await (reader ? reader.cancel(reason) : body.cancel(reason)); },
  }, { highWaterMark: 0 });
}

/** Instrument provider transport through response consumption, including streamed output. */
export function instrumentFetch(provider: string, operation: string, http: typeof fetch = globalThis.fetch, responseFormat: "json" | "password-range" = "json"): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const span = startDependencySpan(`${provider}.${operation}`, {
      "docslurp.dependency.type": "http", "docslurp.dependency.provider": provider,
      "docslurp.dependency.operation": operation, "docslurp.dependency.phase": "request",
      "server.address": url.hostname, "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      "http.request.method": method,
    });
    // OpenRouter generations: record the requested route and, from the response, which upstream host served it.
    const llm = provider === "openrouter" && LLM_GENERATION_PATHS.has(url.pathname);
    if (llm) span.set(llmRequestAttributes(init?.body));
    const started = performance.now();
    let response: Response;
    try { response = await span.run(() => http(input, { ...init, redirect: "error" })); }
    catch (error) { span.end(error); throw new Error("Provider request failed"); }
    span.set({ "http.response.status_code": response.status,
      ...(llm ? { "docslurp.llm.time_to_headers_ms": Math.round(performance.now() - started) } : {}),
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
    // Provider bodies may repeat Authorization headers or internal service data.
    // Billing classification above consumes only a bounded operator-side preview.
    if (!response.ok && response.status >= 400) {
      void response.body?.cancel().catch(() => {});
      span.end(Object.assign(new Error(), { name: `HTTP_${response.status}` }));
      return new Response(JSON.stringify({ error: { message: "Provider request failed", type: "provider_error" } }), {
        status: response.status, headers: { "content-type": "application/json" },
      });
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
    const scanner = llm && response.ok ? new LlmResponseScanner() : null;
    const llmDecoder = new TextDecoder();
    let identified = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await span.run(() => reader.read());
          if (result.done) {
            if (sse) inspectSse(textDecoder.decode(), true);
            if (scanner) { scanner.push(llmDecoder.decode()); span.set(scanner.final()); }
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
            if (scanner) {
              if (bytes === 0) span.set({ "docslurp.llm.time_to_first_chunk_ms": Math.round(performance.now() - started) });
              scanner.push(llmDecoder.decode(result.value, { stream: true }));
              if (!identified) {
                const identity = scanner.identity();
                if (identity["docslurp.llm.upstream_provider"]) { span.set(identity); identified = true; }
              }
            }
            bytes += result.value.byteLength; controller.enqueue(result.value);
          }
        } catch (error) { span.end(error); controller.error(new Error("Provider request failed")); }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); }
        finally { span.end(statusError ?? Object.assign(new Error(), { name: "AbortError" })); }
      },
    }, { highWaterMark: 0 });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    // MIME is controlled by the provider. Validate every representation before release.

    const outputHeaders = new Headers(response.headers);
    outputHeaders.delete("content-length"); outputHeaders.delete("content-encoding");
    const wrapped = new Response(redactProviderBody(body, responseFormat === "json" && contentType.includes("text/event-stream"), responseFormat), { status: response.status, statusText: response.statusText, headers: outputHeaders });
    for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
    return wrapped;
  };
}
