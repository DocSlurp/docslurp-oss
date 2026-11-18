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

const QUALITY_LEVELS = ["fastest", "balanced", "smart"] as const;
type Quality = (typeof QUALITY_LEVELS)[number];
/** Deprecated `--quality` words and their replacements (still accepted during the window, with a note on stderr). */
const LEGACY_QUALITY: Readonly<Record<string, Quality>> = { fast: "fastest", auto: "balanced", good: "smart" };

/** `--quality fastest|balanced|smart` (or a deprecated fast|auto|good) as a pipeline override, or {} when the project setting applies. */
export function resolveQualityPipeline(flags: Record<string, string | boolean>): { pipeline?: { quality: Quality } } {
  if (flags.quality === undefined) return {};
  const raw = typeof flags.quality === "string" ? flags.quality.trim().toLowerCase() : "";
  const legacy = LEGACY_QUALITY[raw];
  if (legacy) {
    console.error(`Note: --quality ${raw} is deprecated; use --quality ${legacy}.`);
    return { pipeline: { quality: legacy } };
  }
  if (!(QUALITY_LEVELS as readonly string[]).includes(raw)) throw new Error("--quality must be fastest, balanced or smart.");
  return { pipeline: { quality: raw as Quality } };
}

const VISUALS_LEVELS = ["none", "figures", "charts", "charts-ai"] as const;
type Visuals = (typeof VISUALS_LEVELS)[number];
const CHART_EXPORT_TIERS = ["off", "free", "models"] as const;
type ChartExportTier = (typeof CHART_EXPORT_TIERS)[number];
const VISUALS_FOR_TIER: Readonly<Record<ChartExportTier, Visuals>> = { off: "figures", free: "charts", models: "charts-ai" };

/** The deprecated `--chart-export off|free|models`, as the tier it names, or null when not given. */
export function resolveChartExportFlag(flags: Record<string, string | boolean>): { tier: ChartExportTier } | null {
  if (flags.chartExport === undefined) return null;
  const tier = typeof flags.chartExport === "string" ? flags.chartExport.trim().toLowerCase() : "";
  if (!(CHART_EXPORT_TIERS as readonly string[]).includes(tier)) throw new Error("--chart-export must be off, free or models.");
  return { tier: tier as ChartExportTier };
}

/**
 * `--visuals none|figures|charts|charts-ai`, or the deprecated `--chart-export` / `--no-figures` it replaces, or null
 * when the project setting (or the deployment default) applies. Two flags that disagree are an error.
 */
export function resolveVisualsFlag(flags: Record<string, string | boolean>): Visuals | null {
  const named: Array<{ flag: string; visuals: Visuals }> = [];
  if (flags.visuals !== undefined) {
    const raw = typeof flags.visuals === "string" ? flags.visuals.trim().toLowerCase() : "";
    if (!(VISUALS_LEVELS as readonly string[]).includes(raw)) throw new Error("--visuals must be none, figures, charts or charts-ai.");
    named.push({ flag: "--visuals", visuals: raw as Visuals });
  }
  const chartExport = resolveChartExportFlag(flags);
  if (chartExport) {
    console.error(`Note: --chart-export is deprecated; use --visuals ${VISUALS_FOR_TIER[chartExport.tier]}.`);
    named.push({ flag: "--chart-export", visuals: VISUALS_FOR_TIER[chartExport.tier] });
  }
  if (flags.noFigures === true) {
    console.error("Note: --no-figures is deprecated; use --visuals none.");
    named.push({ flag: "--no-figures", visuals: "none" });
  }
  const values = new Set(named.map((entry) => entry.visuals));
  if (values.size > 1) throw new Error(`${named.map((entry) => entry.flag).join(" and ")} disagree; use --visuals only.`);
  return named[0]?.visuals ?? null;
}

/** `--quality` and `--visuals` (or their deprecated aliases) as one pipeline override, or {} when neither is given. */
export function resolveIntakePipeline(flags: Record<string, string | boolean>): { pipeline?: { quality?: Quality; visuals?: Visuals } } {
  const quality = resolveQualityPipeline(flags).pipeline?.quality;
  const visuals = resolveVisualsFlag(flags);
  const pipeline = { ...(quality ? { quality } : {}), ...(visuals ? { visuals } : {}) };
  return Object.keys(pipeline).length ? { pipeline } : {};
}

/** Prints deprecation warnings a response carries (`warnings[]` with code `deprecated_field`) to stderr. */
export function printDeprecationWarnings(body: unknown): void {
  const warnings = body && typeof body === "object" ? (body as { warnings?: unknown }).warnings : undefined;
  if (!Array.isArray(warnings)) return;
  for (const warning of warnings) {
    if (warning && typeof warning === "object" && (warning as { code?: unknown }).code === "deprecated_field") {
      console.error(`Warning: ${String((warning as { message?: unknown }).message ?? "a deprecated field was used")}`);
    }
  }
}

