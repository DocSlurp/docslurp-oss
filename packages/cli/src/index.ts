#!/usr/bin/env node

import { safeHttpFailure, retryAfterSeconds } from "./http-failure.js";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { openAsBlob } from "node:fs";
import { createInterface } from "node:readline";

import { authTokenCommand, execCommand, loginCommand, logoutCommand, whoamiCommand } from "./auth/commands.js";
import { resolveAuth, type ResolvedAuth } from "./auth/resolve.js";

const DEFAULT_API_URL = "https://docslurp.io";
/** Labels CLI requests for DocSlurp usage analytics; it grants nothing. */
const cliClientTag = "cli";

function resolveApiUrl(flags: Record<string, string | boolean>): string {
  const value = String(flags.apiUrl ?? (process.env.DOCSLURP_URL?.trim() || DEFAULT_API_URL)).replace(/\/+$/, "");
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("API URL requires HTTPS; HTTP is allowed only on localhost for development.");
  return value;
}

/**
 * --project, then DOCSLURP_PROJECT, then "default" (the organization's
 * default project). A project is an ID, slug or name; names match by slug.
 */
function resolveProject(flags: Record<string, string | boolean>): string {
  if (process.env.DOCSLURP_WORKSPACE?.trim() || process.env.DOCSLURP_WORKSPACE_ID?.trim()) throw new Error("Legacy workspace environment selection is no longer supported; set DOCSLURP_PROJECT.");
  const explicit = typeof flags.project === "string" ? flags.project.trim() : "";
  return explicit || process.env.DOCSLURP_PROJECT?.trim() || "default";
}

type IntakeTarget = { newProject: boolean; templateKey?: string; project?: string };

/**
 * Where an upload or URL ingest lands. --project wins: the server finds the
 * project by ID, slug or name, or creates it from the name (with --template
 * applied). Otherwise --new-project or --template creates a self-titled
 * project, and anything else goes to DOCSLURP_PROJECT or "default".
 */
function resolveIntakeTarget(flags: Record<string, string | boolean>): IntakeTarget {
  const templateKey = typeof flags.template === "string" && flags.template.trim() ? flags.template.trim() : undefined;
  const explicit = typeof flags.project === "string" ? flags.project.trim() : "";
  if (explicit) return { newProject: false, project: explicit, templateKey };
  if (flags.newProject === true || templateKey) return { newProject: true, templateKey };
  return { newProject: false, project: resolveProject(flags) };
}

const QUALITY_MODES = ["fast", "auto", "good"] as const;

/** `--quality fast|auto|good` as a pipeline override, or {} when the project setting applies. */
export function resolveQualityPipeline(flags: Record<string, string | boolean>): { pipeline?: { quality: (typeof QUALITY_MODES)[number] } } {
  if (flags.quality === undefined) return {};
  const quality = typeof flags.quality === "string" ? flags.quality.trim().toLowerCase() : "";
  if (!(QUALITY_MODES as readonly string[]).includes(quality)) throw new Error("--quality must be fast, auto or good.");
  return { pipeline: { quality: quality as (typeof QUALITY_MODES)[number] } };
}

function usage(): void {
  console.log(`Usage:
  docslurp estimate <files...> [--quality <fast|auto|good>] [--indexing <full|on-demand|visual>] [--months <n>] [--json]
  docslurp upload <files...> [--project <id|slug|name> | --new-project] [--template <key>] [--quality <fast|auto|good>] [--canonical-id <id>] [--path <folder>] [--idempotency-key <key>] [--estimate] [--watch] [--api-url <url>]
  docslurp ingest-url <urls...> [--project <id|slug|name> | --new-project] [--template <key>] [--quality <fast|auto|good>] [--watch] [--api-url <url>]
  docslurp extract <files...|urls...> [--retention-days <n>] [--no-email] [--download <markdown|all>] [upload options]
  docslurp extract-status <extractId> [--json]
  docslurp extract-download <extractId>
  docslurp full-index [--project <id|slug|name>] [--document <id>] [--estimate] [--watch]
  docslurp reprocess <runId> [--stage-from <stage>] [--estimate] [--watch]
  docslurp jobs get <jobId> [--json]
  docslurp jobs watch <jobId> [--timeout <seconds>]
  docslurp status <runId> [--api-url <url>] [--watch] [--timeout <seconds>]
  docslurp runs [--limit <1-100>] [--cursor <nextCursor>] [--api-url <url>]
  docslurp search <query> [--project <id|slug|name>] [--min-score <0..1>] [--json | --context]
  docslurp search --queries-file <queries.json> [--project <id|slug|name>] [--concurrency <1..4>] [--json | --context]
  docslurp chat <question> [--project <id|slug|name>] [--session <id>] [--json]
  docslurp mcp-server [--api-url <url>] [--api-key <key>]   (alias: docslurp mcp)
  docslurp login [--device] [--scopes "search read chat ingest"] [--no-browser] [--profile <name>] [--api-url <url>]
  docslurp logout [--profile <name>] [--force]
  docslurp whoami [--json]
  docslurp auth status [--json]
  docslurp auth token
  docslurp exec [--profile <name>] [--project <ws>] -- <command> [args...]
  docslurp --license
  docslurp migrate-algolia-synonyms <export.json> [--out <glossary.json>]
  docslurp import-search-compat <export.json> --project <id|slug|name> [--source <algolia|elastic|legacy-parser>] [--api-url <url>] [--api-key <key>] [--out <normalized.json>]

API commands authenticate with, in order: --api-key <key>, DOCSLURP_API_KEY,
DOCSLURP_TOKEN (a short-lived OAuth access token), then the stored login from
docslurp login (refreshed automatically). docslurp login asks for search and read;
add chat or ingest with --scopes. Use --device on headless or SSH machines.
docslurp auth token prints a fresh access token (valid at most 15 minutes);
docslurp exec passes one to a child process as DOCSLURP_TOKEN without writing it to disk.
--profile (or DOCSLURP_PROFILE) keeps separate logins; each profile has one per API URL.
DOCSLURP_URL overrides the hosted service. Without --project or DOCSLURP_PROJECT,
commands use the "default" project: your organization's default project.
--project takes a project ID, slug or name: "Legal Contracts" and legal-contracts are
the same project. Uploads and URL ingests into a name that matches no project create
it with that name (and --template, if given); other commands answer project not found.
--new-project (or --template alone) uploads into a fresh self-titled project.
--quality sets processing quality for the upload (default: the project's, auto unless changed):
fast reads the text layer only and keeps scanned pages as images, not read (lowest price);
auto reads each page the cheapest faithful way (its price depends on the mix of pages);
good reads every page with a vision model (highest price). Prices: https://docslurp.io/pricing
--estimate prints the work estimate (pages, documents, credits, time) for the operation and exits without doing it.
Mutations that queue background work print their job; follow it with docslurp jobs watch <jobId>.
--watch waits up to five minutes by default; --timeout sets its limit.
extract works like upload (files) or ingest-url (URLs), but the files and every output are
deleted when the retention window ends: 48 hours free by default, --retention-days for longer
(charged as storage). It emails a sign-in download link when done unless --no-email is set;
extract-download prints a two-minute signed URL for the results zip.

Copyright 2025-2026 DocSlurp, Inc. and contributors. No warranty.
You may redistribute this CLI under SSPL-1.0; an Apache-2.0 grant applies
after three years for each version. Run docslurp --license for the terms.
Source: https://github.com/DocSlurp/docslurp-oss/tree/main/packages/cli`);
}

async function migrateAlgoliaSynonymsCommand(inputPath: string, outPath: string): Promise<void> {
  const raw = await readFile(inputPath, "utf8");
  const data = JSON.parse(raw) as Array<Record<string, any>>;
  const glossary: Record<string, string[]> = {};

  for (const item of data) {
    const type = String(item.type ?? "");
    if (type === "synonym" && Array.isArray(item.synonyms)) {
      const terms = (item.synonyms as string[]).map((s) => String(s).trim()).filter(Boolean);
      for (const t of terms) {
        const others = terms.filter((x) => x !== t);
        glossary[t] = Array.from(new Set([...(glossary[t] ?? []), ...others]));
      }
    } else if (type === "oneWaySynonym" && typeof item.input === "string" && Array.isArray(item.synonyms)) {
      const input = String(item.input).trim();
      const syns = (item.synonyms as string[]).map((s) => String(s).trim()).filter(Boolean);
      glossary[input] = Array.from(new Set([...(glossary[input] ?? []), ...syns]));
    }
  }

  const output = JSON.stringify(glossary, null, 2);
  if (outPath) {
    await writeFile(outPath, output, "utf8");
    console.log(`Wrote glossary to ${outPath}`);
  } else {
    console.log(output);
  }
}

