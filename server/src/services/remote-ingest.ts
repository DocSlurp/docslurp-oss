import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { opaqueCanonicalIdForUrl } from "../lib/canonical-id.js";
import { extensionForMimeType } from "../lib/url-document-identity.js";

export { extensionForMimeType };
import { assertSafeExternalUrl, safeExternalFetch, UnsafeExternalUrlError } from "../lib/network-security.js";
import { inferMimeType } from "./documents.js";
import { ProjectIntakeError, urlRefusalMessage, type ProjectIntakeItem, type UrlRefusal } from "./project-intake.js";

function parseKnownContentLength(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The stored name (and so the source key) of the file fetched from `url`, the
 * `index`-th URL: always `<host>-<index><ext>`, the extension from the sniffed
 * type. Never any part of the path or query: no heuristic can tell a filename
 * from an access grant that looks like one.
 */
export function urlDerivedFilename(url: URL, index: number, mimeType: string): string {
  return `${url.hostname}-${index}${extensionForMimeType(mimeType)}`;
}

/** How refusals name the URL at `index`: never the URL or its path, which can carry its access grant. */
function urlRef(index: number) {
  return { name: `urls[${index}]`, index };
}

/** Why a URL could not be fetched, as a class for logs and tests. */
export type UrlFetchFailure = "blocked" | "timeout" | "dns" | "refused" | "tls" | "redirect" | "unreachable" | "http_status";

/** Our URL policy's fixed refusal texts, as approved structured reasons. */
const POLICY_REFUSALS: Record<string, UrlRefusal> = {
  "Invalid URL": { reason: "blocked_invalid" },
  "Only https URLs are allowed": { reason: "blocked_scheme" },
  "URLs with embedded credentials are not allowed": { reason: "blocked_credentials" },
  "Custom URL ports are not allowed": { reason: "blocked_port" },
  "Private or loopback IP addresses are not allowed": { reason: "blocked_private_address" },
  "URL resolves to a private or loopback address": { reason: "blocked_private_address" },
  "Unable to resolve URL host": { reason: "dns" },
};

/** The error and its causes (undici wraps network failures as `TypeError: fetch failed` with the reason in `cause`). */
function errorChain(error: unknown): Array<{ name: string; code: string; message: string }> {
  const chain: Array<{ name: string; code: string; message: string }> = [];
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    const record = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    chain.push({ name: String(record.name ?? ""), code: String(record.code ?? ""), message: String(record.message ?? "") });
    current = record.cause;
  }
  return chain;
}

/**
 * Classifies a fetch failure from error names and `cause.code`, never from URL
 * text. The class and its fixed copy go to the client; the codes go to the logs.
 */
export function classifyUrlFetchFailure(error: unknown): { failure: UrlFetchFailure; refusal: UrlRefusal; message: string; codes: string[] } {
  const chain = errorChain(error);
  const codes = chain.flatMap(({ name, code }) => [name, code]).filter(Boolean);
  // Our own URL policy refusals map to approved reasons by their fixed text; anything else is "blocked".
  if (error instanceof UnsafeExternalUrlError) {
    const refusal = POLICY_REFUSALS[error.message] ?? { reason: "blocked" };
    return { failure: "blocked", refusal, message: urlRefusalMessage(refusal), codes };
  }
  const has = (test: (entry: { name: string; code: string; message: string }) => boolean) => chain.some(test);
  const failure: Exclude<UrlFetchFailure, "blocked" | "http_status"> =
    has(({ name, code }) => name === "TimeoutError" || name === "AbortError" || /^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)) ? "timeout"
    : has(({ code, message }) => /^(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME|ENODATA)$/.test(code) || message === "Unable to resolve URL host") ? "dns"
    : has(({ code }) => /^(?:CERT_|ERR_SSL_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/.test(code)) ? "tls"
    : has(({ message }) => /\bredirect\b/i.test(message)) ? "redirect"
    : has(({ code, message }) => /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code) || message === "Unable to connect to URL host") ? "refused"
    : "unreachable";
  const refusal: UrlRefusal = { reason: failure };
  return { failure, refusal, message: urlRefusalMessage(refusal), codes };
}

function rejectedUrl(index: number, failure: UrlFetchFailure, refusal: UrlRefusal, codes: string[]): ProjectIntakeItem {
  // The class and the error names and codes only: no URL text, which can carry an access grant.
  console.warn(`[remote-ingest] url_fetch_failed ref=urls[${index}] failure=${failure} codes=${codes.join(",") || "none"}`);
  return {
    filename: `urls[${index}]`,
    refusalRef: urlRef(index),
    content: { rejected: new ProjectIntakeError(urlRefusalMessage(refusal), 400), urlRefusal: refusal },
  };
}

/**
 * Project Intake adapter for remote URLs. Each URL is fetched lazily and
 * yielded as a streaming item; the response stays open until Project Intake
 * has validated and stored it, then it is cancelled. Each item's canonical ID
 * defaults to an opaque ID derived from the URL (`url:<sha256>`), so
 * re-ingesting a page supersedes its previous version without a signed URL's
 * query ever being returned as a canonical ID.
 * A URL that cannot be fetched is yielded as a rejected item, so the other
 * URLs are still ingested.
 */
export async function* remoteUrlIntakeItems(
  urls: string[],
  options: { signal?: AbortSignal; canonicalIds?: Array<string | null | undefined> } = {},
): AsyncGenerator<ProjectIntakeItem> {
  for (const [index, url] of urls.entries()) {
    let response: Response;
    let safeUrl: string;
    try {
      safeUrl = await assertSafeExternalUrl(url);
      response = await safeExternalFetch(safeUrl, {
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const { failure, refusal, codes } = classifyUrlFetchFailure(error);
      yield rejectedUrl(index, failure, refusal, codes);
      continue;
    }

    try {
      if (!response.ok) {
        yield rejectedUrl(index, "http_status", { reason: "http_status", httpStatus: response.status }, [`HTTP_${response.status}`]);
        continue;
      }
      const mimeType = inferMimeType(url, response.headers.get("content-type"));
      // The stored filename (and the source key built from it) is the URL's last path
      // segment only when it looks like a filename; a grant-like segment never is.
      const filename = urlDerivedFilename(new URL(safeUrl), index, mimeType);
      // Fetch decodes compressed responses but retains their wire headers. The
      // encoded length is not the length of the stream we send to object storage.
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      const contentLength = encoding && encoding !== "identity"
        ? undefined
        : parseKnownContentLength(response.headers.get("content-length"));

      yield {
        filename,
        mimeType,
        canonicalId: options.canonicalIds?.[index] ?? opaqueCanonicalIdForUrl(safeUrl),
        metadata: { sourceUrl: safeUrl },
        // Screening, storage and unreadable refusals name it urls[i], never its path segment.
        refusalRef: urlRef(index),
        content: response.body
          ? { stream: Readable.fromWeb(response.body as NodeReadableStream), contentLength }
          : { bytes: Buffer.from(await response.arrayBuffer()) },
      };
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
}