function usage(): void {
  console.log(`Usage:
  docslurp estimate <files...> [--quality <fastest|balanced|smart>] [--indexing <full|on-demand|visual>] [--visuals <none|figures|charts|charts-ai>] [--months <n>] [--json]
  docslurp upload <files...> [--project <id|slug|name> | --new-project] [--template <key>] [--quality <fastest|balanced|smart>] [--visuals <none|figures|charts|charts-ai>] [--canonical-id <id>] [--path <folder>] [--idempotency-key <key>] [--estimate] [--watch] [--api-url <url>]
  docslurp ingest-url <urls...> [--project <id|slug|name> | --new-project] [--template <key>] [--quality <fastest|balanced|smart>] [--visuals <none|figures|charts|charts-ai>] [--estimate] [--watch] [--api-url <url>]
  docslurp extract <files...|urls...> [--retention-days <n>] [--no-email] [--download <markdown|all>] [upload options]
  docslurp extract-status <extractId> [--json]
  docslurp extract-download <extractId>
  docslurp full-index [--project <id|slug|name>] [--document <id>] [--estimate] [--watch]
  docslurp reindex [--project <id|slug|name>] [--embedding-profile <profile>] [--late-chunking <on|off>] [--late-chunking-window <1-6>] [--chunk-overlap <on|off>] [--contextual-preambles <on|off>] [--vector-backends <a,b>] [--confirm <signature>] [--estimate] [--json]
  docslurp reprocess <runId> [--stage-from <stage>] [--quality <fastest|balanced|smart>] [--visuals <none|figures|charts|charts-ai>] [--estimate] [--watch]
  docslurp summary-tree backfill [--project <id|slug|name>] --max-cost-cents <n> [--estimate] [--watch] [--json]
  docslurp summary-tree status [--project <id|slug|name>] [--json]
  docslurp summary-tree cancel <jobId> [--project <id|slug|name>] [--json]
  docslurp jobs get <jobId> [--json]
  docslurp jobs watch <jobId> [--timeout <seconds>]
  docslurp status <runId> [--api-url <url>] [--watch] [--timeout <seconds>]
  docslurp runs [--limit <1-100>] [--cursor <nextCursor>] [--api-url <url>]
  docslurp search <query> [--project <id|slug|name>] [--min-score <0..1>] [--mode <keyword|hybrid|deep>] [--summary-tree <off|guide|include>] [--stream [--stats]] [--json | --context]
  docslurp search --queries-file <queries.json> [--project <id|slug|name>] [--concurrency <1..4>] [--json | --context]
  docslurp chat <question> [--project <id|slug|name>] [--session <id>] [--tier fastest|balanced|smart] [--reasoning none|minimal|low|medium|high] [--json]
  docslurp mcp-server [--api-url <url>] [--api-key <key>]   (alias: docslurp mcp)
  docslurp login [--device] [--scopes "search:deep read chat ingest"] [--no-browser] [--profile <name>] [--api-url <url>]
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
docslurp login (refreshed automatically). docslurp login asks for search:deep and read;
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
--quality sets processing quality for the upload (default: the project's, balanced unless changed):
fastest reads the text layer only and keeps pages without one as images, not read (lowest price);
balanced reads each page the cheapest faithful way (its price depends on the mix of pages);
smart reads every page with AI (highest price). Prices: https://docslurp.io/pricing
(fast, auto and good are deprecated aliases.)
--visuals sets figures and charts for this request (default: the project's setting, else the
deployment's default, figures): none; figures keeps PDF figures as files; charts also exports
charts that carry their own data (Office charts, embedded chart specs, vector graphics) at no
charge; charts-ai also reads other charts with AI, billed per chart read. upload --estimate and
estimate price it. --chart-export off|free|models and --no-figures are deprecated aliases.
smart and charts-ai above the project's setting need project editor rights (or a key with
the pipeline:billed-features scope).
--estimate prints the work estimate (pages, documents, credits, time) for the operation and exits without doing it.
Mutations that queue background work print their job; follow it with docslurp jobs watch <jobId>.
--watch waits up to five minutes by default; --timeout sets its limit.
extract works like upload (files) or ingest-url (URLs), but the files and every output are
deleted when the retention window ends: 48 hours free by default, --retention-days for longer
(charged as storage). It emails a sign-in download link when done unless --no-email is set;
extract-download prints a two-minute signed URL for the results zip.

Copyright 2025-2026 17th Street Labs, LLC and contributors. No warranty.
Licensed under the Business Source License 1.1; each version becomes
Apache-2.0 three years after release. Run docslurp --license for the terms.
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

/** Flags that take no value, by their command-line name, and the key commands read them as. */
const BOOLEAN_FLAGS: Readonly<Record<string, string>> = {
  watch: "watch", json: "json", context: "context", estimate: "estimate", device: "device", force: "force", stream: "stream", stats: "stats",
  "no-browser": "noBrowser", "no-email": "noEmail", "new-project": "newProject", "no-figures": "noFigures",
};

/** Flags that take a value (`--flag value` or `--flag=value`); the key is the camelCase name. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "project", "api-url", "api-key", "run", "source", "out", "queries-file", "concurrency", "min-score", "session", "canonical-id", "path",
  "template", "document", "stage-from", "retention-days", "download", "quality", "visuals", "chart-export", "idempotency-key",
  "timeout", "limit", "cursor", "mode", "summary-tree", "tier", "reasoning", "months", "indexing", "model", "scopes", "profile",
  "max-cost-cents", "embedding-profile", "chunk-overlap", "contextual-preambles", "confirm", "late-chunking", "late-chunking-window", "vector-backends",
]);

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The command, its positional arguments and its flags. Strict (council #387 r2 M1): an unknown flag is an error, never a
 * flag that swallows the next argument (`--yes --estimate` once started a billed ingest); a value flag never takes a
 * value that starts with `--`; a flag without a value takes none (`--estimate=true` is an error, not a different flag);
 * `--flag=value` works for value flags. A bare `-x` stays positional as before.
 */
function parseCliArgs(argv: string[]) {
  const command = argv[0];
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i] ?? "";
    if (/^--(?:workspace(?:-id|-name)?|new-workspace)(?:=|$)/.test(arg)) throw new Error("Legacy workspace flags are no longer supported; use --project or --new-project.");
    if (!arg.startsWith("--")) {
      positional.push(arg);
      i++;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (name === "project-name" || name === "project-id") {
      throw new Error(`--${name} was removed: pass a project ID, slug or name with --project (a name that matches no project is created on upload).`);
    }
    const boolean = BOOLEAN_FLAGS[name];
    if (boolean) {
      if (eq >= 0) throw new Error(`--${name} takes no value (got ${arg}).`);
      flags[boolean] = true;
      i++;
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
      // An empty value is never meant (`--project=` would otherwise quietly mean the default project).
      if (value === undefined || value.trim() === "" || (eq < 0 && value.startsWith("--"))) throw new Error(`--${name} needs a value.`);
      flags[camel(name)] = value;
      i += eq >= 0 ? 1 : 2;
    } else {
      throw new Error(`Unknown flag --${name}${command ? ` for ${command}` : ""}. Run docslurp --help for the flags each command takes.`);
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
    // A body-less POST goes out as an empty JSON object: the production API refuses an upload-path POST that has no
    // content type (fetch's default when there is no body) with a 400.
    const bodyless = init.body == null && /^(POST|PUT|PATCH)$/i.test(init.method ?? "GET");
    if (bodyless && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const body = bodyless ? "{}" : init.body;
    return fetch(`${apiUrl}${pathname}`, { ...init, body, headers, signal: AbortSignal.timeout(Math.max(1, Math.ceil(requestTimeoutMs))) });
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
/** Files one direct upload session takes (the server's session schema). Larger uploads go up as several sessions, one run each. */
const DIRECT_SESSION_MAX_FILES = 1000;

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
  // A part without `url` (the server signs a bounded number per session read; see partUrlsOmitted) is signed with parts/sign.
  putUrl?: string; partSize?: number; pendingParts?: Array<{ partNumber: number; sizeBytes: number; url?: string }>; partUrlsOmitted?: boolean;
  /** False when a large session's read did not check this file's object (see the session read's `inspected`). */
  inspected?: boolean;
  completedParts?: Array<{ partNumber: number; etag: string }>;
};
type UploadRejection = { index?: number; clientId?: string; filename: string; statusCode: number; code: string; message: string };
type DirectSession = { sessionId: string; status?: string; files: DirectUploadDescriptor[]; rejected?: UploadRejection[]; result?: unknown };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Storage PUTs in flight at once, across every file and part of one upload. One stream is usually limited by round trips and the
 * TCP window rather than the uplink, so a few parallel transfers fill the link; on a saturated uplink they share it. Bodies are
 * file-backed blob slices, so memory does not grow with the limit.
 */
function uploadConcurrency(): number {
  const raw = Number(process.env.DOCSLURP_UPLOAD_CONCURRENCY ?? 6);
  return Number.isInteger(raw) && raw >= 1 && raw <= 32 ? raw : 6;
}

function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try { return await task(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

/** Runs `task` over `items` at most `limit` at a time. After the first failure no new item starts; it waits for those in flight, then throws that failure. */
async function forEachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try { await task(item); } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw (failure as { error: unknown }).error;
}

const storageSlot = limiter(uploadConcurrency());
/** `files/complete` and `confirm` take the session's lock, so this upload sends them one at a time. */
const sessionSlot = limiter(1);

/**
 * The 409 code of a session-locked request: `upload_session_busy` when someone else holds the session's lock (the server's
 * reconciler finalizing the session, or another request of this upload). Older servers send the generic `conflict` for that and
 * for real conflicts alike, with a generic public message, so the caller asks the session which one it was.
 */
async function conflictCode(response: Response): Promise<string | null> {
  if (response.status !== 409) return null;
  try {
    const body = await response.clone().json() as { code?: unknown; error?: { code?: unknown } | unknown };
    const code = (body.error && typeof body.error === "object" ? (body.error as { code?: unknown }).code : undefined) ?? body.code;
    return typeof code === "string" ? code : "conflict";
  } catch {
    return "conflict";
  }
}

/** What the session says about an uncoded 409: the request already took effect, a repeat may succeed, or it is a real failure. */
type SessionProbe = () => Promise<Response | "retry" | "fail">;

/**
 * Sends a session-locked request (`files/complete`, `confirm`; both idempotent, so a repeat is safe) one at a time per upload.
 * It waits out a busy lock and rate limiting with backoff, and asks `probe` about an uncoded 409 from an older server.
 */
async function sendWhenSessionFree(send: () => Promise<Response>, flags: Record<string, string | boolean>, probe: SessionProbe, transient400 = 0): Promise<Response> {
  // How long to wait out a held lock: --timeout when given, else a minute. A direct upload that is still locked out after
  // that hands the rest to the server's reconciler (sessionCompleter), so a long wait buys nothing.
  const waitMs = Number(flags.timeout) > 0 ? Number(flags.timeout) * 1000 : 60_000;
  const giveUpAt = Date.now() + waitMs;
  let bad400 = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await sessionSlot(send);
    const backoff = Math.min(2_000, 200 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random() / 2);
    let waitMs: number;
    if (response.status === 429) {
      waitMs = Math.max(backoff, Math.min(30, retryAfterSeconds(response.headers.get("retry-after")) ?? 1) * 1000);
    } else {
      // An older server reports a transient storage failure while finalizing as a generic 400. Up to `transient400` times,
      // ask the session: a file still pending in an open session is worth another try.
      const code = response.status === 400 && bad400 < transient400 ? (bad400++, "conflict") : await conflictCode(response);
      if (code === null || (code !== "upload_session_busy" && code !== "conflict")) return response;
      if (code === "conflict") {
        const verdict = await probe().catch(() => "retry" as const);
        if (verdict instanceof Response) { await response.body?.cancel(); return verdict; }
        if (verdict === "fail") return response;
      }
      waitMs = backoff;
    }
    if (Date.now() + waitMs >= giveUpAt) return response;
    await response.body?.cancel();
    await sleepMs(waitMs);
  }
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
      const response = await storageSlot(() => fetch(url, {
        method: "PUT", body, headers: contentType ? { "Content-Type": contentType } : undefined,
        signal: AbortSignal.timeout(Math.ceil(Math.max(60_000, 30_000 + (body.size / 100_000) * 1000))),
      }));
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
async function sendFile(descriptor: DirectUploadDescriptor, blob: Blob, signParts?: (partNumbers: number[]) => Promise<Array<{ partNumber: number; url: string }>>): Promise<Record<string, unknown>> {
  if (descriptor.mode === "single") {
    const etag = await putToStorage(descriptor.putUrl ?? "", blob, descriptor.mimeType);
    return { fileId: descriptor.id, ...(etag ? { etag } : {}) };
  }
  const parts: Array<{ partNumber: number; etag: string }> = [...(descriptor.completedParts ?? [])];
  const pending = descriptor.pendingParts ?? [];
  // Parts the session described without a URL are signed through parts/sign, 100 at a time.
  const urls = new Map(pending.flatMap((part) => part.url ? [[part.partNumber, part.url] as const] : []));
  const unsigned = pending.filter((part) => !part.url).map((part) => part.partNumber);
  for (let start = 0; start < unsigned.length; start += 100) {
    if (!signParts) throw new Error(`No upload URL for ${descriptor.filename} part ${unsigned[start]}`);
    for (const part of await signParts(unsigned.slice(start, start + 100))) urls.set(part.partNumber, part.url);
  }
  let sent = 0;
  // Parts share the upload's storage slots. A failed part stops new ones and waits for those in flight, so a resume never
  // races a PUT of the same part.
  await forEachLimited(pending, uploadConcurrency(), async (part) => {
    const start = (part.partNumber - 1) * (descriptor.partSize ?? part.sizeBytes);
    const url = urls.get(part.partNumber);
    if (!url) throw new Error(`No upload URL for ${descriptor.filename} part ${part.partNumber}`);
    const etag = await putToStorage(url, blob.slice(start, start + part.sizeBytes));
    if (!etag) throw new Error(`Storage returned no ETag for ${descriptor.filename} part ${part.partNumber}`);
    parts.push({ partNumber: part.partNumber, etag });
    console.error(`Uploaded ${descriptor.filename} part ${part.partNumber} (${++sent}/${pending.length})`);
  });
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
async function pollConfirmedSession(sessionPath: string, flags: Record<string, string | boolean>, minWaitMs = 60_000, intervalMs = 1000): Promise<Response | null> {
  const stopAt = Date.now() + Math.max(minWaitMs, Number(flags.timeout ?? 30) * 1000);
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
    await sleepMs(intervalMs);
  }
  return null;
}

/** A coded busy session or a rate limit that outlasted our waits: nothing failed, the server just did not answer in time. */
function isBusyFailure(error: unknown): boolean {
  return error instanceof CliApiError && (error.status === 429 || (error.status === 409 && error.failure.code === "upload_session_busy"));
}

/** A server answer that names one remote file twice cannot be matched to local bytes: refuse it before anything moves. */
function assertUniqueRemoteIds(ids: ReadonlyArray<string | undefined>, what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id) throw new Error(`Upload ${what} names a file without an id`);
    if (seen.has(id)) throw new Error(`Upload ${what} names file ${id} more than once`);
    seen.add(id);
  }
}

/**
 * The one descriptor for the original's id in a refreshed read, checked against the descriptor the local bytes were
 * matched to (id, mode, size, and request index and client id where the original had them), so bytes never go to
 * another file's targets.
 */
function refreshedDescriptor(files: readonly DirectUploadDescriptor[], original: DirectUploadDescriptor): DirectUploadDescriptor | undefined {
  const matches = files.filter((file) => file.id === original.id);
  if (matches.length > 1) throw new Error(`Upload session names file ${original.id} more than once`);
  const fresh = matches[0];
  if (!fresh) return undefined;
  const same = fresh.mode === original.mode && fresh.sizeBytes === original.sizeBytes
    && (original.index == null || fresh.index === original.index)
    && (original.clientId == null || fresh.clientId === original.clientId);
  if (!same) throw new Error(`Upload session describes ${original.filename} differently than before; not sending its bytes`);
  return fresh;
}

/**
 * Files a large session's read did not inspect (`inspected: false`): completed in batches of up to 100, so storage
 * decides which still need bytes, then ONE `fileId` read per batch describes those. Only the explicit codes
 * `upload_object_missing` and `upload_parts_incomplete` mean "send the bytes"; anything else is a failure. Only a coded
 * busy session or a rate limit is waited out (an uncoded 409 is an answer: the probe says "fail").
 */
async function settleUninspected(sessionPath: string, uninspected: DirectUploadDescriptor[], flags: Record<string, string | boolean>): Promise<Map<string, DirectUploadDescriptor>> {
  const resend = new Map<string, DirectUploadDescriptor>();
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answerOnly: SessionProbe = async () => "fail";
  for (let start = 0; start < uninspected.length; start += COMPLETE_BATCH_MAX) {
    const chunk = uninspected.slice(start, start + COMPLETE_BATCH_MAX);
    const done = await sendWhenSessionFree(() => apiFetchRepeatable(`${sessionPath}/files/complete`, flags, post({ files: chunk.map((file) => ({ fileId: file.id })) })), flags, answerOnly);
    if (!done.ok) throw await responseFailure(done);
    const answer = await done.json() as { files?: Array<{ fileId?: string; status?: string; error?: { code?: string; message?: string } }> };
    if (!Array.isArray(answer.files)) throw new Error("Unexpected completion response");
    assertUniqueRemoteIds(answer.files.map((result) => result.fileId), "completion result");
    const byId = new Map(answer.files.map((result) => [result.fileId, result]));
    const missing: string[] = [];
    for (const file of chunk) {
      const result = byId.get(file.id);
      if (result?.status === "completed") continue;
      if (result?.error?.code && RESEND_COMPLETION_CODES.has(result.error.code)) { missing.push(file.id); continue; }
      throw new Error(`${file.filename}: ${result?.error?.message ?? "not completed"} (${result?.error?.code ?? "missing result"})`);
    }
    if (missing.length === 0) continue;
    const query = missing.map((id) => `fileId=${encodeURIComponent(id)}`).join("&");
    const refreshed = await sendWhenSessionFree(() => apiFetchRepeatable(`${sessionPath}?${query}`, flags, {}), flags, answerOnly);
    if (!refreshed.ok) throw await responseFailure(refreshed);
    const state = await refreshed.json() as DirectSession;
    if (["failed", "aborted", "expired"].includes(String(state.status ?? ""))) throw new Error(`Upload session ${String(state.status)}`);
    for (const id of missing) {
      const original = chunk.find((file) => file.id === id)!;
      const name = original.filename;
      const fresh = refreshedDescriptor(state.files, original);
      if (!fresh) throw new Error(`Upload session no longer has ${name}`);
      if (fresh.status === "completed") continue;
      if (fresh.status === "failed" || fresh.status === "aborted") throw new Error(`Upload of ${name} ${fresh.status}`);
      resend.set(id, fresh);
    }
  }
  return resend;
}

/** files/complete's answers that mean the file's bytes (or some parts) are not in storage: upload them, then complete. */
const RESEND_COMPLETION_CODES = new Set(["upload_object_missing", "upload_parts_incomplete"]);

/** Files one `files/complete` call finalizes on a server with batch completion. */
const COMPLETE_BATCH_MAX = 100;

/**
 * Completes the files of one upload session. Files that finish while a complete call is in flight go together in the next
 * call as one batch (`{ files: [...] }`, up to 100), so a 1,000-file upload needs about ten calls instead of a thousand. A file
 * the server reports as retryable (a storage outage) is sent again; a session-level 409 or 429 is waited out. An older server
 * refuses the batch body with 400; from then on each file is completed on its own, as before.
 */
function sessionCompleter(sessionPath: string, flags: Record<string, string | boolean>) {
  type Pending = { body: Record<string, unknown>; tries: number; resolve: () => void; reject: (error: unknown) => void };
  const queue: Pending[] = [];
  let batched: boolean | null = null; // unknown until the first batch call answers
  let draining: Promise<void> | null = null;
  // Set when the server's reconciler keeps the session lock past our deadline: it finalizes and confirms the session itself,
  // so we stop completing and wait for its result instead of abandoning the upload.
  let handedOver = false;
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const fileOf = (body: Record<string, unknown>) => String(body.fileId);

  /** An older server's uncoded 409: ask the session whether the file is done, worth retrying, or a real failure. */
  const probeFor = (fileIds: string[]): SessionProbe => async () => {
    // The status-only read takes no session lock (the full one signs URLs under the lock, so it is busy whenever we are).
    const refreshed = await apiFetchRepeatable(`${sessionPath}?statusOnly=true`, flags, {});
    // A rate-limited, busy or unavailable read says nothing about the session: ask again later.
    if (refreshed.status === 429 || refreshed.status === 409 || refreshed.status >= 500) { await refreshed.body?.cancel(); return "retry"; }
    if (!refreshed.ok) return "fail";
    const state = await refreshed.json() as DirectSession;
    if (fileIds.every((id) => state.files.find((file) => file.id === id)?.status === "completed")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return ["pending", "uploading"].includes(String(state.status ?? "pending")) ? "retry" : "fail";
  };

  /** Still locked out after the deadline, yet the session is open: leave the rest to the server (see `handedOver`). */
  async function handOverIfOpen(response: Response, fileIds: string[]): Promise<boolean> {
    if (response.status !== 409 || await probeFor(fileIds)() !== "retry") return false;
    await response.body?.cancel();
    if (!handedOver) console.error("The server is busy finalizing this upload; leaving the remaining files to it and waiting for its run.");
    handedOver = true;
    return true;
  }

  async function completeOne(item: Pending): Promise<void> {
    const done = await sendWhenSessionFree(() => apiFetchRepeatable(`${sessionPath}/files/complete`, flags, json(item.body)), flags, probeFor([fileOf(item.body)]), 3);
    if (done.ok || await handOverIfOpen(done, [fileOf(item.body)])) return;
    throw await responseFailure(done);
  }

  async function completeBatch(items: Pending[]): Promise<void> {
    const response = await sendWhenSessionFree(
      // A batch entry carries the file id and its single-PUT etag only: the server reads a multipart file's parts from storage.
      () => apiFetchRepeatable(`${sessionPath}/files/complete`, flags, json({ files: items.map(({ body }) => ({ fileId: body.fileId, ...(body.etag ? { etag: body.etag } : {}) })) })),
      flags, probeFor(items.map((item) => fileOf(item.body))), batched === true ? 3 : 0);
    if (batched === null && response.status === 400) {
      // No batch support: settle these one by one, and every later file too.
      await response.body?.cancel();
      batched = false;
      for (const item of items) await completeOne(item).then(item.resolve, item.reject);
      return;
    }
    if (!response.ok) {
      if (await handOverIfOpen(response, items.map((item) => fileOf(item.body)))) { for (const item of items) item.resolve(); return; }
      const failure = await responseFailure(response);
      for (const item of items) item.reject(failure);
      return;
    }
    const answer = await response.json() as { files?: Array<{ fileId?: string; status?: string; error?: { statusCode?: number; code?: string; message?: string; retryable?: boolean } }> };
    batched = true;
    if (!Array.isArray(answer.files)) {
      // A probe that found every file completed answers `{ ok: true }` without per-file results.
      for (const item of items) item.resolve();
      return;
    }
    // One result per file sent, each named once: anything else is not this batch's answer.
    assertUniqueRemoteIds(answer.files.map((result) => result.fileId), "completion result");
    const sent = new Set(items.map((item) => fileOf(item.body)));
    if (answer.files.some((result) => !sent.has(String(result.fileId)))) throw new Error("Upload completion result names a file this call did not send");
    const byId = new Map(answer.files.map((result) => [result.fileId, result]));
    for (const item of items) {
      const result = byId.get(fileOf(item.body));
      if (result?.status === "completed") item.resolve();
      else if (result?.error?.retryable && item.tries < 4) { item.tries++; queue.push(item); }
      else item.reject(new Error(`${String(item.body.fileId)}: ${result?.error?.message ?? "not completed"} (${result?.error?.code ?? "missing result"})`));
    }
    if (queue.some((item) => item.tries > 0)) await sleepMs(1_000);
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      if (handedOver) { for (const item of queue.splice(0)) item.resolve(); break; }
      if (batched === false) {
        const item = queue.shift()!;
        await completeOne(item).then(item.resolve, item.reject);
        continue;
      }
      const items = queue.splice(0, COMPLETE_BATCH_MAX);
      // An unexpected failure (a lost response after retries) fails what this call carried; settled items ignore it.
      await completeBatch(items).catch((error) => { for (const item of items) item.reject(error); });
    }
  }

  /** One drain at a time; a file queued while the last drain was finishing starts the next. */
  function kick(): void {
    draining ??= drain().finally(() => { draining = null; if (queue.length > 0) kick(); });
  }

  return {
    get handedOver(): boolean { return handedOver; },
    complete(body: Record<string, unknown>): Promise<void> {
      return new Promise<void>((resolve, reject) => { queue.push({ body, tries: 0, resolve, reject }); kick(); });
    },
  };
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
    const completer = sessionCompleter(sessionPath, flags);
    // Match every descriptor before sending anything, so an unknown file fails the upload before any bytes move.
    assertUniqueRemoteIds(session.files.map((file) => file.id), "session");
    const work = session.files.map((first) => {
      const match = localFileFor(first, files, claimed);
      if (!match) throw new Error(`Upload session returned a file this upload did not send: ${first.filename}`);
      return { first, match };
    });
    // Uninspected files (a large session's replayed read) are settled first, in batches: only those storage reports
    // missing are read again and sent.
    const resend = await settleUninspected(sessionPath, work.filter(({ first }) => first.inspected === false).map(({ first }) => first), flags);
    // Files go up a few at a time; each one is completed as soon as its bytes are in storage.
    await forEachLimited(work, uploadConcurrency(), async ({ first, match }) => {
      const target = first.inspected === false ? resend.get(first.id) : first;
      // An uninspected file whose stored object completed it needs nothing more.
      if (!target) return;
      let descriptor: DirectUploadDescriptor = target;
      let complete: Record<string, unknown> | null = null;
      for (let round = 0; complete === null; round++) {
        try {
          const fileId = descriptor.id;
          complete = await sendFile(descriptor, match.file.blob, async (partNumbers) => {
            const signed = await sendWhenSessionFree(() => apiFetchRepeatable(`${sessionPath}/files/${encodeURIComponent(fileId)}/parts/sign`, flags,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partNumbers }) }), flags, async () => "retry");
            if (!signed.ok) throw await responseFailure(signed);
            return ((await signed.json()) as { parts: Array<{ partNumber: number; url: string }> }).parts;
          });
        } catch (error) {
          if (round >= 2 || !(isLostResponse(error) || (error instanceof CliApiError && (error.status === 403 || RETRYABLE_STATUSES.has(error.status))))) throw error;
          // Resume from what storage holds: the session lists the parts still missing, with fresh signed URLs.
          await sleepMs(250 * 2 ** round);
          // The full read signs fresh URLs under the session lock: wait out a busy lock or a rate limit.
          // Only this file: on a large session the full read inspects far fewer stored objects (server `fileId` filter).
          const refreshed = await sendWhenSessionFree(() => apiFetchRepeatable(`${sessionPath}?fileId=${encodeURIComponent(descriptor.id)}`, flags, {}), flags, async () => "retry");
          if (!refreshed.ok) throw error;
          // The refreshed targets must belong to the same file the local bytes were matched to.
          const next = refreshedDescriptor(((await refreshed.json()) as DirectSession).files, descriptor);
          if (!next) throw error;
          if (next.status === "completed") { complete = { fileId: descriptor.id }; break; }
          if (next.status === "failed" || next.status === "aborted") throw new Error(`Upload of ${descriptor.filename} ${next.status}`);
          descriptor = next;
        }
      }
      await completer.complete(complete);
    });
    let confirmed: Response | null;
    if (completer.handedOver) {
      // The server finalizes the files we could not complete and confirms the session itself: wait for its run.
      confirmed = await pollConfirmedSession(sessionPath, flags, 30 * 60_000, 3000);
      if (!confirmed) throw new Error(`The server did not finish this upload in time; its session is ${session.sessionId} (check it with the status of that session).`);
    } else try {
      confirmed = await sendWhenSessionFree(() => apiFetch(`${sessionPath}/confirm`, flags, { method: "POST" }), flags, async () => {
        // The reconciler may be confirming this session itself: its result is the answer. A closed session is a real failure.
        const status = await apiFetchRepeatable(`${sessionPath}?statusOnly=true`, flags, {});
        if (status.status === 429 || status.status === 409 || status.status >= 500) { await status.body?.cancel(); return "retry"; }
        if (!status.ok) return "fail";
        const state = await status.json() as { status?: string; result?: unknown };
        if (state.result) return new Response(JSON.stringify(state.result), { status: 201, headers: { "content-type": "application/json" } });
        return ["pending", "uploading", "ingesting"].includes(String(state.status ?? "")) ? "retry" : "fail";
      });
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
    // Like the SDK: a session that stayed busy (or rate limited) past our waits is kept (and named), since the server
    // finishes the known-size files whose bytes arrived; any other failure closes it, best effort.
    if (isBusyFailure(error)) {
      console.error(`Upload session ${session.sessionId} stayed busy; the server finishes its uploaded files.`);
    } else {
      await apiFetch(`${sessionPath}/abort`, flags, { method: "POST" }).catch(() => undefined);
    }
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
    const visuals = resolveVisualsFlag(flags);
    const quality = resolveQualityPipeline(flags).pipeline?.quality;
    await runEstimate("/v1/uploads/estimate", { files: estimateFiles, ...(target.project ? { project: target.project } : {}), ...(visuals ? { visuals } : {}), ...(quality ? { settings: { quality } } : {}) }, flags);
    return;
  }

  const formData = new FormData();
  for (const [name, value] of Object.entries(intake.fields)) formData.append(name, String(value));

  const target = resolveIntakeTarget(flags);
  if (target.project) formData.append("project", target.project);
  if (target.newProject) formData.append("newProject", "true");
  if (target.templateKey) formData.append("templateKey", target.templateKey);
  const intakePipeline = resolveIntakePipeline(flags).pipeline;
  if (intakePipeline) formData.append("pipeline", JSON.stringify(intakePipeline));
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
  if (totalBytes > DIRECT_UPLOAD_THRESHOLD_BYTES && blobs.length > DIRECT_SESSION_MAX_FILES) {
    await uploadDirectInSessions(blobs, formData, flags, intake);
    return;
  }
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

/**
 * More files than one session takes: one session (and run) per 1,000 files, in order. A session that fails is reported and the
 * rest still go up, so good files are never held back by bad ones; the command fails only when no session was created.
 * Each session gets its own Idempotency-Key, derived from --idempotency-key when one was given, so a rerun repeats no session.
 */
async function uploadDirectInSessions(blobs: Array<{ blob: Blob; name: string }>, fields: FormData, flags: Record<string, string | boolean>, intake: IntakeMode): Promise<void> {
  const count = Math.ceil(blobs.length / DIRECT_SESSION_MAX_FILES);
  const baseKey = typeof flags.idempotencyKey === "string" && flags.idempotencyKey ? flags.idempotencyKey.slice(0, 240) : randomUUID();
  const failed: string[] = [];
  for (let index = 0; index < count; index++) {
    const slice = blobs.slice(index * DIRECT_SESSION_MAX_FILES, (index + 1) * DIRECT_SESSION_MAX_FILES);
    const label = `Session ${index + 1}/${count} (${slice.length} files: ${slice[0]!.name} … ${slice.at(-1)!.name})`;
    console.error(`${label}: uploading`);
    try {
      const response = await uploadDirect(slice, fields, { ...flags, idempotencyKey: `${baseKey}.${index + 1}` }, intake);
      if (!response.ok) {
        printFailure(await responseFailure(response));
        failed.push(label);
        continue;
      }
      await printIntakeResult(response, flags);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      failed.push(label);
    }
  }
  if (failed.length > 0) {
    console.error(`Warning: ${failed.length} of ${count} upload sessions failed; their files were not uploaded:\n  ${failed.join("\n  ")}`);
    if (failed.length === count) process.exitCode = 1;
  }
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
  const visuals = resolveVisualsFlag(flags);
  if (visuals) settings.visuals = visuals;
  const body = { files: await profiledEstimateFiles(files), ...(Object.keys(settings).length ? { settings } : {}) };
  const base = (typeof flags.apiUrl === "string" ? flags.apiUrl : process.env.DOCSLURP_API_URL ?? "https://docslurp.io").replace(/\/$/, "");
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
  console.log(`Pricing:   ${quote.pricingVersion}, re-quote after ${quote.validUntil} (prices may change without notice)`);
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
  printDeprecationWarnings(result);
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

/** `on`/`off` (or true/false) for a reindex switch; anything else is refused. */
function onOff(flag: string, value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error(`--${flag} must be on or off.`);
}

/** The reindex body: the index settings the flags change (none: a plain rebuild) and the confirmed estimate signature. */
export function reindexBody(flags: Record<string, string | boolean>): { pipeline?: Record<string, unknown>; confirmEstimate?: string } {
  const pipeline: Record<string, unknown> = {};
  const embedding: Record<string, unknown> = {};
  if (typeof flags.embeddingProfile === "string" && flags.embeddingProfile) embedding.profile = flags.embeddingProfile;
  const late = onOff("late-chunking", flags.lateChunking);
  if (late !== undefined) embedding.lateChunking = late;
  if (flags.lateChunkingWindow !== undefined) {
    const window = Number(flags.lateChunkingWindow);
    if (!Number.isInteger(window) || window < 1 || window > 6) throw new Error("--late-chunking-window must be a whole number from 1 to 6.");
    embedding.lateChunkingWindow = window;
  }
  if (Object.keys(embedding).length) pipeline.embedding = embedding;
  if (flags.vectorBackends !== undefined) {
    const backends = String(flags.vectorBackends).split(",").map((name) => name.trim()).filter(Boolean);
    if (backends.length === 0) throw new Error("--vector-backends takes a comma-separated list, for example lancedb.");
    pipeline.vectorBackends = backends;
  }
  const overlap = onOff("chunk-overlap", flags.chunkOverlap);
  if (overlap !== undefined) pipeline.chunkOverlap = overlap;
  const preambles = onOff("contextual-preambles", flags.contextualPreambles);
  if (preambles !== undefined) pipeline.contextualChunkPreambles = preambles;
  return {
    ...(Object.keys(pipeline).length ? { pipeline } : {}),
    ...(typeof flags.confirm === "string" && flags.confirm ? { confirmEstimate: flags.confirm } : {}),
  };
}

/**
 * `docslurp reindex`: changes the project's locked index settings (embedding, chunking) and re-indexes its documents in
 * one step, or rebuilds the index as is. `--estimate` prices it and prints the signature to pass back with `--confirm`.
 */
async function reindexCommand(flags: Record<string, string | boolean>): Promise<void> {
  const base = `/v1/projects/${encodeURIComponent(resolveProject(flags))}/reindex`;
  const body = reindexBody(flags);
  if (flags.estimate === true) {
    const { confirmEstimate: _confirm, ...estimateBody } = body;
    const response = await apiFetch(`${base}/estimate`, flags, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(estimateBody) });
    if (!response.ok) {
      printFailure(await responseFailure(response));
      process.exitCode = 1;
      return;
    }
    const result = await response.json() as { estimate: CostEstimate | null; impact?: { kind: string }; lockedSettings?: string[]; signature?: string };
    if (flags.json === true) console.log(JSON.stringify(result, null, 2));
    else {
      if (result.lockedSettings?.length) console.log(`Changes:   ${result.lockedSettings.join(", ")}`);
      if (result.estimate) console.log(formatEstimate(result.estimate));
      else console.log("Nothing to re-index.");
      if (result.signature) console.log(`Signature: ${result.signature}\nRun the same command with --confirm ${result.signature} to start it; a changed estimate is refused.`);
      console.log("Estimate only: nothing was started.");
    }
    return;
  }
  const response = await apiFetch(base, flags, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    printFailure(await responseFailure(response));
    process.exitCode = 1;
    return;
  }
  const result = await response.json() as { changedSettings?: string[]; runIds?: string[]; job?: JobStatus | null };
  if (flags.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.changedSettings?.length ? `Changed:   ${result.changedSettings.join(", ")}` : "Rebuilding the index with the current settings.");
    if (result.job) printJob(result.job);
    else console.log("No documents to re-index; the settings apply to new uploads.");
  }
}

async function reprocessCommand(runId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  if (!runId) {
    console.error("Error: run ID required");
    process.exitCode = 1;
    return;
  }
  const base = `/v1/runs/${encodeURIComponent(runId)}/reprocess`;
  const visuals = resolveVisualsFlag(flags);
  const quality = resolveQualityPipeline(flags).pipeline?.quality;
  const body = {
    ...(typeof flags.stageFrom === "string" && flags.stageFrom ? { stageFrom: flags.stageFrom } : {}),
    ...(quality ? { quality } : {}),
    ...(visuals ? { visuals } : {}),
  };
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
  printDeprecationWarnings(result);
  if (flags.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    const runId = result.runId ?? result.id ?? result.run?.id;
    if (runId) console.log(`Run ID:    ${runId}`);
    if (result.job) printJob(result.job);
  }
  const runId = result.runId ?? result.id ?? result.run?.id;
  if (flags.watch === true && runId) await statusCommand(runId, flags);
}

type SummaryTreeJobView = {
  id: string; status: string; blockedReason: string | null; maxCostCents: number; costCents: number; costBasis?: "billed" | "provider";
  documentsTotal: number; documentsReady: number; documentsSkipped: number; documentsPartial: number;
  nodesBuilt: number; modelCalls: number; error: string | null; job?: JobStatus;
};

function printSummaryTreeJob(job: SummaryTreeJobView): void {
  const done = job.documentsReady + job.documentsSkipped + job.documentsPartial;
  console.log(`Job ${job.id}: summary-tree-backfill ${job.status}${job.blockedReason ? ` (${job.blockedReason})` : ""}`);
  console.log(`Documents: ${done} of ${job.documentsTotal} (${job.documentsReady} built, ${job.documentsSkipped} need no tree, ${job.documentsPartial} incomplete)`);
  console.log(`Summaries: ${job.nodesBuilt} sections, ${job.modelCalls} model calls`);
  console.log(`Spend:     ${job.costCents.toFixed(2)} of ${job.maxCostCents.toFixed(2)} cents (cap${job.costBasis === "billed" ? ", billed credits" : job.costBasis === "provider" ? ", model cost" : ""})`);
  if (job.error) console.log(`Note:      ${job.error}`);
}

/**
 * Summary tree backfill: builds the tree for a project's already indexed documents (turning the tree on only covers
 * new uploads). `backfill` needs --max-cost-cents: the job stops before the model call that would pass it.
 */
async function summaryTreeCommand(action: string | undefined, jobId: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  const base = `/v1/projects/${encodeURIComponent(resolveProject(flags))}/summary-tree/backfill`;
  const read = async (pathname: string, init?: RequestInit): Promise<unknown | null> => {
    const response = await apiFetch(pathname, flags, init);
    if (!response.ok) {
      printFailure(await responseFailure(response));
      process.exitCode = 1;
      return null;
    }
    return await response.json();
  };
  const post = { method: "POST", headers: { "Content-Type": "application/json" } };
  // Only `backfill` has an estimate; anywhere else the flag would run the command instead.
  if (flags.estimate === true && action !== "backfill") throw new Error("--estimate is only supported by summary-tree backfill.");
  if (action === "backfill") {
    if (flags.estimate === true) return runEstimate(`${base}/estimate`, {}, flags);
    const maxCostCents = Number(flags.maxCostCents);
    if (typeof flags.maxCostCents !== "string" || !Number.isFinite(maxCostCents) || maxCostCents <= 0) {
      throw new Error("--max-cost-cents is required: the most this backfill may spend, in cents. Use --estimate to see what it would cost.");
    }
    const job = await read(base, { ...post, body: JSON.stringify({ maxCostCents }) }) as SummaryTreeJobView | null;
    if (!job) return;
    if (flags.json === true) console.log(JSON.stringify(job, null, 2));
    else {
      printSummaryTreeJob(job);
      if (job.job?.estimate) console.log(formatEstimate(job.job.estimate));
    }
    if (flags.watch === true) await jobsCommand("watch", job.id, flags);
    return;
  }
  if (action === "status") {
    const status = await read(base) as { estimate: { documents: number; documentsToBuild: number; nodes: number } | null; activeJob: SummaryTreeJobView | null; lastJob: SummaryTreeJobView | null } | null;
    if (!status) return;
    if (flags.json === true) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (status.estimate) console.log(`Without a tree: ${status.estimate.documents} documents (${status.estimate.documentsToBuild} long enough to get one, about ${status.estimate.nodes} section summaries)`);
    else console.log("No estimate: this deployment has no price for the summary tree.");
    if (status.activeJob) printSummaryTreeJob(status.activeJob);
    else if (status.lastJob) printSummaryTreeJob(status.lastJob);
    else console.log("No backfill has run for this project.");
    return;
  }
  if (action === "cancel" && jobId) {
    const job = await read(`${base}/${encodeURIComponent(jobId)}/cancel`, { ...post, body: "{}" }) as SummaryTreeJobView | null;
    if (!job) return;
    if (flags.json === true) console.log(JSON.stringify(job, null, 2));
    else printSummaryTreeJob(job);
    return;
  }
  console.error("Usage: docslurp summary-tree backfill --max-cost-cents <n> | status | cancel <jobId>");
  process.exitCode = 1;
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
  // Every argument must be an http(s) URL, checked here before anything is sent (council #387 r3): a dash-led word such as
  // `-e` or `—estimate` is a mistyped flag, never a URL to ingest.
  assertIngestUrls(urls);
  if (flags.estimate === true) {
    // An estimate never starts an ingest (council #387 M1): sizes come from each URL's own headers, read from here.
    const files = await urlEstimateFiles(urls);
    const target = resolveIntakeTarget(flags);
    const visuals = resolveVisualsFlag(flags);
    const quality = resolveQualityPipeline(flags).pipeline?.quality;
    await runEstimate("/v1/uploads/estimate", { files, ...(target.project ? { project: target.project } : {}), ...(visuals ? { visuals } : {}), ...(quality ? { settings: { quality } } : {}) }, flags);
    return;
  }
  const response = await apiFetch(`${intake.base}/url`, flags, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls, ...resolveIntakeTarget(flags), ...resolveIntakePipeline(flags), ...intake.fields }),
  });
  if (!response.ok) {
    printFailure(await responseFailure(response));
    process.exitCode = 1;
    return;
  }
  await printIntakeResult(response, flags);
}

/** Hyphen, the Unicode dashes and minus signs: an argument that starts with one is a mistyped flag. */
const DASH_LED = /^[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/;

/** Throws unless every argument is an absolute http(s) URL with a host and no credentials. */
export function assertIngestUrls(urls: readonly string[]): void {
  for (const raw of urls) {
    if (DASH_LED.test(raw)) throw new Error(`${raw} looks like a flag, not a URL. Flags start with two ASCII hyphens (--estimate); run docslurp --help.`);
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`${raw} is not a URL. ingest-url takes http(s) URLs.`); }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) throw new Error(`${raw} is not an http(s) URL.`);
    if (url.username || url.password) throw new Error(`${url.protocol}//${url.host}: URLs with credentials are not accepted.`);
  }
}

