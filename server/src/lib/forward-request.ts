/**
 * Rebuilds `request` for another handler (new URL and/or headers) in a single
 * construction that keeps its abort signal.
 *
 * Hosts that mount the API in process (the Astro app) forward the framework's
 * Request. Chaining clones, as in `new Request(new Request(url, request), { headers })`,
 * silently loses client disconnects: undici's Request follows `init.signal`
 * through a weak reference to the new request's controller, so once the
 * unreferenced middle Request is garbage-collected the parent's abort no longer
 * reaches the final Request. Under real traffic that happens within seconds,
 * which is why chat turns kept running for up to 122 s after their clients had
 * gone (2026-10-20 eval: 0 of 43 disconnects stopped the agent). A single hop
 * with an explicit `signal` stays connected for as long as the caller holds the
 * original Request.
 */
export function forwardRequest(request: Request, options: { url?: string | URL; headers?: HeadersInit } = {}): Request {
  const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
  return new Request(options.url ?? request.url, {
    method: request.method,
    headers: options.headers ?? request.headers,
    signal: request.signal,
    redirect: request.redirect,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  } as RequestInit);
}
