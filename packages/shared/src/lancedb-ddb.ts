// Server-only. Lance's s3+ddb:// commit store: wiring for split credentials plus a counting DynamoDB re-signing proxy.
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import type { LanceDbConfig, LanceDdbConfig } from "./connection-uri.js";

/**
 * Lance (v13, @lancedb/lancedb 0.40) builds its DynamoDB client from the SAME storage options as its S3 client:
 * one credential set and one region, plus an optional `dynamodb_endpoint`. So when the data store (for example
 * Backblaze B2) and the commit table (AWS DynamoDB) use different credentials/regions, Lance is pointed at this
 * localhost proxy via `dynamodb_endpoint`; the proxy discards Lance's signature and re-signs each DynamoDB call
 * with the LANCEDB_DDB_* credentials and region. It also counts requests per operation (cost estimate).
 */

class NodeSha256 {
  private hash;
  constructor(private secret?: string | ArrayBuffer | ArrayBufferView) { this.hash = secret === undefined ? createHash("sha256") : createHmac("sha256", Buffer.from(secret as Uint8Array)); }
  update(data: string | ArrayBuffer | ArrayBufferView): void { this.hash.update(typeof data === "string" ? data : Buffer.from(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data))); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.hash.digest()); }
  reset(): void { this.hash = this.secret === undefined ? createHash("sha256") : createHmac("sha256", Buffer.from(this.secret as Uint8Array)); }
}

const DROPPED = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "expect", "authorization", "x-amz-date",
  "x-amz-security-token", "x-amz-content-sha256", "accept-encoding", "user-agent", "content-length"]);

export interface DdbCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface LanceDdbProxyOptions { region: string; credentials: DdbCredentials; endpoint?: string; log?: (line: string) => void; logIntervalMs?: number }
export interface LanceDdbProxy {
  endpoint: string;
  /** Requests by DynamoDB operation (GetItem, PutItem, Query, ...) and by HTTP status. */
  counts: { total: number; byOperation: Record<string, number>; byStatus: Record<string, number>; errors: number };
  close(): Promise<void>;
}

