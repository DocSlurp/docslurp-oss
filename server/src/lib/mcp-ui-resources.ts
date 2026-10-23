import { createHash } from "node:crypto";

import type { ObjectStorageConfig } from "@docslurp/shared";

import { env } from "../config.js";
import { UPLOAD_HTML, UPLOAD_HTML_SHA256 } from "../mcp-ui/upload-bundle.generated.js";

/** MCP Apps (SEP-1865): the upload widget is a single self-contained HTML resource. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const UPLOADER_TOOL_ID = "openUploader";
/** The widget template's CSP `connect-src` placeholder, replaced with the storage origins at serve time. */
export const CONNECT_SRC_PLACEHOLDER = "__DOCSLURP_CONNECT_SRC__";

/**
 * The URI changes with the widget content, so hosts that cache ui:// templates
 * fetch the new widget after a deploy. Only the current URI is readable.
 */
export const uploadUiUriFor = (sha256: string) => `ui://docslurp/upload/${sha256.slice(0, 12)}`;
export const UPLOAD_UI_URI = uploadUiUriFor(UPLOAD_HTML_SHA256);

/** Nested `ui` is canonical; the flat key is the deprecated form older hosts still read. */
export const uploaderToolMeta = (uri: string = UPLOAD_UI_URI) => ({ ui: { resourceUri: uri }, "ui/resourceUri": uri });

let missingBundleLogged = false;

/** The generated widget template, or null when the generated module is empty (never built). */
export function loadUploadBundle(): string | null {
  if (UPLOAD_HTML) return UPLOAD_HTML;
  if (!missingBundleLogged && env.mcpAppsUiEnabled) {
    missingBundleLogged = true;
    console.error("[mcp-ui] upload widget bundle is empty; run `pnpm -C server build:mcp-ui`. The uploader is disabled.");
  }
  return null;
}

/** True when the uploader can be offered on any surface: the generated bundle exists. */
export const uploadBundleAvailable = () => loadUploadBundle() !== null;

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch { return null; }
}

const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[mcp-ui] ${message}`);
}

/**
 * Origins the sandbox may PUT to: storage signing hosts only, never the API or MCP origin and never "*".
 * Uses STORAGE_PUBLIC_ENDPOINT when set, since upload URLs are signed against it.
 * Path-style S3 signs against the endpoint; virtual-hosted signs against <bucket>.<host>.
 * Never throws: an unparseable storage endpoint is logged once and contributes no origin.
 */
export function uploadUiConnectDomains(
  storage: Pick<ObjectStorageConfig, "bucket" | "endpoint" | "region" | "forcePathStyle"> =
    env.storagePublicEndpoint ? { ...env.storage, endpoint: env.storagePublicEndpoint } : env.storage,
  extra: string = env.mcpUiConnectDomains,
): string[] {
  const origins: string[] = [];
  if (storage.endpoint) {
    let endpoint: URL | null = null;
    try { endpoint = new URL(storage.endpoint); }
    catch { warnOnce(`endpoint:${storage.endpoint}`, "storage endpoint is not a valid URL; the uploader cannot allow direct uploads to it"); }
    if (endpoint) {
      origins.push(endpoint.origin);
      if (!storage.forcePathStyle) origins.push(`${endpoint.protocol}//${storage.bucket}.${endpoint.host}`);
    }
  } else {
    const host = `s3.${storage.region}.amazonaws.com`;
    origins.push(`https://${host}`, `https://${storage.bucket}.${host}`);
  }
  for (const entry of extra.split(",")) {
    if (!entry.trim()) continue;
    const origin = httpOrigin(entry);
    if (origin) origins.push(origin);
    else warnOnce(`extra:${entry.trim()}`, `MCP_UI_CONNECT_DOMAINS entry ignored (needs an http(s) origin): ${JSON.stringify(entry.trim().slice(0, 80))}`);
  }
  return [...new Set(origins)];
}

export interface UploadUiOptions {
  /** HTML bundle source. Defaults to the built widget; tests inject a fake. */
  bundle?: () => string | null;
  connectDomains?: () => string[];
}

const uiMeta = (connectDomains: string[]) => ({ ui: { csp: { connectDomains }, prefersBorder: false } });

/** Fills the template's CSP placeholder. No storage origins means `'none'`: the widget can still render, not upload. */
export function renderUploadHtml(template: string, connectDomains: string[]): string {
  return template.split(CONNECT_SRC_PLACEHOLDER).join(connectDomains.length ? connectDomains.join(" ") : "'none'");
}

/** The resources/list entry and resources/read content for the widget, or null when no bundle is available. */
export function uploadUiResource(options: UploadUiOptions = {}) {
  const template = (options.bundle ?? loadUploadBundle)();
  if (!template) return null;
  const connectDomains = (options.connectDomains ?? uploadUiConnectDomains)();
  const html = renderUploadHtml(template, connectDomains);
  // Injected test bundles hash themselves; the real one uses the build-time hash of the authored template.
  const uri = uploadUiUriFor(options.bundle ? createHash("sha256").update(template).digest("hex") : UPLOAD_HTML_SHA256);
  const _meta = uiMeta(connectDomains);
  return {
    html, uri,
    listing: { uri, name: "upload-widget", title: "DocSlurp uploader", description: "Drop local files to upload them to a workspace.", mimeType: MCP_APP_MIME_TYPE, _meta },
    content: { uri, mimeType: MCP_APP_MIME_TYPE, text: html, _meta },
  };
}
