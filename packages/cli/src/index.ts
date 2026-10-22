#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { openAsBlob } from "node:fs";
import { createInterface } from "node:readline";

const DEFAULT_API_URL = "https://docslurp.io";

function resolveApiUrl(flags: Record<string, string | boolean>): string {
  const value = String(flags.apiUrl ?? (process.env.DOCSLURP_URL?.trim() || DEFAULT_API_URL)).replace(/\/+$/, "");
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("API URL requires HTTPS; HTTP is allowed only on localhost for development.");
  return value;
}

/**
 * --workspace, then DOCSLURP_WORKSPACE, then "default" (the organization's
 * default workspace). A workspace is an ID, slug or name; names match by slug.
 */
function resolveWorkspace(flags: Record<string, string | boolean>): string {
  const explicit = typeof flags.workspace === "string" ? flags.workspace.trim() : "";
  return explicit || process.env.DOCSLURP_WORKSPACE?.trim() || "default";
}

type IntakeTarget = { newWorkspace: boolean; templateKey?: string; workspace?: string };

/**
 * Where an upload or URL ingest lands. --workspace wins: the server finds the
 * workspace by ID, slug or name, or creates it from the name (with --template
 * applied). Otherwise --new-workspace or --template creates a self-titled
 * workspace, and anything else goes to DOCSLURP_WORKSPACE or "default".
 */
function resolveIntakeTarget(flags: Record<string, string | boolean>): IntakeTarget {
  const templateKey = typeof flags.template === "string" && flags.template.trim() ? flags.template.trim() : undefined;
  const explicit = typeof flags.workspace === "string" ? flags.workspace.trim() : "";
  if (explicit) return { newWorkspace: false, workspace: explicit, templateKey };
  if (flags.newWorkspace === true || templateKey) return { newWorkspace: true, templateKey };
  return { newWorkspace: false, workspace: resolveWorkspace(flags) };
}

