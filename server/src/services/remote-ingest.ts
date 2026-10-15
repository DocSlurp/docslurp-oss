import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { canonicalIdForUrl } from "../lib/canonical-id.js";
import { assertSafeExternalUrl, safeExternalFetch } from "../lib/network-security.js";
import { inferMimeType } from "./documents.js";
import { WorkspaceIntakeError, type WorkspaceIntakeItem } from "./workspace-intake.js";

function parseKnownContentLength(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Workspace Intake adapter for remote URLs. Each URL is fetched lazily and
 * yielded as a streaming item; the response stays open until Workspace Intake
 * has validated and stored it, then it is cancelled. Each item's canonical ID
 * defaults to the URL, so re-ingesting a page supersedes its previous version.
 */
export async function* remoteUrlIntakeItems(
  urls: string[],
  options: { signal?: AbortSignal; canonicalIds?: Array<string | null | undefined> } = {},
): AsyncGenerator<WorkspaceIntakeItem> {
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
      throw new WorkspaceIntakeError(error instanceof Error ? error.message : "Invalid URL", 400);
    }

    try {
      if (!response.ok) {
        throw new WorkspaceIntakeError(`Failed to fetch ${url}: ${response.status}`, 400);
      }
      const filename = path.basename(new URL(safeUrl).pathname) || `remote-${randomUUID()}`;
      const mimeType = inferMimeType(url, response.headers.get("content-type"));
      const contentLength = parseKnownContentLength(response.headers.get("content-length"));

      yield {
        filename,
        mimeType,
        canonicalId: options.canonicalIds?.[index] ?? canonicalIdForUrl(safeUrl),
        metadata: { sourceUrl: safeUrl },
        content: response.body
          ? { stream: Readable.fromWeb(response.body as NodeReadableStream), contentLength }
          : { bytes: Buffer.from(await response.arrayBuffer()) },
      };
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
}