async function importSearchCompatCommand(inputPath: string, flags: Record<string, string | boolean>): Promise<void> {
  const raw = await readFile(inputPath, "utf8");
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const project = resolveProject(flags);
  if (!project) {
    throw new Error("--project is required");
  }

  const source = String(flags.source ?? detectCompatSource(payload));
  const normalized = normalizeCompatImportPayload({
    source,
    project,
    payload
  });

  if (typeof flags.out === "string" && flags.out) {
    await writeFile(String(flags.out), JSON.stringify(normalized, null, 2), "utf8");
    console.log(`Wrote normalized import payload to ${String(flags.out)}`);
  }

  const apiUrl = resolveApiUrl(flags);
  const auth = await resolveAuth(flags, apiUrl, { allowEmpty: true });
  if (!auth) {
    console.log(JSON.stringify(normalized, null, 2));
    console.log("Skipped API import because no credential was provided (--api-key, DOCSLURP_API_KEY, DOCSLURP_TOKEN or docslurp login).");
    return;
  }

  const response = await fetch(`${apiUrl}/compat/algolia/1/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await auth.token()}`,
      "X-DocSlurp-Client": cliClientTag,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(normalized)
  });

  if (!response.ok) {
    throw await responseFailure(response);
  }

  const result = await response.json() as { imported: Record<string, number> };
  console.log(`Imported ${source} compatibility payload into project ${project}.`);
  console.log(JSON.stringify(result.imported, null, 2));
}

function detectCompatSource(payload: Record<string, unknown>): "algolia" | "elastic" | "legacy-parser" {
  if (payload.mappings || payload.aliases) {
    return "elastic";
  }
  if (payload.synonyms || payload.rules || payload.settings) {
    return "algolia";
  }
  return "legacy-parser";
}

function normalizeCompatImportPayload(args: {
  source: string;
  project: string;
  payload: Record<string, unknown>;
}) {
  if (args.source === "elastic") {
    const mappings = (args.payload.mappings ?? {}) as Record<string, unknown>;
    const properties = ((mappings.properties ?? {}) as Record<string, unknown>);
    const searchableAttributes = Object.entries(properties)
      .filter(([, value]) => {
        const type = typeof value === "object" && value ? (value as Record<string, unknown>).type : undefined;
        return type === "text" || type === "keyword";
      })
      .map(([key]) => key);

    return {
      source: "elastic",
      project: args.project,
      settings: {
        searchableAttributes,
        attributesForFaceting: Object.keys(properties)
          .filter((key) => {
            const value = properties[key];
            const type = typeof value === "object" && value ? (value as Record<string, unknown>).type : undefined;
            return type === "keyword";
          })
          .map((key) => `filterOnly(${key})`)
      },
      synonyms: args.payload.synonyms ?? {},
      rules: args.payload.rules ?? [],
      schema: mappings,
      metadata: {
        aliases: args.payload.aliases ?? {},
        settings: args.payload.settings ?? {}
      }
    };
  }

  if (args.source === "legacy-parser") {
    return {
      source: "legacy-parser",
      project: args.project,
      settings: args.payload.settings ?? {},
      synonyms: args.payload.synonyms ?? {},
      rules: args.payload.rules ?? [],
      schema: args.payload.schema ?? {},
      metadata: args.payload.metadata ?? {}
    };
  }

  return {
    source: "algolia",
    project: args.project,
    indexName: typeof args.payload.indexName === "string" ? args.payload.indexName : undefined,
    settings: args.payload.settings ?? {},
    synonyms: args.payload.synonyms ?? [],
    rules: args.payload.rules ?? [],
    schema: args.payload.schema ?? {},
    metadata: args.payload.metadata ?? {}
  };
}

function parseCliArgs(argv: string[]) {
  const command = argv[0];
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (/^--(?:workspace(?:-id|-name)?|new-workspace)(?:=|$)/.test(arg ?? "")) throw new Error("Legacy workspace flags are no longer supported; use --project or --new-project.");
    if (arg === "--watch" || arg === "--json" || arg === "--context" || arg === "--estimate" || arg === "--device" || arg === "--force") {
      flags[arg.slice(2)] = true;
      i++;
    } else if (arg === "--no-browser") {
      flags.noBrowser = true;
      i++;
    } else if (arg === "--no-email") {
      flags.noEmail = true;
      i++;
    } else if (arg === "--new-project") {
      flags.newProject = true;
      i++;
    } else if (arg === "--project-name" || arg === "--project-id") {
      throw new Error(`${arg} was removed: pass a project ID, slug or name with --project (a name that matches no project is created on upload).`);
    } else if (arg === "--project" || arg === "--api-url" || arg === "--run" || arg === "--api-key" || arg === "--source" || arg === "--out" || arg === "--queries-file" || arg === "--concurrency" || arg === "--min-score" || arg === "--session" || arg === "--canonical-id" || arg === "--path" || arg === "--template" || arg === "--document" || arg === "--stage-from" || arg === "--retention-days" || arg === "--download" || arg === "--quality" || arg === "--idempotency-key") {
      const key = arg.replace(/^--/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      flags[key] = argv[i + 1] ?? "";
      i += 2;
    } else if (arg?.startsWith("--")) {
      flags[arg.replace(/^--/, "")] = argv[i + 1] ?? "";
      i += 2;
    } else {
      positional.push(arg ?? "");
      i++;
    }
  }

  return { command, positional, flags };
}


async function apiFetch(
  pathname: string,
  flags: Record<string, string | boolean>,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  const requestTimeoutMs = timeoutMs ?? Number(flags.timeout ?? 30) * 1000;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("--timeout must be a positive number of seconds.");
  const apiUrl = resolveApiUrl(flags);
  const auth = await requestAuth(flags, apiUrl);
  const send = async (forceRefresh: boolean) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await auth.token({ forceRefresh })}`);
    headers.set("X-DocSlurp-Client", cliClientTag);
    return fetch(`${apiUrl}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(Math.max(1, Math.ceil(requestTimeoutMs))) });
  };
  const response = await send(false);
  // A stored login refreshes once if the server refused its access token (for example after a clock skew).
  if (response.status !== 401 || auth.source !== "stored login" || init.body instanceof ReadableStream) return response;
  await response.body?.cancel();
  return send(true);
}

let cachedAuth: Promise<ResolvedAuth> | null = null;
/** One credential resolution per process (see auth/resolve.ts for precedence). */
function requestAuth(flags: Record<string, string | boolean>, apiUrl: string): Promise<ResolvedAuth> {
  cachedAuth ??= resolveAuth(flags, apiUrl) as Promise<ResolvedAuth>;
  return cachedAuth;
}

/** Same threshold as the SDK's DIRECT_UPLOAD_THRESHOLD_BYTES. */
const DIRECT_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;

/**
 * The type the file declares. The CLI keeps no format table of its own: the server resolves a missing or generic type from the file's
 * extension and sniffs the bytes, so there is one list of formats (packages/shared/src/file-formats.ts).
 */
function declaredMimeType(blob: Blob): string {
  return blob.type || "application/octet-stream";
}

