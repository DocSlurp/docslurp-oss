import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { canonicalIdForUrl } from "../lib/canonical-id.js";
import { assertSafeExternalUrl, safeExternalFetch, UnsafeExternalUrlError } from "../lib/network-security.js";
import { inferMimeType } from "./documents.js";
import { ProjectIntakeError, type ProjectIntakeItem } from "./project-intake.js";

function parseKnownContentLength(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** How refusals name the URL at `index`: never the URL or its path, which can carry its access grant. */
function urlRef(index: number) {
  return { name: `urls[${index}]`, index };
}

/** Why a URL could not be fetched, as clients are told it: a fixed vocabulary. */
export type UrlFetchFailure = "blocked" | "timeout" | "unreachable" | "http_status";

/** Classifies a fetch failure; the raw cause goes to the logs, never to the client. */
export function classifyUrlFetchFailure(error: unknown): { failure: UrlFetchFailure; message: string } {
  // Our own URL policy messages are fixed text ("Only https URLs are allowed", ...).
  if (error instanceof UnsafeExternalUrlError) return { failure: "blocked", message: error.message };
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return { failure: "timeout", message: "The URL did not respond in time" };
  return { failure: "unreachable", message: "The URL could not be fetched" };
}

function rejectedUrl(index: number, failure: UrlFetchFailure, message: string, cause: unknown): ProjectIntakeItem {
  const raw = cause instanceof Error ? `${cause.name}: ${cause.message}${cause.cause instanceof Error ? ` (cause: ${cause.cause.message})` : ""}` : String(cause);
  console.warn(`[remote-ingest] url_fetch_failed ref=urls[${index}] failure=${failure} cause=${JSON.stringify(raw)}`);
  return { filename: `urls[${index}]`, refusalRef: urlRef(index), content: { rejected: new ProjectIntakeError(message, 400) } };
}

/**
 * Project Intake adapter for remote URLs. Each URL is fetched lazily and
 * yielded as a streaming item; the response stays open until Project Intake
 * has validated and stored it, then it is cancelled. Each item's canonical ID
 * defaults to the URL, so re-ingesting a page supersedes its previous version.
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
      const { failure, message } = classifyUrlFetchFailure(error);
      yield rejectedUrl(index, failure, message, error);
      continue;
    }

    try {
      if (!response.ok) {
        yield rejectedUrl(index, "http_status", `The URL's server answered HTTP ${response.status}`, `HTTP ${response.status} ${response.statusText}`);
        continue;
      }
      const filename = path.basename(new URL(safeUrl).pathname) || `remote-${randomUUID()}`;
      const mimeType = inferMimeType(url, response.headers.get("content-type"));
      // Fetch decodes compressed responses but retains their wire headers. The
      // encoded length is not the length of the stream we send to object storage.
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      const contentLength = encoding && encoding !== "identity"
        ? undefined
        : parseKnownContentLength(response.headers.get("content-length"));

      yield {
        filename,
        mimeType,
        canonicalId: options.canonicalIds?.[index] ?? canonicalIdForUrl(safeUrl),
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