function usage(): void {
  console.log(`Usage:
  docslurp upload <files...> [--workspace <id|slug|name> | --new-workspace] [--template <key>] [--canonical-id <id>] [--path <folder>] [--estimate] [--watch] [--api-url <url>]
  docslurp ingest-url <urls...> [--workspace <id|slug|name> | --new-workspace] [--template <key>] [--watch] [--api-url <url>]
  docslurp full-index [--workspace <id|slug|name>] [--document <id>] [--estimate] [--watch]
  docslurp reprocess <runId> [--stage-from <stage>] [--estimate] [--watch]
  docslurp jobs get <jobId> [--json]
  docslurp jobs watch <jobId> [--timeout <seconds>]
  docslurp status <runId> [--api-url <url>] [--watch] [--timeout <seconds>]
  docslurp runs [--api-url <url>]
  docslurp search <query> [--workspace <id|slug|name>] [--min-score <0..1>] [--json | --context]
  docslurp search --queries-file <queries.json> [--workspace <id|slug|name>] [--concurrency <1..4>] [--json | --context]
  docslurp chat <question> [--workspace <id|slug|name>] [--session <id>] [--json]
  docslurp mcp-server [--api-url <url>] [--api-key <key>]
  docslurp --license
  docslurp migrate-algolia-synonyms <export.json> [--out <glossary.json>]
  docslurp import-search-compat <export.json> --workspace <id|slug|name> [--source <algolia|elastic|legacy-parser>] [--api-url <url>] [--api-key <key>] [--out <normalized.json>]

API commands require DOCSLURP_API_KEY or --api-key <key>.
DOCSLURP_URL overrides the hosted service. Without --workspace or DOCSLURP_WORKSPACE,
commands use the "default" workspace: your organization's default workspace.
--workspace takes a workspace ID, slug or name: "Legal Contracts" and legal-contracts are
the same workspace. Uploads and URL ingests into a name that matches no workspace create
it with that name (and --template, if given); other commands answer workspace not found.
--new-workspace (or --template alone) uploads into a fresh self-titled workspace.
--estimate prints the work estimate (pages, documents, credits, time) for the operation and exits without doing it.
Mutations that queue background work print their job; follow it with docslurp jobs watch <jobId>.
--watch waits up to five minutes by default; --timeout sets its limit.

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
  const workspace = resolveWorkspace(flags);
  if (!workspace) {
    throw new Error("--workspace is required");
  }

  const source = String(flags.source ?? detectCompatSource(payload));
  const normalized = normalizeCompatImportPayload({
    source,
    workspace,
    payload
  });

  if (typeof flags.out === "string" && flags.out) {
    await writeFile(String(flags.out), JSON.stringify(normalized, null, 2), "utf8");
    console.log(`Wrote normalized import payload to ${String(flags.out)}`);
  }

  const apiKey = String(flags.apiKey ?? process.env.DOCSLURP_API_KEY ?? "");
  if (!apiKey) {
    console.log(JSON.stringify(normalized, null, 2));
    console.log("Skipped API import because no --api-key or DOCSLURP_API_KEY was provided.");
    return;
  }

  const apiUrl = resolveApiUrl(flags);
  const response = await fetch(`${apiUrl}/compat/algolia/1/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(normalized)
  });

  if (!response.ok) {
    throw new Error(publicHttpError(response.status));
  }

  const result = await response.json() as { imported: Record<string, number> };
  console.log(`Imported ${source} compatibility payload into workspace ${workspace}.`);
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
  workspace: string;
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
      workspace: args.workspace,
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
      workspace: args.workspace,
      settings: args.payload.settings ?? {},
      synonyms: args.payload.synonyms ?? {},
      rules: args.payload.rules ?? [],
      schema: args.payload.schema ?? {},
      metadata: args.payload.metadata ?? {}
    };
  }

  return {
    source: "algolia",
    workspace: args.workspace,
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
    if (arg === "--watch" || arg === "--json" || arg === "--context" || arg === "--estimate") {
      flags[arg.slice(2)] = true;
      i++;
    } else if (arg === "--new-workspace") {
      flags.newWorkspace = true;
      i++;
    } else if (arg === "--workspace-name" || arg === "--workspace-id") {
      throw new Error(`${arg} was removed: pass a workspace ID, slug or name with --workspace (a name that matches no workspace is created on upload).`);
    } else if (arg === "--workspace" || arg === "--api-url" || arg === "--run" || arg === "--api-key" || arg === "--source" || arg === "--out" || arg === "--queries-file" || arg === "--concurrency" || arg === "--min-score" || arg === "--session" || arg === "--canonical-id" || arg === "--path" || arg === "--template" || arg === "--document" || arg === "--stage-from") {
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
  const apiKey = String(flags.apiKey ?? process.env.DOCSLURP_API_KEY ?? "");
  if (!apiKey) throw new Error("Set DOCSLURP_API_KEY or pass --api-key <key>.");
  const apiUrl = resolveApiUrl(flags);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return fetch(`${apiUrl}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(Math.max(1, Math.ceil(requestTimeoutMs))) });
}

/** Same threshold as the SDK's DIRECT_UPLOAD_THRESHOLD_BYTES. */
const DIRECT_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf", md: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html", csv: "text/csv",
  json: "application/json", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", epub: "application/epub+zip",
};

function mimeTypeForPath(filePath: string): string {
  return MIME_BY_EXTENSION[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

type DirectUploadDescriptor = {
  id: string; filename: string; mimeType: string; sizeBytes: number; mode: "single" | "multipart";
  putUrl?: string; partSize?: number; pendingParts?: Array<{ partNumber: number; sizeBytes: number; url: string }>;
};

async function putToStorage(url: string, body: Blob, contentType?: string): Promise<string | null> {
  // Presigned URL: never send the API key to storage.
  const response = await fetch(url, { method: "PUT", body, headers: contentType ? { "Content-Type": contentType } : undefined });
  if (!response.ok) throw new Error(publicHttpError(response.status));
  return response.headers.get("etag");
}

/** Create a direct upload session, PUT each file (or its parts), complete, then confirm. Returns the confirm response. */
async function uploadDirect(files: Array<{ blob: Blob; name: string }>, fields: FormData, flags: Record<string, string | boolean>): Promise<Response> {
  const field = (name: string) => (typeof fields.get(name) === "string" ? String(fields.get(name)) : undefined);
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await apiFetch("/v1/uploads/direct/sessions", flags, json({
    ...(field("workspace") ? { workspace: field("workspace") } : {}),
    ...(field("newWorkspace") === "true" ? { newWorkspace: true } : {}),
    ...(field("templateKey") ? { templateKey: field("templateKey") } : {}),
    files: files.map(({ blob, name }) => ({
      filename: name, mimeType: blob.type || mimeTypeForPath(name), sizeBytes: blob.size,
      ...(field("canonicalId") ? { canonicalId: field("canonicalId") } : {}),
      ...(typeof flags.path === "string" && flags.path ? { path: flags.path } : {}),
    })),
  }));
  if (!created.ok) return created;
  const session = await created.json() as { sessionId: string; files: DirectUploadDescriptor[] };
  const sessionPath = `/v1/uploads/direct/sessions/${encodeURIComponent(session.sessionId)}`;
  try {
    const remaining = [...files];
    for (const descriptor of session.files) {
      const at = remaining.findIndex((file) => file.name === descriptor.filename && file.blob.size === descriptor.sizeBytes);
      const source = at < 0 ? undefined : remaining.splice(at, 1)[0];
      if (!source) throw new Error(`Upload session returned an unknown file: ${descriptor.filename}`);
      let complete: Record<string, unknown>;
      if (descriptor.mode === "single") {
        const etag = await putToStorage(descriptor.putUrl ?? "", source.blob, descriptor.mimeType);
        complete = { fileId: descriptor.id, ...(etag ? { etag } : {}) };
      } else {
        const parts: Array<{ partNumber: number; etag: string }> = [];
        for (const part of descriptor.pendingParts ?? []) {
          const start = (part.partNumber - 1) * (descriptor.partSize ?? part.sizeBytes);
          const etag = await putToStorage(part.url, source.blob.slice(start, start + part.sizeBytes));
          if (!etag) throw new Error(`Storage returned no ETag for ${descriptor.filename} part ${part.partNumber}`);
          parts.push({ partNumber: part.partNumber, etag });
          console.error(`Uploaded ${descriptor.filename} part ${part.partNumber}/${(descriptor.pendingParts ?? []).length}`);
        }
        complete = { fileId: descriptor.id, parts };
      }
      const done = await apiFetch(`${sessionPath}/files/complete`, flags, json(complete));
      if (!done.ok) throw new Error(publicHttpError(done.status));
    }
    return await apiFetch(`${sessionPath}/confirm`, flags, { method: "POST" });
  } catch (error) {
    await apiFetch(`${sessionPath}/abort`, flags, { method: "POST" }).catch(() => undefined);
    throw error;
  }
}

async function uploadCommand(files: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (files.length === 0) {
    console.error("Error: at least one file path required");
    process.exitCode = 1;
    return;
  }

  if (flags.estimate === true) {
    const target = resolveIntakeTarget(flags);
    const sized = await Promise.all(files.map(async (filePath) => ({ name: basename(filePath), size: (await openAsBlob(filePath)).size })));
    await runEstimate("/v1/uploads/estimate", { files: sized, ...(target.workspace ? { workspace: target.workspace } : {}) }, flags);
    return;
  }

  const formData = new FormData();

  const target = resolveIntakeTarget(flags);
  if (target.workspace) formData.append("workspace", target.workspace);
  if (target.newWorkspace) formData.append("newWorkspace", "true");
  if (target.templateKey) formData.append("templateKey", target.templateKey);
  if (typeof flags.canonicalId === "string") {
    // Re-uploading with the same canonical ID replaces the previous version in search.
    if (files.length !== 1) throw new Error("--canonical-id applies to a single file.");
    formData.append("canonicalId", flags.canonicalId);
  }

  if (typeof flags.path === "string" && flags.path) {
    // Same folder path and filename re-uploaded in a workspace is a new version of one document.
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
  const response = totalBytes > DIRECT_UPLOAD_THRESHOLD_BYTES
    ? await uploadDirect(blobs, formData, flags)
    : await apiFetch("/v1/uploads/bulk", flags, {
      method: "POST",
      body: formData
    });

  if (!response.ok) {
    console.error(publicHttpError(response.status));
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

/** POSTs to a `…/estimate` route, prints the estimate (or raw JSON with --json) and leaves the operation undone. */
async function runEstimate(pathname: string, body: unknown, flags: Record<string, string | boolean>): Promise<void> {
  const response = await apiFetch(pathname, flags, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    console.error(publicHttpError(response.status));
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
  const base = document ? `/v1/documents/${encodeURIComponent(document)}/full-index` : `/v1/workspaces/${encodeURIComponent(resolveWorkspace(flags))}/full-index`;
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
    console.error(publicHttpError(response.status));
    process.exitCode = 1;
    return;
  }
  const result = await response.json() as { runId?: string; id?: string; job?: JobStatus };
  if (flags.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    const runId = result.runId ?? result.id;
    if (runId) console.log(`Run ID:    ${runId}`);
    if (result.job) printJob(result.job);
  }
  const runId = result.runId ?? result.id;
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
      console.error(publicHttpError(response.status));
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

type IntakeResult = { job?: JobStatus; run: { id: string }; workspace: { id: string; name: string; slug?: string }; documents: unknown[]; warnings?: string[] };

async function printIntakeResult(response: Response, flags: Record<string, string | boolean>): Promise<void> {
  const result = await response.json() as IntakeResult;
  console.log(`Workspace: ${result.workspace.name} (${result.workspace.slug ?? result.workspace.id})`);
  console.log(`Run ID:    ${result.run.id}`);
  console.log(`Documents: ${result.documents.length}`);
  if (result.job) printJob(result.job);
  for (const warning of result.warnings ?? []) console.error(`Warning: ${warning}`);
  if (flags.watch === true) await statusCommand(result.run.id, flags);
}

async function ingestUrlCommand(urls: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (urls.length === 0) {
    console.error("Error: at least one URL required");
    process.exitCode = 1;
    return;
  }
  const response = await apiFetch("/v1/uploads/url", flags, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls, ...resolveIntakeTarget(flags) }),
  });
  if (!response.ok) {
    console.error(publicHttpError(response.status));
    process.exitCode = 1;
    return;
  }
  await printIntakeResult(response, flags);
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
    if (watch && remainingMs <= 0) throw new Error(`Run ${runId} did not complete within ${timeoutSeconds}s; it may still be queued or processing.`);
    const response = await apiFetch(`/v1/runs/${encodeURIComponent(runId)}/progress`, flags, {}, watch ? Math.min(30_000, remainingMs) : Math.min(30_000, timeoutSeconds * 1000));

    if (!response.ok) {
      throw new Error(publicHttpError(response.status));
    }

    const snapshot = await response.json() as {
      run: {
        id: string;
        status: string;
        stage: string;
        controlState?: string | null;
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
      `Status:    ${run.controlState ?? run.status}`,
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

    const stopped = ["paused", "cancelled", "dead-letter"].includes(run.controlState ?? "");
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
  const response = await apiFetch("/v1/runs", flags);
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
  const workspace = resolveWorkspace(flags);
  if (flags.json && flags.context) throw new Error("Choose --json or --context.");
  if (flags.run) throw new Error("Search uses --workspace <id|slug|name>; --run is no longer supported.");
  if (flags.queriesFile) {
    if (query) throw new Error("Use a query or --queries-file, not both.");
    const inputs: unknown = JSON.parse(await readFile(String(flags.queriesFile), "utf8"));
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20) throw new Error("Queries file must contain a JSON array of 1–20 queries.");
    const queries = inputs.map((input) => {
      const value = typeof input === "string" ? { q: input } : input;
      if (!value || typeof value !== "object" || typeof value.q !== "string" || !value.q.trim()) throw new Error("Each query must be a nonempty string or an object with q.");
      const target = value.workspace ?? workspace;
      return typeof target === "string" && target.trim() ? { ...value, workspace: target } : value;
    });
    const concurrency = Number(flags.concurrency ?? 4);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("--concurrency must be an integer from 1 to 4.");
    const response = await apiFetch("/v1/search", flags, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries, concurrency }) });
    if (!response.ok) throw new Error(publicHttpError(response.status));
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
  const params = new URLSearchParams({ q: query, ...(workspace ? { workspace } : {}), ...(minScore === undefined ? {} : { minScore: String(minScore) }) });
  const response = await apiFetch(`/v1/search?${params.toString()}`, flags);
  if (!response.ok) throw new Error(publicHttpError(response.status));
  const data = await response.json() as CliSearchResponse;
  if (flags.json) console.log(JSON.stringify(data)); else printSearch(data, flags);
}

async function chatCommand(question: string, flags: Record<string, string | boolean>): Promise<void> {
  const workspace = resolveWorkspace(flags);
  if (!question.trim()) throw new Error("Chat question required.");
  if (flags.context || flags.queriesFile || flags.concurrency) throw new Error("Chat accepts one question; batch/context options are for search.");
  const response = await apiFetch("/v1/chat", flags, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: question, ...(workspace ? { workspace } : {}), ...(flags.session ? { sessionId: String(flags.session) } : {}) }),
  });
  if (!response.ok) throw new Error(publicHttpError(response.status));
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
  apiKey: string;
  pathname: string;
  method?: string;
  body?: unknown;
}): Promise<any> {
  const response = await fetch(`${args.apiUrl}${args.pathname}`, {
    method: args.method ?? "GET",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      ...(args.body ? { "Content-Type": "application/json" } : {})
    },
    ...(args.body ? { body: JSON.stringify(args.body) } : {})
  });
  if (!response.ok) throw new Error(publicHttpError(response.status));
  return await response.json();
}

async function mcpServerCommand(flags: Record<string, string | boolean>): Promise<void> {
  const apiUrl = resolveApiUrl(flags);
  const apiKey = String(flags.apiKey ?? process.env.DOCSLURP_API_KEY ?? "");
  if (!apiKey) throw new Error("MCP server mode requires --api-key or DOCSLURP_API_KEY.");
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let initialized = false;
  let ready = false;
  const get = (pathname: string) => mcpFetch({ apiUrl, apiKey, pathname });

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
          respond({ tools: result.tools.map((tool: any) => ({
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
          try {
            const result = await mcpFetch({ apiUrl, apiKey, pathname: `/v1/mcp/tools/${encodeURIComponent(name)}`, method: "POST", body: args });
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
          respond({ prompts: [{ name: "workspace-grounded-answer", title: "Workspace grounded answer", description: "Answer using workspace evidence and citations" }] });
          break;
        case "prompts/get": {
          if (envelope.params?.name !== "workspace-grounded-answer") { invalid("Unknown prompt name"); break; }
          const result = await get("/v1/mcp/prompts/workspace-grounded-answer");
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

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const { command, positional, flags } = parseCliArgs(args);

  switch (command) {
    case "upload":
      await uploadCommand(positional, flags);
      break;
    case "ingest-url":
      await ingestUrlCommand(positional, flags);
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
      await mcpServerCommand(flags);
      break;
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

/** HTTP bodies may come from a proxy; never display their diagnostic text. */
function publicHttpError(status: number): string {
  if (status === 401) return "Please sign in again or check your API key.";
  if (status === 403) return "You don’t have access to this action. Ask your workspace administrator for help.";
  if (status === 402 || status === 503) return "This feature is temporarily unavailable. Please try again later.";
  if (status === 404) return "We couldn’t find what you’re looking for. It may have been moved or removed.";
  if (status === 413) return "This file is too large. Please choose a smaller file and try again.";
  if (status === 429) return "Please wait a moment before trying again.";
  if (status >= 400 && status < 500) return "Please check your request and try again.";
  return "We couldn’t complete that request. Please try again in a moment.";
}