/**
 * Estimate inputs for URLs: name from the path, size and type from a HEAD request (redirects followed, 15 s each). A URL
 * that reports no usable size cannot be estimated: the command fails before any request to DocSlurp, rather than
 * guessing. The sizes are the server's own claim and only shape the estimate; the ingest is billed by what is measured.
 */
async function urlEstimateFiles(urls: string[]): Promise<Array<{ name: string; size: number; type?: string }>> {
  const files: Array<{ name: string; size: number; type?: string }> = [];
  for (const raw of urls) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`--estimate: ${raw} is not a URL.`); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`--estimate: ${raw} is not an http(s) URL.`);
    let response: Response;
    try {
      response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error(`--estimate: could not reach ${url.href} to read its size. Download it and run docslurp estimate <file>.`);
    }
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`--estimate: ${url.href} reports no size (HTTP ${response.status}). Download it and run docslurp estimate <file>.`);
    }
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "") || url.hostname;
    const type = response.headers.get("content-type")?.split(";")[0]?.trim();
    files.push({ name: name.slice(0, 255), size, ...(type ? { type } : {}) });
  }
  return files;
}

/** Commands that read `--estimate`; anywhere else the flag is refused, so it can never silently run billed work. */
const ESTIMATE_COMMANDS: ReadonlySet<string> = new Set(["upload", "ingest-url", "full-index", "reindex", "reprocess", "summary-tree"]);

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
  summaryTree?: { requested: string; applied: string; skipped?: string; ms: number };
  /** --summary-tree include: section summaries. Model-written, never passages. */
  summaries?: Array<{ kind: "summary"; filename: string; level: number; summary: string; pageStart: number | null; pageEnd: number | null }>;
};