type DirectUploadDescriptor = {
  id: string; filename: string; mimeType: string; sizeBytes: number; mode: "single" | "multipart";
  /** Position in the create request and the client id sent with it: how a file is matched, never by (sanitized) filename. */
  index?: number | null; clientId?: string | null; status?: string;
  putUrl?: string; partSize?: number; pendingParts?: Array<{ partNumber: number; sizeBytes: number; url: string }>;
  completedParts?: Array<{ partNumber: number; etag: string }>;
};
type UploadRejection = { index?: number; clientId?: string; filename: string; statusCode: number; code: string; message: string };
type DirectSession = { sessionId: string; status?: string; files: DirectUploadDescriptor[]; rejected?: UploadRejection[]; result?: unknown };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A timeout or a dropped connection: the request may or may not have reached the server. */
function isLostResponse(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** The server's coded 409 for a request whose Idempotency-Key is still being processed. */
async function isInFlightConflict(response: Response): Promise<boolean> {
  try {
    const body = await response.clone().json() as { code?: unknown; error?: { code?: unknown } | unknown };
    const code = (body.error && typeof body.error === "object" ? (body.error as { code?: unknown }).code : undefined) ?? body.code;
    return code === "idempotency_in_flight";
  } catch {
    return false;
  }
}

/**
 * Sends a request that is safe to repeat (it carries an Idempotency-Key, or is a read): a lost response or a transient status is retried
 * with backoff, so a timeout never makes a second session or a second charge.
 */
async function apiFetchRepeatable(pathname: string, flags: Record<string, string | boolean>, init: RequestInit, timeoutMs?: number): Promise<Response> {
  // A coded 409 means the first request with this Idempotency-Key is still being processed: its session is the one wanted, so wait
  // and send the same key again until the request timeout rather than failing and orphaning it.
  const waitLimitMs = Number.isFinite(Number(flags.timeout ?? 30)) && Number(flags.timeout ?? 30) > 0 ? Number(flags.timeout ?? 30) * 1000 : 30_000;
  const giveUpAt = Date.now() + waitLimitMs;
  let inFlight = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await apiFetch(pathname, flags, init, timeoutMs);
      if (response.status === 409 && await isInFlightConflict(response)) {
        const wait = Math.min(2_000, 250 * 2 ** inFlight++);
        if (Date.now() + wait < giveUpAt) {
          await response.body?.cancel();
          await sleepMs(wait);
          attempt--;
          continue;
        }
      }
      if (attempt >= 3 || !RETRYABLE_STATUSES.has(response.status)) return response;
      const wait = Math.min(10, retryAfterSeconds(response.headers.get("retry-after")) ?? 0.25 * 2 ** attempt);
      await response.body?.cancel();
      await sleepMs(wait * 1000);
    } catch (error) {
      if (attempt >= 3 || !isLostResponse(error)) throw error;
      await sleepMs(250 * 2 ** attempt);
    }
  }
}

/** Milliseconds a request carrying `bytes` may take: the request timeout plus time to send the body at a floor rate of 100 KB/s. */
function bodyTimeoutMs(flags: Record<string, string | boolean>, bytes: number): number {
  const base = Number(flags.timeout ?? 30) * 1000;
  return (Number.isFinite(base) && base > 0 ? base : 30_000) + (bytes / 100_000) * 1000;
}

async function putToStorage(url: string, body: Blob, contentType?: string): Promise<string | null> {
  // Presigned URL: never send the API key to storage. A part is retried with backoff before the caller resumes from the server's view.
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: "PUT", body, headers: contentType ? { "Content-Type": contentType } : undefined,
        signal: AbortSignal.timeout(Math.ceil(Math.max(60_000, 30_000 + (body.size / 100_000) * 1000))),
      });
      if (response.ok) return response.headers.get("etag");
      if (attempt >= 2 || !RETRYABLE_STATUSES.has(response.status)) throw await responseFailure(response);
      await response.body?.cancel();
    } catch (error) {
      if (attempt >= 2 || !isLostResponse(error)) throw error;
    }
    await sleepMs(250 * 2 ** attempt);
  }
}

/** Sends one file (or its remaining parts). Returns the completion body for `files/complete`. */
async function sendFile(descriptor: DirectUploadDescriptor, blob: Blob): Promise<Record<string, unknown>> {
  if (descriptor.mode === "single") {
    const etag = await putToStorage(descriptor.putUrl ?? "", blob, descriptor.mimeType);
    return { fileId: descriptor.id, ...(etag ? { etag } : {}) };
  }
  const parts: Array<{ partNumber: number; etag: string }> = [...(descriptor.completedParts ?? [])];
  for (const part of descriptor.pendingParts ?? []) {
    const start = (part.partNumber - 1) * (descriptor.partSize ?? part.sizeBytes);
    const etag = await putToStorage(part.url, blob.slice(start, start + part.sizeBytes));
    if (!etag) throw new Error(`Storage returned no ETag for ${descriptor.filename} part ${part.partNumber}`);
    parts.push({ partNumber: part.partNumber, etag });
    console.error(`Uploaded ${descriptor.filename} part ${part.partNumber}/${(descriptor.pendingParts ?? []).length}`);
  }
  return { fileId: descriptor.id, parts: parts.sort((a, b) => a.partNumber - b.partNumber) };
}

/** The local file a descriptor belongs to: by request index, then client id; by name and size only for an older server. */
function localFileFor(descriptor: DirectUploadDescriptor, files: Array<{ blob: Blob; name: string }>, claimed: Set<number>): { file: { blob: Blob; name: string }; index: number } | undefined {
  const byIndex = typeof descriptor.index === "number" ? descriptor.index
    : descriptor.clientId != null && /^\d+$/.test(descriptor.clientId) ? Number(descriptor.clientId) : -1;
  const index = byIndex >= 0 ? byIndex : files.findIndex((file, at) => !claimed.has(at) && file.name === descriptor.filename && file.blob.size === descriptor.sizeBytes);
  const file = files[index];
  if (!file || claimed.has(index)) return undefined;
  claimed.add(index);
  return { file, index };
}

/** After a lost confirm response, the session says whether intake already finished: poll it rather than confirming again. */
async function pollConfirmedSession(sessionPath: string, flags: Record<string, string | boolean>): Promise<Response | null> {
  const stopAt = Date.now() + Math.max(60_000, Number(flags.timeout ?? 30) * 1000);
  while (Date.now() < stopAt) {
    try {
      const response = await apiFetch(`${sessionPath}?statusOnly=true`, flags);
      if (response.ok) {
        const session = await response.json() as { status?: string; result?: unknown };
        if (session.result) return new Response(JSON.stringify(session.result), { status: 201, headers: { "content-type": "application/json" } });
        if (session.status && ["failed", "aborted", "expired"].includes(session.status)) return null;
      }
    } catch (error) {
      if (!isLostResponse(error)) throw error;
    }
    await sleepMs(1000);
  }
  return null;
}

/** Create a direct upload session, PUT each file (or its parts), complete, then confirm. Returns the confirm response. */
async function uploadDirect(files: Array<{ blob: Blob; name: string }>, fields: FormData, flags: Record<string, string | boolean>, intake: IntakeMode = UPLOAD_MODE): Promise<Response> {
  const field = (name: string) => (typeof fields.get(name) === "string" ? String(fields.get(name)) : undefined);
  const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  // One key per upload: a create that timed out is sent again with it and returns the same session, never a second one.
  const idempotencyKey = typeof flags.idempotencyKey === "string" && flags.idempotencyKey ? flags.idempotencyKey : randomUUID();
  // Extract sessions are created under /v1/extracts and continue on the shared upload session routes.
  const created = await apiFetchRepeatable(`${intake.base}/direct/sessions`, flags, json({
    ...intake.fields,
    ...(field("project") ? { project: field("project") } : {}),
    ...(field("newProject") === "true" ? { newProject: true } : {}),
    ...(field("templateKey") ? { templateKey: field("templateKey") } : {}),
    ...(field("pipeline") ? { pipeline: JSON.parse(field("pipeline")!) } : {}),
    files: files.map(({ blob, name }, index) => ({
      clientId: String(index),
      filename: name, mimeType: declaredMimeType(blob), sizeBytes: blob.size,
      ...(field("canonicalId") ? { canonicalId: field("canonicalId") } : {}),
      ...(typeof flags.path === "string" && flags.path ? { path: flags.path } : {}),
    })),
  }, { "Idempotency-Key": idempotencyKey }));
  if (!created.ok) return created;
  const session = await created.json() as DirectSession;
  const sessionPath = `/v1/uploads/direct/sessions/${encodeURIComponent(session.sessionId)}`;
  // Files the server left out while taking the rest, under the names the user typed.
  const rejected = (session.rejected ?? []).map((rejection) => ({
    ...rejection,
    filename: typeof rejection.index === "number" ? files[rejection.index]?.name ?? rejection.filename : rejection.filename,
  }));
  try {
    const claimed = new Set<number>();
    for (const first of session.files) {
      const match = localFileFor(first, files, claimed);
      if (!match) throw new Error(`Upload session returned a file this upload did not send: ${first.filename}`);
      let descriptor = first;
      let complete: Record<string, unknown> | null = null;
      for (let round = 0; complete === null; round++) {
        try {
          complete = await sendFile(descriptor, match.file.blob);
        } catch (error) {
          if (round >= 2 || !(isLostResponse(error) || (error instanceof CliApiError && (error.status === 403 || RETRYABLE_STATUSES.has(error.status))))) throw error;
          // Resume from what storage holds: the session lists the parts still missing, with fresh signed URLs.
          await sleepMs(250 * 2 ** round);
          const refreshed = await apiFetchRepeatable(sessionPath, flags, {});
          if (!refreshed.ok) throw error;
          const next = ((await refreshed.json()) as DirectSession).files.find((file) => file.id === descriptor.id);
          if (!next) throw error;
          if (next.status === "completed") { complete = { fileId: descriptor.id }; break; }
          descriptor = next;
        }
      }
      const done = await apiFetchRepeatable(`${sessionPath}/files/complete`, flags, json(complete));
      if (!done.ok) throw await responseFailure(done);
    }
    let confirmed: Response | null;
    try {
      confirmed = await apiFetch(`${sessionPath}/confirm`, flags, { method: "POST" });
    } catch (error) {
      if (!isLostResponse(error)) throw error;
      confirmed = await pollConfirmedSession(sessionPath, flags);
      if (!confirmed) throw error;
    }
    if (!confirmed.ok || rejected.length === 0) return confirmed;
    const result = await confirmed.json() as Record<string, unknown>;
    const warning = `${rejected.length} of ${files.length} files were not uploaded: ${rejected.map((file) => `${file.filename} (${file.message})`).join("; ")}`;
    return new Response(JSON.stringify({
      ...result,
      rejected: [...rejected, ...((result.rejected as UploadRejection[] | undefined) ?? [])],
      warnings: [...((result.warnings as string[] | undefined) ?? []), warning],
    }), { status: confirmed.status, headers: { "content-type": "application/json" } });
  } catch (error) {
    await apiFetch(`${sessionPath}/abort`, flags, { method: "POST" }).catch(() => undefined);
    throw error;
  }
}

