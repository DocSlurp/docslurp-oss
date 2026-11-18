import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { opaqueCanonicalIdForUrl } from "../lib/canonical-id.js";
import { MIME_BY_EXTENSION, canonicalMimeType, bareMimeType } from "@docslurp/shared";
import { assertSafeExternalUrl, safeExternalFetch, UnsafeExternalUrlError } from "../lib/network-security.js";
import { inferMimeType } from "./documents.js";
import { ProjectIntakeError, type ProjectIntakeItem } from "./project-intake.js";

function parseKnownContentLength(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** At most this long, with an extension, and no run of 24+ base64 or hex characters (a grant, key or signature). */
const MAX_URL_FILENAME_CHARS = 100;
const OPAQUE_RUN = /[A-Za-z0-9+/=]{24,}|[0-9a-fA-F]{24,}/;

/** Whether a URL's last path segment reads as a filename rather than an opaque token. */
export function looksLikeUrlFilename(segment: string): boolean {
  return segment.length > 0 && segment.length <= MAX_URL_FILENAME_CHARS && /\.[A-Za-z0-9]{1,10}$/.test(segment) && !OPAQUE_RUN.test(segment);
}

/** The first extension whose canonical MIME type is `mimeType` (`.pdf`), or `.bin`. */
export function extensionForMimeType(mimeType: string): string {
  const canonical = canonicalMimeType(mimeType) ?? bareMimeType(mimeType);
  return Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === canonical)?.[0] ?? ".bin";
}

/**
 * The stored name of the file fetched from `url` (the `index`-th URL): its last
 * path segment when that looks like a filename, otherwise `<host>-<index><ext>`
 * with the extension of the sniffed type.
 */
export function urlDerivedFilename(url: URL, index: number, mimeType: string): string {
  let segment = path.basename(url.pathname);
  try { segment = decodeURIComponent(segment); } catch { /* keep the encoded form */ }
  return looksLikeUrlFilename(segment) ? segment : `${url.hostname}-${index}${extensionForMimeType(mimeType)}`;
}

/** How refusals name the URL at `index`: never the URL or its path, which can carry its access grant. */
function urlRef(index: number) {
  return { name: `urls[${index}]`, index };
}

/** Why a URL could not be fetched, as clients are told it: a fixed vocabulary. */
export type UrlFetchFailure = "blocked" | "timeout" | "dns" | "refused" | "tls" | "redirect" | "unreachable" | "http_status";

const URL_FETCH_FAILURE_MESSAGES: Record<Exclude<UrlFetchFailure, "blocked" | "http_status">, string> = {
  timeout: "The URL did not respond in time",
  dns: "The URL's host could not be resolved",
  refused: "The URL's server refused or dropped the connection",
  tls: "The URL's server failed the TLS handshake or certificate check",
  redirect: "The URL redirected; redirects are not followed",
  unreachable: "The URL could not be fetched",
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
export function classifyUrlFetchFailure(error: unknown): { failure: UrlFetchFailure; message: string; codes: string[] } {
  const chain = errorChain(error);
  const codes = chain.flatMap(({ name, code }) => [name, code]).filter(Boolean);
  // Our own URL policy refusals are fixed text ("Only https URLs are allowed", ...).
  if (error instanceof UnsafeExternalUrlError) {
    return { failure: "blocked", message: error.message, codes };
  }
  const has = (test: (entry: { name: string; code: string; message: string }) => boolean) => chain.some(test);
  const failure: Exclude<UrlFetchFailure, "blocked" | "http_status"> =
    has(({ name, code }) => name === "TimeoutError" || name === "AbortError" || /^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)) ? "timeout"
    : has(({ code, message }) => /^(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME|ENODATA)$/.test(code) || message === "Unable to resolve URL host") ? "dns"
    : has(({ code }) => /^(?:CERT_|ERR_SSL_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/.test(code)) ? "tls"
    : has(({ message }) => /\bredirect\b/i.test(message)) ? "redirect"
    : has(({ code, message }) => /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code) || message === "Unable to connect to URL host") ? "refused"
    : "unreachable";
  return { failure, message: URL_FETCH_FAILURE_MESSAGES[failure], codes };
}

function rejectedUrl(index: number, failure: UrlFetchFailure, message: string, codes: string[]): ProjectIntakeItem {
  // The class and the error names and codes only: no URL text, which can carry an access grant.
  console.warn(`[remote-ingest] url_fetch_failed ref=urls[${index}] failure=${failure} codes=${codes.join(",") || "none"}`);
  return { filename: `urls[${index}]`, refusalRef: urlRef(index), content: { rejected: new ProjectIntakeError(message, 400) } };
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
      const { failure, message, codes } = classifyUrlFetchFailure(error);
      yield rejectedUrl(index, failure, message, codes);
      continue;
    }

    try {
      if (!response.ok) {
        yield rejectedUrl(index, "http_status", `The URL's server answered HTTP ${response.status}`, [`HTTP_${response.status}`]);
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
