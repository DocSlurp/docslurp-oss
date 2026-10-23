import { readFileSync } from "node:fs";

import type { ObjectStorageConfig } from "@docslurp/shared";

import { env } from "../config.js";

/** MCP Apps (SEP-1865): the upload widget is a single self-contained HTML resource. */
export const UPLOAD_UI_URI = "ui://docslurp/upload";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const UPLOADER_TOOL_ID = "openUploader";

/** Nested `ui` is canonical; the flat key is the deprecated form older hosts still read. */
export const uploaderToolMeta = { ui: { resourceUri: UPLOAD_UI_URI }, "ui/resourceUri": UPLOAD_UI_URI };

let bundle: string | null | undefined;

/** Read once and cache. Null when the bundle is not built yet, so the uploader is simply not offered. */
export function loadUploadBundle(): string | null {
  if (bundle !== undefined) return bundle;
  try { bundle = readFileSync(new URL("../mcp-ui/upload.html", import.meta.url), "utf8"); }
  catch { bundle = null; }
  return bundle;
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch { return null; }
}

/**
 * Origins the sandbox may PUT to: storage signing hosts only, never the API or MCP origin and never "*".
 * Path-style S3 signs against the endpoint; virtual-hosted signs against <bucket>.<host>.
 */
export function uploadUiConnectDomains(
  storage: Pick<ObjectStorageConfig, "bucket" | "endpoint" | "region" | "forcePathStyle"> = env.storage,
  extra: string = env.mcpUiConnectDomains,
): string[] {
  const origins: string[] = [];
  const endpoint = storage.endpoint ? new URL(storage.endpoint) : null;
  if (endpoint) {
    origins.push(endpoint.origin);
    if (!storage.forcePathStyle) origins.push(`${endpoint.protocol}//${storage.bucket}.${endpoint.host}`);
  } else {
    const host = `s3.${storage.region}.amazonaws.com`;
    origins.push(`https://${host}`, `https://${storage.bucket}.${host}`);
  }
  for (const entry of extra.split(",")) { const origin = entry.trim() ? httpOrigin(entry) : null; if (origin) origins.push(origin); }
  return [...new Set(origins)];
}

export interface UploadUiOptions {
  /** HTML bundle source. Defaults to the built widget; tests inject a fake. */
  bundle?: () => string | null;
  connectDomains?: () => string[];
}

const uiMeta = (connectDomains: string[]) => ({ ui: { csp: { connectDomains }, prefersBorder: false } });

/** The resources/list entry and resources/read content for the widget, or null when no bundle is available. */
export function uploadUiResource(options: UploadUiOptions = {}) {
  const html = (options.bundle ?? loadUploadBundle)();
  if (!html) return null;
  const _meta = uiMeta((options.connectDomains ?? uploadUiConnectDomains)());
  return {
    html,
    listing: { uri: UPLOAD_UI_URI, name: "upload-widget", title: "DocSlurp uploader", description: "Drop local files to upload them to a workspace.", mimeType: MCP_APP_MIME_TYPE, _meta },
    content: { uri: UPLOAD_UI_URI, mimeType: MCP_APP_MIME_TYPE, text: html, _meta },
  };
}