/**
 * Text from a response, safe to print: no C0 or C1 control characters (ESC and CSI sequences would move the cursor,
 * recolor or retitle the terminal) and no bidirectional controls (they reorder what is read). Whitespace controls
 * become a space.
 */
export function printable(text: string): string {
  return String(text)
    .replace(/[\t\n\r\u000b\u000c\u0085\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Section summaries are printed apart from the passages and marked, so they are never read as quotes. */
function printSummaries(data: CliSearchResponse): void {
  if (data.summaryTree?.skipped) console.error(`Summary tree not used (${printable(data.summaryTree.skipped)}).`);
  if (!data.summaries?.length) return;
  console.log("\nSection summaries (model-written, not quotes):");
  for (const item of data.summaries) {
    const pages = item.pageStart == null ? "" : item.pageEnd != null && item.pageEnd !== item.pageStart ? ` (pp.${item.pageStart}-${item.pageEnd})` : ` (p.${item.pageStart})`;
    // Model-written text over document text, and a filename: neither reaches the terminal with a control character.
    console.log(`  [summary] ${printable(item.filename)}${pages}`);
    console.log(`     ${printable(item.summary).slice(0, 400)}`);
  }
}

function printSearch(data: CliSearchResponse, flags: Record<string, string | boolean>): void {
  if (data.availability?.message) console.error(data.availability.message);
  if (flags.context) {
    console.log(data.results.map((hit, index) => {
      const pages = hit.citation.pageNumbers?.length ? hit.citation.pageNumbers.join(", ") : hit.citation.pageNumber;
      const source = [hit.citation.filename, pages == null ? undefined : `pages ${pages}`, hit.citation.documentId ? `document ${hit.citation.documentId}` : undefined].filter(Boolean).join(" · ");
      return `[${index + 1}] ${source}\n${hit.text}`;
    }).join("\n\n"));
    printSummaries(data);
    return;
  }
  if (!data.results.length) { console.log(data.noMatch ? "No relevant match found. Lower --min-score (0 disables the floor) to see weaker passages." : "No results found."); printSummaries(data); return; }
  for (const [index, hit] of data.results.entries()) {
    const page = hit.citation.pageNumbers?.length ? hit.citation.pageNumbers.join(", ") : hit.citation.pageNumber ?? "-";
    console.log(`${String(index + 1).padStart(3)}. [${hit.score.toFixed(4)}] ${hit.citation.filename} (p.${page})`);
    console.log(`     ${hit.text.slice(0, 200).replace(/\n/g, " ")}`);
    if (index < data.results.length - 1) console.log("");
  }
  printSummaries(data);
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
  const mode = typeof flags.mode === "string" ? flags.mode.trim() : undefined;
  if (flags.mode !== undefined && !["keyword", "hybrid", "deep"].includes(mode ?? "")) throw new Error("--mode must be keyword, hybrid or deep.");
  const summaryTree = typeof flags.summaryTree === "string" ? flags.summaryTree.trim() : undefined;
  if (flags.summaryTree !== undefined && !["off", "guide", "include"].includes(summaryTree ?? "")) throw new Error("--summary-tree must be off, guide or include.");
  if (flags.stats && !flags.stream) throw new Error("--stats requires --stream.");
  if (flags.stream) {
    await searchStreamCommand({ q: query, ...(project ? { project } : {}), ...(minScore === undefined ? {} : { minScore }), ...(mode ? { mode } : {}), ...(summaryTree ? { summaryTree } : {}), ...(flags.stats ? { stats: true } : {}) }, flags);
    return;
  }
  const params = new URLSearchParams({ q: query, ...(project ? { project } : {}), ...(minScore === undefined ? {} : { minScore: String(minScore) }), ...(mode ? { mode } : {}), ...(summaryTree ? { summaryTree } : {}) });
  const response = await apiFetch(`/v1/search?${params.toString()}`, flags);
  if (!response.ok) throw await responseFailure(response);
  const data = await response.json() as CliSearchResponse;
  if (flags.json) console.log(JSON.stringify(data)); else printSearch(data, flags);
}


type CliSearchStreamEvent = { type: string; searchId?: string; seq?: number; elapsedMs?: number; [key: string]: unknown };

/** Complete SSE frames from a byte stream: handles CRLF, comments, split chunks and multi-line data. */
async function* sseFrames(body: AsyncIterable<Uint8Array>, maxFrameBytes = 1_048_576): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const frame = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n?/g, (m, offset, whole) => (m === "\r" && offset === whole.length - 1 ? m : "\n"));
    if (buffer.length > maxFrameBytes) throw new Error(`DocSlurp SSE frame exceeds ${Math.round(maxFrameBytes / 1_048_576)} MiB`);
    let split: number;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const parsed = frame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (parsed) yield parsed;
    }
  }
  const rest = frame(buffer.replace(/\r/g, "\n"));
  if (rest) yield rest;
}