/** Re-signs one DynamoDB request (JSON protocol) for the real endpoint. */
export async function signDynamoRequest(
  method: string, path: string, incoming: Record<string, string | string[] | undefined>, body: Buffer,
  target: { protocol: "https:" | "http:"; hostname: string; port?: string; region: string }, credentials: DdbCredentials, now: Date = new Date(),
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { host: target.port ? `${target.hostname}:${target.port}` : target.hostname };
  for (const [name, value] of Object.entries(incoming)) {
    if (DROPPED.has(name.toLowerCase()) || value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  headers["content-length"] = String(body.length);
  const signer = new SignatureV4({ service: "dynamodb", region: target.region, sha256: NodeSha256 as never, credentials });
  const signed = await signer.sign({ method, protocol: target.protocol, hostname: target.hostname, port: target.port ? Number(target.port) : undefined, path, query: {}, headers, body }, { signingDate: now });
  return signed.headers as Record<string, string>;
}

export async function startLanceDdbProxy(options: LanceDdbProxyOptions): Promise<LanceDdbProxy> {
  const upstream = new URL(options.endpoint ?? `https://dynamodb.${options.region}.amazonaws.com`);
  const target = { protocol: upstream.protocol as "https:" | "http:", hostname: upstream.hostname, port: upstream.port || undefined, region: options.region };
  const agent = new HttpsAgent({ keepAlive: true, maxSockets: 128 });
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const counts: LanceDdbProxy["counts"] = { total: 0, byOperation: {}, byStatus: {}, errors: 0 };
  const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const operation = String(req.headers["x-amz-target"] ?? "Other").split(".").pop() ?? "Other";
    counts.total++;
    bump(counts.byOperation, operation);
    try {
      const headers = await signDynamoRequest(req.method ?? "POST", req.url ?? "/", req.headers, body, target, options.credentials);
      const out = send({ agent: target.protocol === "https:" ? agent : undefined, protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url ?? "/", headers }, (response) => {
        bump(counts.byStatus, `${operation}:${response.statusCode}`);
        if ((response.statusCode ?? 500) >= 500) counts.errors++;
        const outHeaders = { ...response.headers };
        delete outHeaders.connection; delete outHeaders["keep-alive"];
        res.writeHead(response.statusCode ?? 502, outHeaders);
        response.pipe(res);
      });
      out.on("error", (error) => { counts.errors++; bump(counts.byStatus, `${operation}:error`); if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end(`lancedb-ddb proxy upstream error: ${error.message}`); });
      out.end(body);
    } catch (error) {
      counts.errors++;
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`lancedb-ddb proxy error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const server: Server = createServer({ noDelay: true }, (req, res) => { void handle(req, res); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  const intervalMs = options.logIntervalMs ?? 60_000;
  const log = options.log ?? ((line: string) => console.log(line));
  let lastTotal = 0;
  const timer = intervalMs > 0 ? setInterval(() => {
    if (counts.total === lastTotal) return;
    lastTotal = counts.total;
    log(`[lancedb-ddb] total_requests=${counts.total} errors=${counts.errors} ops=${Object.entries(counts.byOperation).map(([k, v]) => `${k}=${v}`).join(",")} statuses=${Object.entries(counts.byStatus).map(([k, v]) => `${k}=${v}`).join(",")}`);
  }, intervalMs) : undefined;
  timer?.unref();
  server.unref();
  return {
    endpoint: `http://127.0.0.1:${port}`, counts,
    close: async () => { if (timer) clearInterval(timer); agent.destroy(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); },
  };
}

const proxies = new Map<string, Promise<LanceDdbProxy>>();

/** The most recently started proxy's counters (for tests and debug output). */
export async function lanceDdbProxyFor(ddb: LanceDdbConfig): Promise<LanceDdbProxy> {
  const key = JSON.stringify([ddb.region, ddb.endpoint ?? null, ddb.accessKeyId, ddb.secretAccessKey, ddb.sessionToken ?? null]);
  let proxy = proxies.get(key);
  if (!proxy) {
    proxy = startLanceDdbProxy({ region: ddb.region, endpoint: ddb.endpoint, credentials: { accessKeyId: ddb.accessKeyId ?? "", secretAccessKey: ddb.secretAccessKey ?? "", sessionToken: ddb.sessionToken } });
    proxy.catch(() => proxies.delete(key));
    proxies.set(key, proxy);
    void proxy.then((started) => console.log(`[lancedb-ddb] signing proxy ${started.endpoint} -> DynamoDB ${ddb.region} table ${ddb.table} (Lance reuses its S3 credentials for DynamoDB; the proxy re-signs)`));
  }
  return proxy;
}

/**
 * For s3+ddb:// roots: appends ?ddbTableName=<table> to the connect URI and, when separate DynamoDB credentials are
 * configured, points Lance's DynamoDB client at the re-signing proxy. Other URIs pass through unchanged.
 */
export async function withLanceDdb(uri: string, storageOptions: Record<string, string> | undefined, config: Pick<LanceDbConfig, "ddb"> = {}): Promise<{ uri: string; storageOptions: Record<string, string> | undefined }> {
  if (!uri.startsWith("s3+ddb://")) return { uri, storageOptions };
  const ddb = config.ddb;
  if (!ddb) throw new Error("s3+ddb:// LanceDB URI needs a DynamoDB table: set LANCEDB_DDB_TABLE or ?ddbTableName=");
  const connectUri = uri.includes("ddbTableName=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}ddbTableName=${encodeURIComponent(ddb.table)}`;
  if (!ddb.accessKeyId || !ddb.secretAccessKey) {
    return { uri: connectUri, storageOptions: ddb.endpoint ? { ...storageOptions, dynamodb_endpoint: ddb.endpoint } : storageOptions };
  }
  const proxy = await lanceDdbProxyFor(ddb);
  return { uri: connectUri, storageOptions: { ...storageOptions, dynamodb_endpoint: proxy.endpoint } };
}