/** Upload, or extract mode: the same transports against /v1/extracts plus the retention fields. */
type IntakeMode = { base: "/v1/uploads" | "/v1/extracts"; fields: Record<string, string | number | boolean> };
const UPLOAD_MODE: IntakeMode = { base: "/v1/uploads", fields: {} };

async function uploadCommand(files: string[], flags: Record<string, string | boolean>, intake: IntakeMode = UPLOAD_MODE): Promise<void> {
  if (files.length === 0) {
    console.error("Error: at least one file path required");
    process.exitCode = 1;
    return;
  }

  if (flags.estimate === true && intake === UPLOAD_MODE) {
    const target = resolveIntakeTarget(flags);
    const estimateFiles = await profiledEstimateFiles(files);
    await runEstimate("/v1/uploads/estimate", { files: estimateFiles, ...(target.project ? { project: target.project } : {}) }, flags);
    return;
  }

  const formData = new FormData();
  for (const [name, value] of Object.entries(intake.fields)) formData.append(name, String(value));

  const target = resolveIntakeTarget(flags);
  if (target.project) formData.append("project", target.project);
  if (target.newProject) formData.append("newProject", "true");
  if (target.templateKey) formData.append("templateKey", target.templateKey);
  const qualityPipeline = resolveQualityPipeline(flags).pipeline;
  if (qualityPipeline) formData.append("pipeline", JSON.stringify(qualityPipeline));
  if (typeof flags.canonicalId === "string") {
    // Re-uploading with the same canonical ID replaces the previous version in search.
    if (files.length !== 1) throw new Error("--canonical-id applies to a single file.");
    formData.append("canonicalId", flags.canonicalId);
  }

  if (typeof flags.path === "string" && flags.path) {
    // Same folder path and filename re-uploaded in a project is a new version of one document.
    formData.append("paths", JSON.stringify(files.map(() => flags.path)));
  }

  const blobs: Array<{ blob: Blob; name: string }> = [];
  for (const filePath of files) {
    const blob = await openAsBlob(filePath);
    blobs.push({ blob, name: basename(filePath) });
    formData.append("files", blob, basename(filePath));
  }

  // /v1/uploads/bulk buffers multipart bodies and is capped (25 MB by default);
  // larger uploads go straight to storage through a direct upload session.
  const totalBytes = blobs.reduce((sum, file) => sum + file.blob.size, 0);
  // The bulk body is timed by its size, not the 30 s a small request gets, and carries an Idempotency-Key so a timed-out
  // attempt can be sent again without uploading (and billing) the files twice.
  const response = totalBytes > DIRECT_UPLOAD_THRESHOLD_BYTES
    ? await uploadDirect(blobs, formData, flags, intake)
    : await apiFetchRepeatable(`${intake.base}/bulk`, flags, {
      method: "POST",
      headers: { "Idempotency-Key": typeof flags.idempotencyKey === "string" && flags.idempotencyKey ? flags.idempotencyKey : randomUUID() },
      body: formData
    }, bodyTimeoutMs(flags, totalBytes));

  if (!response.ok) {
    printFailure(await responseFailure(response));
    process.exitCode = 1;
    return;
  }

  await printIntakeResult(response, flags);
}

type CostEstimate = {
  pages: number; documents: number; billing: "enforced" | "disabled";
  credits: { low: number; high: number } | null; seconds: { low: number; high: number } | null; basis: string;
};
type JobStatus = {
  id: string; kind: string; status: string; reason?: string; runIds: string[];
  queue?: { position: number | null; ahead: number | null }; estimate: CostEstimate | null; estimateUrl?: string;
};

function formatEstimate(estimate: CostEstimate): string {
  const lines = [`Pages:     ${estimate.pages} across ${estimate.documents} document${estimate.documents === 1 ? "" : "s"}`];
  lines.push(estimate.credits ? `Credits:   ${estimate.credits.low}–${estimate.credits.high}` : "Credits:   none (billing disabled on this deployment)");
  if (estimate.seconds) lines.push(`Time:      ${Math.round(estimate.seconds.low)}–${Math.round(estimate.seconds.high)} s`);
  lines.push(`Basis:     ${estimate.basis}`);
  return lines.join("\n");
}

/**
 * Files for `POST /v1/uploads/estimate`. When the offline profiler (`@docslurp/estimate`) is installed beside the CLI, each
 * file is profiled locally (type, pages, PDF page facts, media duration; nothing is uploaded) and its profile sent with it;
 * otherwise files go by name and size, and the server estimates their pages from size.
 */
async function profiledEstimateFiles(paths: string[]): Promise<Array<{ name: string; size: number; profile?: unknown }>> {
  const sized = await Promise.all(paths.map(async (filePath) => ({ name: basename(filePath), size: (await openAsBlob(filePath)).size })));
  type Profiler = { createEstimator(): Promise<unknown>; estimatePaths(estimator: unknown, paths: string[]): Promise<{ request: { files: Array<{ name: string; size: number; profile?: unknown }> } }> };
  let profiler: Profiler;
  try {
    // A variable specifier: the profiler is optional and never a build-time dependency.
    const specifier = "@docslurp/estimate";
    const [core, node] = await Promise.all([import(specifier), import(`${specifier}/node`)]);
    profiler = { createEstimator: core.createEstimator, estimatePaths: node.estimatePaths };
  } catch {
    return sized;
  }
  try {
    const result = await profiler.estimatePaths(await profiler.createEstimator(), paths);
    return result.request.files.map((file, index) => ({ ...file, name: sized[index]!.name, size: sized[index]!.size }));
  } catch {
    return sized;
  }
}

/**
 * `docslurp estimate <files...>`: profile the files locally (when `@docslurp/estimate` is installed) and print the
 * server's quote: ingest credits, monthly hosting and usage. Works without an API key (`POST /v1/estimate`).
 */