/**
 * `search --stream`: prints each retrieval leg's hits to stderr as they land (completion order, provisional), then the final ranked list
 * to stdout exactly as without `--stream`. With `--json` stdout is one event per line (NDJSON), each event verbatim. A search is billed once
 * it has produced hits, so it falls back to `GET /v1/search` only when the stream never started: HTTP 404/405/406/501, a 2xx that is not an
 * event stream, or a connection failure before any response. After the first event a drop, a malformed or oversized frame, or a stream that
 * ends without `search.results` is an error and never a second search; a drop after `search.results` still prints the answer.
 */
async function searchStreamCommand(input: { q: string; project?: string; minScore?: number; mode?: string; summaryTree?: string; stats?: boolean }, flags: Record<string, string | boolean>): Promise<void> {
  const json = flags.json === true;
  const started = Date.now();
  let final: CliSearchResponse | undefined;
  let seq = 0;
  const emit = (event: CliSearchStreamEvent) => { if (json) console.log(JSON.stringify(event)); };
  const note = (line: string) => { if (!json) console.error(line); };
  const unavailable = (response: Response) => [404, 405, 406, 501].includes(response.status) || (response.ok && !response.headers.get("content-type")?.includes("text/event-stream"));
  const interrupted = (why: string) => new Error(`The search stream ${why} after it started. Not retried: a search is billed once it has produced hits. Run the search again.`);
  let fallbackReason: string | undefined;
  {
    let response: Response | undefined;
    try {
      response = await apiFetch("/v1/search/stream", flags, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(input),
      }, Number(flags.timeout ?? 120) * 1000);
    } catch (error) {
      // A connection failure before any response: the search never started.
      if (!(error instanceof TypeError)) throw error;
      fallbackReason = "could not connect to the stream endpoint";
    }
    if (response) {
      if (unavailable(response)) {
        await response.body?.cancel().catch(() => undefined);
        fallbackReason = "stream endpoint unavailable";
      } else if (!response.ok) throw await responseFailure(response);
      else if (!response.body) fallbackReason = "stream endpoint unavailable";
      else {
        let received = false;
        // The first leg and rank of each hit body already printed, for hits a later leg reports by id only.
        const printed = new Map<string, string>();
        try {
          for await (const frame of sseFrames(response.body as unknown as AsyncIterable<Uint8Array>, 32 * 1_048_576)) {
            received = true;
            let event: CliSearchStreamEvent;
            try { event = JSON.parse(frame.data); } catch { throw interrupted("sent a malformed event"); }
            if (!event || typeof event.type !== "string") continue;
            if (typeof event.seq === "number") seq = Math.max(seq, event.seq + 1);
            if (event.type === "search.error") {
              const error = event.error as { code?: string; status?: number } | undefined;
              const status = typeof error?.status === "number" ? error.status : 500;
              emit(event);
              throw new CliApiError(status, safeHttpFailure(status, { error: { code: error?.code } }));
            }
            if (event.type === "search.hits") {
              emit(event);
              const hits = (event.hits as Array<{ id: string; legRank: number; result?: CliSearchResponse["results"][number] }>) ?? [];
              const stats = event.stats as { ms?: number; candidates?: number; timedOut?: boolean } | undefined;
              const detail = flags.stats && stats ? ` ${stats.ms}ms${stats.candidates === undefined ? "" : `, ${stats.candidates} candidates`}${stats.timedOut ? ", timed out" : ""}` : "";
              const scope = typeof event.subSearch === "number" ? ` (sub-search ${event.subSearch + 1})` : "";
              note(`[${String(event.leg)}]${scope} ${hits.length} hit${hits.length === 1 ? "" : "s"}${event.truncated ? "+" : ""}${detail}`);
              for (const hit of hits) {
                if (!hit.result) {
                  note(`  ${String(event.leg)} #${hit.legRank + 1} also found by ${printed.get(hit.id) ?? "an earlier leg"}`);
                  continue;
                }
                const page = hit.result.citation.pageNumbers?.length ? hit.result.citation.pageNumbers.join(", ") : hit.result.citation.pageNumber ?? "-";
                if (!printed.has(hit.id)) printed.set(hit.id, `${String(event.leg)} #${hit.legRank + 1} (${hit.result.citation.filename}, p.${page})`);
                note(`  ${String(event.leg)} #${hit.legRank + 1} ${hit.result.citation.filename} (p.${page}) ${hit.result.text.slice(0, 100).replace(/\n/g, " ")}`);
              }
            } else if (event.type === "search.phase") {
              emit(event);
              const stats = event.stats as { ms?: number } | undefined;
              if (flags.stats) note(`[${String(event.phase)}] ${stats?.ms}ms`);
            } else if (event.type === "search.results") {
              emit(event);
              final = (event.response as CliSearchResponse);
            } else if (event.type === "search.started" || event.type === "search.done") {
              emit(event);
              if (event.type === "search.done" && flags.stats && event.timings) note(`timings: ${Object.entries(event.timings as Record<string, number>).map(([name, ms]) => `${name} ${ms}ms`).join(", ")}`);
            }
          }
          if (!final) {
            if (received) throw interrupted("ended without the final results");
            fallbackReason = "stream ended before any event";
          }
        } catch (error) {
          // The answer arrived: a later drop does not matter. Otherwise nothing is retried once the stream started.
          if (final) { /* print it below */ }
          else if (error instanceof CliApiError || (error instanceof Error && error.message.startsWith("The search stream "))) throw error;
          else if (received || (error instanceof Error && /exceeds \d+ MiB/.test(error.message))) throw interrupted(error instanceof Error && /exceeds \d+ MiB/.test(error.message) ? "sent an oversized event" : "dropped");
          else fallbackReason = "stream dropped before any event";
        }
      }
    }
  }
  if (!final) {
    note(`Falling back to the JSON search (${fallbackReason ?? "stream unavailable"}).`);
    const params = new URLSearchParams({ q: input.q, ...(input.project ? { project: input.project } : {}), ...(input.minScore === undefined ? {} : { minScore: String(input.minScore) }), ...(input.mode ? { mode: input.mode } : {}), ...(input.summaryTree ? { summaryTree: input.summaryTree } : {}) });
    const response = await apiFetch(`/v1/search?${params.toString()}`, flags);
    if (!response.ok) throw await responseFailure(response);
    final = await response.json() as CliSearchResponse;
    const sessionId = String((final as { sessionId?: unknown }).sessionId ?? "");
    const envelope = () => ({ searchId: `json-${sessionId}`, seq: seq++, elapsedMs: Date.now() - started });
    emit({ ...envelope(), type: "search.results", response: final });
    emit({ ...envelope(), type: "search.done", sessionId, resultCount: final.results.length });
  }
  if (!json) {
    if (flags.context !== true) console.log(flags.stats ? `\nFinal ranking (${Date.now() - started}ms):` : "\nFinal ranking:");
    printSearch(final, flags);
  }
}

