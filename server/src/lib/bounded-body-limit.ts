import type { Context, MiddlewareHandler } from "hono";

/** Count actual bytes before downstream readers, irrespective of Content-Length. */
export function boundedBodyLimit(maxSize: number, onError: (c: Context) => Response): MiddlewareHandler {
  return async (c, next) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxSize) return onError(c);
    const request = c.req.raw;
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxSize) {
            void reader.cancel().catch(() => {});
            return onError(c);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      c.req.raw = new Request(request, { body });
    }
    await next();
  };
}