async function estimateCommand(files: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (files.length === 0) {
    console.error("Error: at least one file path required");
    process.exitCode = 1;
    return;
  }
  const settings: Record<string, unknown> = {};
  if (typeof flags.quality === "string") settings.quality = resolveQualityPipeline(flags).pipeline?.quality;
  if (typeof flags.indexing === "string") settings.indexing = flags.indexing;
  if (typeof flags.months === "string") settings.hostingMonths = Number.parseInt(flags.months, 10);
  const body = { files: await profiledEstimateFiles(files), ...(Object.keys(settings).length ? { settings } : {}) };
  const base = (typeof flags["api-url"] === "string" ? flags["api-url"] : process.env.DOCSLURP_API_URL ?? "https://docslurp.io").replace(/\/$/, "");
  const response = await fetch(`${base}/v1/estimate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    console.error(`Error: estimate failed (${response.status}): ${await response.text()}`);
    process.exitCode = 1;
    return;
  }
  const quote = await response.json() as {
    pages: { low: number; high: number }; pricingVersion: string; validUntil: string; files: { total: number; profiled: number };
    ingest: { credits: { low: number; high: number } | null }; hosting: { bytes: { low: number; high: number }; creditsPerMonth: { low: number; high: number } | null };
    rates: { pagesPerDollar: { low: number; high: number } | null };
  };
  if (flags.json === true) {
    console.log(JSON.stringify(quote, null, 2));
    return;
  }
  const range = (r: { low: number; high: number }, digits = 2) => (r.low === r.high ? r.low.toFixed(digits) : `${r.low.toFixed(digits)}–${r.high.toFixed(digits)}`);
  console.log(`Files:     ${quote.files.total} (${quote.files.profiled} profiled locally)`);
  console.log(`Pages:     ${range(quote.pages, 0)}`);
  console.log(quote.ingest.credits ? `Ingest:    ${range(quote.ingest.credits)} credits (estimate)` : "Ingest:    no credits (billing disabled on this deployment)");
  console.log(`Hosting:   ${range({ low: quote.hosting.bytes.low / 1e6, high: quote.hosting.bytes.high / 1e6 }, 1)} MB${quote.hosting.creditsPerMonth ? `, ${range(quote.hosting.creditsPerMonth)} credits per month` : ""}`);
  if (quote.rates.pagesPerDollar) console.log(`Pages/$1:  ${range(quote.rates.pagesPerDollar, 0)}`);
  console.log(`Pricing:   ${quote.pricingVersion}, valid until ${quote.validUntil}`);
}

/** POSTs to a `…/estimate` route, prints the estimate (or raw JSON with --json) and leaves the operation undone. */
async function runEstimate(pathname: string, body: unknown, flags: Record<string, string | boolean>): Promise<void> {
  const response = await apiFetch(pathname, flags, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    printFailure(await responseFailure(response));
    process.exitCode = 1;
    return;
  }
  const result = await response.json() as { estimate: CostEstimate; impact?: { kind: string } };
  if (flags.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    if (result.impact) console.log(`Impact:    ${result.impact.kind}`);
    console.log(formatEstimate(result.estimate));
    console.log("Estimate only: nothing was started.");
  }
}

function printJob(job: JobStatus): void {
  const detail = job.reason ? ` (${job.reason})` : "";
  const queue = job.queue?.position != null ? `, queue position ${job.queue.position}` : "";
  console.log(`Job ${job.id}: ${job.kind} ${job.status}${detail}${queue}`);
}

async function fullIndexCommand(flags: Record<string, string | boolean>): Promise<void> {
  const document = typeof flags.document === "string" && flags.document ? flags.document : undefined;
  const base = document ? `/v1/documents/${encodeURIComponent(document)}/full-index` : `/v1/projects/${encodeURIComponent(resolveProject(flags))}/full-index`;
  if (flags.estimate === true) return runEstimate(`${base}/estimate`, {}, flags);
  await startWork(base, {}, flags);
}

async function reprocessCommand(runId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!runId) {
    console.error("Error: run ID required");
    process.exitCode = 1;
    return;
  }
  const base = `/v1/runs/${encodeURIComponent(runId)}/reprocess`;
  const body = typeof flags.stageFrom === "string" && flags.stageFrom ? { stageFrom: flags.stageFrom } : {};
  if (flags.estimate === true) return runEstimate(`${base}/estimate`, body, flags);
  await startWork(base, body, flags);
}

async function startWork(pathname: string, body: unknown, flags: Record<string, string | boolean>): Promise<void> {
  const response = await apiFetch(pathname, flags, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    printFailure(await responseFailure(response));
    process.exitCode = 1;
    return;
  }
  // Reprocess answers the run itself, or { run, warnings } when its start was deferred.
  const result = await response.json() as { runId?: string; id?: string; run?: { id?: string }; job?: JobStatus };
  if (flags.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    const runId = result.runId ?? result.id ?? result.run?.id;
    if (runId) console.log(`Run ID:    ${runId}`);
    if (result.job) printJob(result.job);
  }
  const runId = result.runId ?? result.id ?? result.run?.id;
  if (flags.watch === true && runId) await statusCommand(runId, flags);
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

async function jobsCommand(action: string | undefined, jobId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if ((action !== "get" && action !== "watch") || !jobId) {
    console.error("Usage: docslurp jobs get|watch <jobId>");
    process.exitCode = 1;
    return;
  }
  const path = `/v1/jobs/${encodeURIComponent(jobId)}`;
  const fetchJob = async (): Promise<JobStatus | null> => {
    const response = await apiFetch(path, flags);
    if (!response.ok) {
      printFailure(await responseFailure(response));
      process.exitCode = 1;
      return null;
    }
    return await response.json() as JobStatus;
  };
  if (action === "get") {
    const job = await fetchJob();
    if (!job) return;
    if (flags.json === true) console.log(JSON.stringify(job, null, 2));
    else {
      printJob(job);
      if (job.estimate) console.log(formatEstimate(job.estimate));
    }
    return;
  }
  // Prefer the SSE stream; poll when it is unavailable or ends early.
  const timeoutMs = Number(flags.timeout ?? 300) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a positive number of seconds.");
  let deadlineAt = Date.now() + timeoutMs;
  let lastLine = "";
  const show = (job: JobStatus): boolean => {
    const line = `${job.status}|${job.reason ?? ""}|${job.queue?.position ?? ""}`;
    if (line !== lastLine) { printJob(job); lastLine = line; }
    // A blocked job waits for credits or budget; the timeout only bounds active waits.
    if (job.status === "blocked") deadlineAt = Date.now() + timeoutMs;
    return TERMINAL_JOB_STATUSES.has(job.status);
  };
  try {
    const response = await apiFetch(`${path}/events`, flags, { headers: { Accept: "text/event-stream" } }, timeoutMs);
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
    } else {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          let parsed: { job?: JobStatus } & Partial<JobStatus>;
          try { parsed = JSON.parse(data); } catch { continue; } // skip malformed frames; polling covers gaps
          const job = (parsed?.job ?? parsed) as JobStatus;
          if (job?.status && show(job)) {
            await response.body.cancel().catch(() => undefined);
            process.exitCode = job.status === "completed" ? 0 : 1;
            return;
          }
        }
      }
    }
  } catch {
    // fall back to polling
  }
  while (Date.now() < deadlineAt) {
    const job = await fetchJob();
    if (!job) return;
    if (show(job)) { process.exitCode = job.status === "completed" ? 0 : 1; return; }
    if (Date.now() >= deadlineAt) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error("Timed out waiting for the job; it keeps running.");
  process.exitCode = 1;
}

type IntakeResult = {
  job?: JobStatus; run: { id: string }; project: { id: string; name: string; slug?: string }; documents: unknown[]; warnings?: string[];
  extract?: { id: string; expiresAt: string; paidRetention: boolean; notifyEmail: boolean };
};

async function printIntakeResult(response: Response, flags: Record<string, string | boolean>): Promise<void> {
  const result = await response.json() as IntakeResult;
  console.log(`Project: ${result.project.name} (${result.project.slug ?? result.project.id})`);
  console.log(`Run ID:    ${result.run.id}`);
  console.log(`Documents: ${result.documents.length}`);
  if (result.extract) {
    console.log(`Extract:   ${result.extract.id}`);
    console.log(`Deleted:   ${result.extract.expiresAt}${result.extract.paidRetention ? " (extended retention, charged as storage)" : ""}`);
    if (result.extract.notifyEmail) console.log("You'll get an email with a download link when it finishes.");
  }
  if (result.job) printJob(result.job);
  for (const warning of result.warnings ?? []) console.error(`Warning: ${warning}`);
  if (flags.watch === true) await statusCommand(result.run.id, flags);
}

async function ingestUrlCommand(urls: string[], flags: Record<string, string | boolean>, intake: IntakeMode = UPLOAD_MODE): Promise<void> {
  if (urls.length === 0) {
    console.error("Error: at least one URL required");
    process.exitCode = 1;
    return;
  }
  const response = await apiFetch(`${intake.base}/url`, flags, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls, ...resolveIntakeTarget(flags), ...resolveQualityPipeline(flags), ...intake.fields }),
  });
  if (!response.ok) {
    printFailure(await responseFailure(response));
    process.exitCode = 1;
    return;
  }
  await printIntakeResult(response, flags);
}

/** `docslurp extract`: files or URLs (not both), with the retention options. */
async function extractCommand(inputs: string[], flags: Record<string, string | boolean>): Promise<void> {
  const fields: Record<string, string | number | boolean> = {};
  if (typeof flags.retentionDays === "string") {
    const days = Number(flags.retentionDays);
    if (!Number.isInteger(days) || days < 1) throw new Error("--retention-days must be a whole number of days.");
    fields.retentionDays = days;
  }
  if (flags.noEmail === true) fields.notifyEmail = false;
  if (typeof flags.download === "string") {
    if (flags.download !== "markdown" && flags.download !== "all") throw new Error("--download must be markdown or all.");
    fields.download = flags.download;
  }
  const intake: IntakeMode = { base: "/v1/extracts", fields };
  const urls = inputs.filter((input) => /^https?:\/\//i.test(input));
  if (urls.length > 0 && urls.length !== inputs.length) throw new Error("Pass either files or URLs to extract, not both.");
  if (urls.length > 0) await ingestUrlCommand(urls, flags, intake);
  else await uploadCommand(inputs, flags, intake);
}

async function extractStatusCommand(extractId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!extractId) throw new Error("Extract ID required.");
  const response = await apiFetch(`/v1/extracts/${encodeURIComponent(extractId)}`, flags);
  if (response.status === 410) {
    console.error("This extract has expired and its files and outputs were deleted.");
    process.exitCode = 1;
    return;
  }
  if (!response.ok) {
    printFailure(await responseFailure(response));
    process.exitCode = 1;
    return;
  }
  const { extract } = await response.json() as { extract: { id: string; status: string; expiresAt: string; pages: number | null; download: { status: string; url: string | null } } };
  if (flags.json === true) {
    console.log(JSON.stringify(extract, null, 2));
    return;
  }
  console.log(`Extract:  ${extract.id}`);
  console.log(`Status:   ${extract.status}`);
  console.log(`Pages:    ${extract.pages ?? "-"}`);
  console.log(`Download: ${extract.download.status}${extract.download.url ? ` (docslurp extract-download ${extract.id})` : ""}`);
  console.log(`Deleted:  ${extract.expiresAt}`);
}

/** Prints the two-minute signed URL; the API key goes only to DocSlurp, never to storage. */
async function extractDownloadCommand(extractId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!extractId) throw new Error("Extract ID required.");
  const response = await apiFetch(`/v1/extracts/${encodeURIComponent(extractId)}/download`, flags, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    console.log(location);
    return;
  }
  printFailure(await responseFailure(response));
  process.exitCode = 1;
}

function renderBar(current: number, total: number, width = 20): string {
  if (total <= 0) return "░".repeat(width);
  const ratio = Math.min(1, current / total);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
}

/** An AbortSignal.timeout abort (TimeoutError), as fetch rejects with it directly or as its cause. */
function isTimeoutAbort(error: unknown): boolean {
  const named = (value: unknown) => value instanceof Error && (value.name === "TimeoutError" || value.name === "AbortError");
  return named(error) || (error instanceof Error && named((error as Error & { cause?: unknown }).cause));
}

/** What a spend-paused run is waiting for, so "paused" is not read as stuck. */
function spendPausedNote(run: { controlState?: string | null; pauseReason?: string | null }): string {
  if (run.controlState !== "paused" || !run.pauseReason) return "";
  const why: Record<string, string> = {
    credit_exhausted: "out of credits; resumes after a top-up",
    project_budget_paused: "project budget reached; resumes when it is raised",
    org_budget_paused: "organization budget reached; resumes when it is raised",
    plan_not_entitled: "not covered by the current plan",
  };
  return ` (${why[run.pauseReason] ?? run.pauseReason})`;
}

async function statusCommand(runId: string, flags: Record<string, string | boolean>): Promise<void> {
  const watch = flags.watch === true;
  const timeoutSeconds = Number(flags.timeout ?? 300);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number of seconds.");
  const expiresAt = Date.now() + timeoutSeconds * 1000;
  const useTtyProgress = watch && process.stdout.isTTY === true;
  const startTime = Date.now();
  let lineCount = 0;

  const printStatus = async (): Promise<boolean> => {
    const remainingMs = expiresAt - Date.now();
    const deadlineError = () => new Error(`Run ${runId} did not complete within ${timeoutSeconds}s; it may still be queued or processing.`);
    if (watch && remainingMs <= 0) throw deadlineError();
    const requestTimeoutMs = watch ? Math.min(30_000, remainingMs) : Math.min(30_000, timeoutSeconds * 1000);
    let response: Response;
    try {
      response = await apiFetch(`/v1/runs/${encodeURIComponent(runId)}/progress`, flags, {}, requestTimeoutMs);
    } catch (error) {
      // The request's timeout was the watch's remaining time: it aborted because the watch deadline arrived, so report
      // that, not the transport's generic "aborted due to timeout". A request that timed out early keeps its own error.
      if (watch && isTimeoutAbort(error) && expiresAt - Date.now() <= 0) throw deadlineError();
      throw error;
    }

    if (!response.ok) {
      throw await responseFailure(response);
    }

    const snapshot = await response.json() as {
      run: {
        id: string;
        status: string;
        stage: string;
        controlState?: string | null;
        pauseReason?: string | null;
        error?: string | null;
        totalDocuments: number;
        processedDocuments: number;
        pagesTotal: number;
        pagesProcessed: number;
      };
    };

    const run = snapshot.run;
    const elapsed = formatElapsed(Date.now() - startTime);
    const docPct = run.totalDocuments > 0 ? Math.round((run.processedDocuments / run.totalDocuments) * 100) : 0;
    const pagePct = run.pagesTotal > 0 ? Math.round((run.pagesProcessed / run.pagesTotal) * 100) : 0;

    const lines = [
      `Run:       ${run.id}`,
      `Status:    ${run.controlState ?? run.status}${spendPausedNote(run)}`,
      `Stage:     ${run.stage}`,
      `Documents: [${renderBar(run.processedDocuments, run.totalDocuments)}] ${run.processedDocuments}/${run.totalDocuments} (${docPct}%)`,
      `Pages:     [${renderBar(run.pagesProcessed, run.pagesTotal)}] ${run.pagesProcessed}/${run.pagesTotal} (${pagePct}%)`,
      `Elapsed:   ${elapsed}`
    ];

    if (useTtyProgress && lineCount > 0) {
      process.stdout.write(`\x1b[${lineCount}A`);
    }

    const output = lines.join("\n") + "\n";
    process.stdout.write(output);
    lineCount = lines.length;

    // A spend pause (credits, a budget, a plan) lifts by itself once the org can spend: keep watching it.
    const spendPaused = run.controlState === "paused" && Boolean(run.pauseReason);
    const stopped = !spendPaused && ["paused", "cancelled", "dead-letter"].includes(run.controlState ?? "");
    const done = run.status === "completed" || run.status === "failed" || stopped;
    if (done) {
      const succeeded = run.status === "completed" && !stopped;
      console.log(`\n${succeeded ? "Done" : "Stopped"}: run ${run.controlState ?? run.status} in ${elapsed}`);
      if (!succeeded) {
        process.exitCode = 1;
        if (run.error) console.error(run.error);
      }
    }

    return done;
  };

  const done = await printStatus();
  if (!watch || done) return;

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(2000, expiresAt - Date.now()))));
    const finished = await printStatus();
    if (finished) break;
  }
}

async function runsCommand(flags: Record<string, string | boolean>): Promise<void> {
  const params = new URLSearchParams();
  for (const name of ["limit", "cursor"]) {
    const value = flags[name];
    if (typeof value === "string" && value) params.set(name, value);
  }
  const response = await apiFetch(`/v1/runs${params.size ? `?${params}` : ""}`, flags);
  if (!response.ok) {
    console.error(`Failed to list runs (${response.status})`);
    process.exitCode = 1;
    return;
  }

  const data = await response.json() as {
    runs: Array<{
      id: string;
      status: string;
      stage: string;
      totalDocuments: number;
      createdAt: string;
    }>;
    hasMore?: boolean;
    nextCursor?: string | null;
  };

  if (data.runs.length === 0) {
    console.log("No runs found.");
    return;
  }

  console.log("ID                                   STATUS      STAGE            DOCS  CREATED");
  for (const run of data.runs) {
    console.log(
      `${run.id}  ${run.status.padEnd(10)}  ${(run.stage ?? "-").padEnd(15)}  ${String(run.totalDocuments).padStart(4)}  ${run.createdAt}`
    );
  }
  // A page is not the whole history: say so, and how to read the rest.
  if (data.hasMore && data.nextCursor) console.log(`\nMore runs exist. Next page: docslurp runs --cursor ${data.nextCursor}`);
}

type CliSearchResponse = {
  results: Array<{
    score: number;
    text: string;
    citation: { documentId?: string; filename: string; pageNumber?: number | null; pageNumbers?: number[] };
  }>;
  availability?: { message?: string | null };
  noMatch?: boolean;
};

function printSearch(data: CliSearchResponse, flags: Record<string, string | boolean>): void {
  if (data.availability?.message) console.error(data.availability.message);
  if (flags.context) {
    console.log(data.results.map((hit, index) => {
      const pages = hit.citation.pageNumbers?.length ? hit.citation.pageNumbers.join(", ") : hit.citation.pageNumber;
      const source = [hit.citation.filename, pages == null ? undefined : `pages ${pages}`, hit.citation.documentId ? `document ${hit.citation.documentId}` : undefined].filter(Boolean).join(" · ");
      return `[${index + 1}] ${source}\n${hit.text}`;
    }).join("\n\n"));
    return;
  }
  if (!data.results.length) { console.log(data.noMatch ? "No relevant match found. Lower --min-score (0 disables the floor) to see weaker passages." : "No results found."); return; }
  for (const [index, hit] of data.results.entries()) {
    const page = hit.citation.pageNumbers?.length ? hit.citation.pageNumbers.join(", ") : hit.citation.pageNumber ?? "-";
    console.log(`${String(index + 1).padStart(3)}. [${hit.score.toFixed(4)}] ${hit.citation.filename} (p.${page})`);
    console.log(`     ${hit.text.slice(0, 200).replace(/\n/g, " ")}`);
    if (index < data.results.length - 1) console.log("");
  }
}

async function searchCommand(query: string, flags: Record<string, string | boolean>): Promise<void> {
  const project = resolveProject(flags);
  if (flags.json && flags.context) throw new Error("Choose --json or --context.");
  if (flags.run) throw new Error("Search uses --project <id|slug|name>; --run is no longer supported.");
  if (flags.queriesFile) {
    if (query) throw new Error("Use a query or --queries-file, not both.");
    const inputs: unknown = JSON.parse(await readFile(String(flags.queriesFile), "utf8"));
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20) throw new Error("Queries file must contain a JSON array of 1–20 queries.");
    const queries = inputs.map((input) => {
      const value = typeof input === "string" ? { q: input } : input;
      if (!value || typeof value !== "object" || typeof value.q !== "string" || !value.q.trim()) throw new Error("Each query must be a nonempty string or an object with q.");
      const target = value.project ?? project;
      return typeof target === "string" && target.trim() ? { ...value, project: target } : value;
    });
    const concurrency = Number(flags.concurrency ?? 4);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("--concurrency must be an integer from 1 to 4.");
    const response = await apiFetch("/v1/search", flags, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries, concurrency }) });
    if (!response.ok) throw await responseFailure(response);
    const data = await response.json() as { results: Array<{ ok: true; data: CliSearchResponse } | { ok: false; error: { code: string; message: string; status: number } }> };
    if (flags.json) console.log(JSON.stringify(data));
    for (const [index, result] of data.results.entries()) {
      if (!result.ok) { console.error(`Query ${index + 1}: ${result.error.message}`); process.exitCode = 1; }
      else if (!flags.json) { console.log(`Query ${index + 1}: ${queries[index]?.q}`); printSearch(result.data, flags); }
    }
    return;
  }
  if (!query) throw new Error("Error: search query required");
  if (flags.concurrency) throw new Error("--concurrency requires --queries-file.");
  // A missing value arrives as "" and Number("") is 0, which would silently turn the floor off.
  const rawMinScore = flags.minScore === undefined ? undefined : String(flags.minScore).trim();
  const minScore = rawMinScore === undefined ? undefined : rawMinScore === "" ? Number.NaN : Number(rawMinScore);
  if (minScore !== undefined && !(minScore >= 0 && minScore <= 1)) throw new Error("--min-score must be a number from 0 to 1.");
  const params = new URLSearchParams({ q: query, ...(project ? { project } : {}), ...(minScore === undefined ? {} : { minScore: String(minScore) }) });
  const response = await apiFetch(`/v1/search?${params.toString()}`, flags);
  if (!response.ok) throw await responseFailure(response);
  const data = await response.json() as CliSearchResponse;
  if (flags.json) console.log(JSON.stringify(data)); else printSearch(data, flags);
}

async function chatCommand(question: string, flags: Record<string, string | boolean>): Promise<void> {
  const project = resolveProject(flags);
  if (!question.trim()) throw new Error("Chat question required.");
  if (flags.context || flags.queriesFile || flags.concurrency) throw new Error("Chat accepts one question; batch/context options are for search.");
  const response = await apiFetch("/v1/chat", flags, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: question, ...(project ? { project } : {}), ...(flags.session ? { sessionId: String(flags.session) } : {}) }),
  });
  if (!response.ok) throw await responseFailure(response);
  const data = await response.json() as { answer: string; sessionId: string; citations: CliSearchResponse["results"]; usage?: unknown; availability?: { message?: string | null } };
  if (flags.json) { console.log(JSON.stringify(data)); return; }
  console.log(data.answer);
  if (data.citations.length) { console.log("\nSources:"); printSearch({ results: data.citations }, { context: true }); }
  if (data.availability?.message) console.error(data.availability.message);
  console.error(`Session: ${data.sessionId}`);
}

type McpEnvelope = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

function writeMcpResponse(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...response })}\n`);
}

const MCP_CAPABILITIES_URI = "docslurp://capabilities";

async function mcpFetch(args: {
  apiUrl: string;
  auth: ResolvedAuth;
  pathname: string;
  method?: string;
  body?: unknown;
}): Promise<any> {
  const send = async (forceRefresh: boolean) => fetch(`${args.apiUrl}${args.pathname}`, {
    method: args.method ?? "GET",
    signal: AbortSignal.timeout(30_000),
    headers: {
      // Long-running: a stored login refreshes shortly before each expiry.
      Authorization: `Bearer ${await args.auth.token({ forceRefresh })}`,
      // The stdio MCP server proxies tool calls; label them apart from CLI commands.
      "X-DocSlurp-Client": "mcp-stdio",
      ...(args.body ? { "Content-Type": "application/json" } : {})
    },
    ...(args.body ? { body: JSON.stringify(args.body) } : {})
  });
  let response = await send(false);
  if (response.status === 401 && args.auth.source === "stored login") {
    await response.body?.cancel();
    response = await send(true);
  }
  if (!response.ok) throw await responseFailure(response);
  return await response.json();
}

async function mcpServerCommand(flags: Record<string, string | boolean>): Promise<void> {
  const apiUrl = resolveApiUrl(flags);
  // Same resolution as every command: a logged-in user needs no API key.
  const auth = await resolveAuth(flags, apiUrl) as ResolvedAuth;
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let initialized = false;
  let ready = false;
  const get = (pathname: string) => mcpFetch({ apiUrl, auth, pathname });

  for await (const line of input) {
    if (!line.trim()) continue;
    let envelope: McpEnvelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      writeMcpResponse({ id: null, error: { code: -32700, message: "Invalid JSON" } });
      continue;
    }
    if (!envelope || Array.isArray(envelope) || envelope.jsonrpc !== "2.0" ||
        typeof envelope.method !== "string" ||
        (envelope.id !== undefined && typeof envelope.id !== "string" && typeof envelope.id !== "number") ||
        (envelope.params !== undefined && (!envelope.params || Array.isArray(envelope.params) || typeof envelope.params !== "object"))) {
      writeMcpResponse({ id: null, error: { code: -32600, message: "Invalid request" } });
      continue;
    }
    // JSON-RPC notifications never receive a response.
    if (envelope.id === undefined) {
      if (envelope.method === "notifications/initialized" && initialized) ready = true;
      continue;
    }
    const respond = (result: unknown) => writeMcpResponse({ id: envelope.id, result });
    const invalid = (message: string) => writeMcpResponse({ id: envelope.id, error: { code: -32602, message } });
    try {
      if (envelope.method === "initialize") {
        if (typeof envelope.params?.protocolVersion !== "string") {
          invalid("protocolVersion is required");
          continue;
        }
        initialized = true;
        ready = false;
        respond({
          protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(envelope.params.protocolVersion)
            ? envelope.params.protocolVersion : "2025-06-18",
          serverInfo: { name: "docslurp-mcp", title: "DocSlurp", version },
          capabilities: { tools: {}, resources: {}, prompts: {} }
        });
        continue;
      }
      if (envelope.method === "ping") { respond({}); continue; }
      if (!ready) { invalid("Initialize the connection before using MCP capabilities"); continue; }
      switch (envelope.method) {
        case "tools/list": {
          const result = await get("/v1/mcp/tools");
          respond({ tools: result.tools.filter((tool: any) => tool.id !== "openUploader").map((tool: any) => ({
            name: tool.id, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
            ...(tool.annotations && { annotations: {
              title: tool.title, readOnlyHint: tool.annotations.readOnly, destructiveHint: tool.annotations.destructive,
              idempotentHint: tool.annotations.idempotent, openWorldHint: tool.annotations.openWorld
            } })
          })) });
          break;
        }
        case "tools/call": {
          const name = envelope.params?.name;
          const args = envelope.params?.arguments ?? {};
          if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(name) || !args || Array.isArray(args) || typeof args !== "object") {
            invalid("A tool name and object arguments are required"); break;
          }
          // The uploader is an MCP Apps widget; a stdio client has no UI host to render it.
          if (name === "openUploader") {
            respond({ content: [{ type: "text", text: "openUploader needs an MCP Apps host. Use upload with urls, or presigned files, from this client." }], isError: true });
            break;
          }
          try {
            const result = await mcpFetch({ apiUrl, auth, pathname: `/v1/mcp/tools/${encodeURIComponent(name)}`, method: "POST", body: args });
            respond({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
          } catch (error) {
            respond({ content: [{ type: "text", text: "We couldn’t complete this tool request. Please try again." }], isError: true });
          }
          break;
        }
        // Mirrors the HTTP MCP server (server/src/lib/mcp-http.ts): same URIs,
        // template and adapter paths, so stdio and HTTP clients see one surface.
        case "resources/list":
          respond({ resources: [{
            uri: MCP_CAPABILITIES_URI, name: "capabilities", title: "DocSlurp capabilities",
            description: "Available tools, schemas and authorization scopes.", mimeType: "application/json"
          }] });
          break;
        case "resources/templates/list":
          respond({ resourceTemplates: [] });
          break;
        case "resources/read": {
          const uri = envelope.params?.uri;
          if (uri !== MCP_CAPABILITIES_URI) { invalid("Unknown resource URI"); break; }
          const pathname = "/v1/mcp/resources/capabilities";
          let result: unknown;
          try { result = await get(pathname); }
          catch { invalid("Resource unavailable"); break; }
          respond({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result) }] });
          break;
        }
        case "prompts/list":
          respond({ prompts: [{ name: "project-grounded-answer", title: "Project grounded answer", description: "Answer using project evidence and citations" }] });
          break;
        case "prompts/get": {
          if (envelope.params?.name !== "project-grounded-answer") { invalid("Unknown prompt name"); break; }
          const result = await get("/v1/mcp/prompts/project-grounded-answer");
          respond({ messages: [{ role: "user", content: { type: "text", text: result.prompt } }] });
          break;
        }
        default:
          writeMcpResponse({ id: envelope.id, error: { code: -32601, message: `Unsupported method: ${envelope.method}` } });
      }
    } catch (error) {
      writeMcpResponse({ id: envelope.id, error: { code: -32000, message: "We couldn’t complete this request. Please try again." } });
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--license") {
    console.log(await readFile(new URL("../LICENSE", import.meta.url), "utf8"));
    console.log(await readFile(new URL("../NOTICE", import.meta.url), "utf8"));
    return;
  }

  // `exec` hands everything after `--` to the child untouched (including --help).
  const separator = args[0] === "exec" ? args.indexOf("--") : -1;
  const own = separator >= 0 ? args.slice(0, separator) : args;
  if (args.length === 0 || own.includes("--help") || own.includes("-h")) {
    usage();
    return;
  }

  const { command, positional, flags } = parseCliArgs(own);

  switch (command) {
    case "upload":
      await uploadCommand(positional, flags);
      break;
    case "estimate":
      await estimateCommand(positional, flags);
      break;
    case "ingest-url":
      await ingestUrlCommand(positional, flags);
      break;
    case "extract":
      await extractCommand(positional, flags);
      break;
    case "extract-status":
      await extractStatusCommand(positional[0], flags);
      break;
    case "extract-download":
      await extractDownloadCommand(positional[0], flags);
      break;
    case "full-index":
      await fullIndexCommand(flags);
      break;
    case "reprocess":
      await reprocessCommand(positional[0], flags);
      break;
    case "jobs":
      await jobsCommand(positional[0], positional[1], flags);
      break;
    case "status": {
      const runId = positional[0];
      if (!runId) {
        console.error("Error: run ID required");
        process.exitCode = 1;
        return;
      }
      await statusCommand(runId, flags);
      break;
    }
    case "runs":
      await runsCommand(flags);
      break;
    case "search": {
      const query = positional.join(" ");
      if (!query && !flags.queriesFile) {
        console.error("Error: search query required");
        process.exitCode = 1;
        return;
      }
      await searchCommand(query, flags);
      break;
    }
    case "chat":
      await chatCommand(positional.join(" "), flags);
      break;
    case "mcp-server":
    case "mcp":
      await mcpServerCommand(flags);
      break;
    case "login":
      await loginCommand(flags, resolveApiUrl(flags));
      break;
    case "logout":
      await logoutCommand(flags, resolveApiUrl(flags));
      break;
    case "whoami":
      await whoamiCommand(flags, resolveApiUrl(flags), false);
      break;
    case "auth": {
      const apiUrl = resolveApiUrl(flags);
      if (positional[0] === "status") await whoamiCommand(flags, apiUrl, true);
      else if (positional[0] === "token") await authTokenCommand(flags, apiUrl);
      else if (positional[0] === "login") await loginCommand(flags, apiUrl);
      else if (positional[0] === "logout") await logoutCommand(flags, apiUrl);
      else throw new Error("Usage: docslurp auth <status|token|login|logout>");
      break;
    }
    case "exec": {
      if (separator < 0) throw new Error("Usage: docslurp exec [--profile <name>] -- <command> [args...]");
      const project = typeof flags.project === "string" && flags.project.trim() ? flags.project.trim() : process.env.DOCSLURP_PROJECT?.trim() || null;
      await execCommand(flags, resolveApiUrl(flags), project, args.slice(separator + 1));
      break;
    }
    case "migrate-algolia-synonyms": {
      const inputPath = positional[0];
      if (!inputPath) {
        console.error("Error: path to Algolia synonyms export JSON required");
        process.exitCode = 1;
        return;
      }
      const out = typeof flags.out === "string" ? String(flags.out) : "";
      await migrateAlgoliaSynonymsCommand(inputPath, out);
      break;
    }
    case "import-search-compat": {
      const inputPath = positional[0];
      if (!inputPath) {
        console.error("Error: path to compatibility export JSON required");
        process.exitCode = 1;
        return;
      }
      await importSearchCompatCommand(inputPath, flags);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  printFailure(error);
  process.exitCode = 1;
});

class CliApiError extends Error {
  constructor(readonly status: number, readonly failure: ReturnType<typeof safeHttpFailure>) {
    super(failure.message);
  }
}
async function responseFailure(response: Response): Promise<CliApiError> {
  const body: unknown = await response.json().catch(() => null);
  const failure = safeHttpFailure(response.status, body);
  const wait = retryAfterSeconds(response.headers.get("retry-after"));
  return new CliApiError(response.status, { ...failure, ...(wait === undefined ? {} : { retryAfterSeconds: wait }) });
}
function printFailure(error: unknown): void {
  if (error instanceof CliApiError) {
    if (process.argv.includes("--json")) console.error(JSON.stringify({ error: { ...error.failure, status: error.status } }));
    else console.error(error.message + (error.failure.requestId ? ` (request ${error.failure.requestId})` : ""));
  } else console.error(error instanceof Error ? error.message : String(error));
}