const CHAT_TIERS = ["fastest", "balanced", "smart"] as const;

async function chatCommand(question: string, flags: Record<string, string | boolean>): Promise<void> {
  const project = resolveProject(flags);
  if (!question.trim()) throw new Error("Chat question required.");
  if (flags.context || flags.queriesFile || flags.concurrency) throw new Error("Chat accepts one question; batch/context options are for search.");
  if (flags.model !== undefined) throw new Error(`Chat models are managed by DocSlurp. Use --tier (${CHAT_TIERS.join(", ")}) instead of --model.`);
  const tier = flags.tier === undefined ? undefined : String(flags.tier);
  if (tier !== undefined && !(CHAT_TIERS as readonly string[]).includes(tier)) throw new Error(`--tier must be one of ${CHAT_TIERS.join(", ")}.`);
  const reasoning = flags.reasoning === undefined ? undefined : String(flags.reasoning);
  if (reasoning !== undefined && !["none", "minimal", "low", "medium", "high"].includes(reasoning)) throw new Error("--reasoning must be one of none, minimal, low, medium, high.");
  const response = await apiFetch("/v1/chat", flags, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: question, ...(project ? { project } : {}), ...(flags.session ? { sessionId: String(flags.session) } : {}), ...(tier ? { tier } : {}), ...(reasoning ? { reasoning } : {}) }),
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
  if (flags.estimate === true && !ESTIMATE_COMMANDS.has(command ?? "")) {
    throw new Error(`--estimate is not supported by ${command ?? "this command"}: it would run the command instead of estimating it. Commands with --estimate: ${[...ESTIMATE_COMMANDS].join(", ")}.`);
  }

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
    case "reindex":
      await reindexCommand(flags);
      break;
    case "reprocess":
      await reprocessCommand(positional[0], flags);
      break;
    case "summary-tree":
      await summaryTreeCommand(positional[0], positional[1], flags);
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
