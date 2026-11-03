import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { parseRealtimeClientFrame, REALTIME_LIMITS as LIMITS, type RealtimeResource } from "@docslurp/shared";
import { RealtimeBroker, realtimeMetrics, realtimeCloseReasons, type RealtimeBackend } from "./broker.js";
import type { RealtimeOperationProvider } from "../services/realtime-operation.js";

export interface RealtimeSession { userId: string; sessionId: string }
export interface RealtimeHostOptions {
  enabled: boolean;
  allowedOrigins: readonly string[];
  authenticate(headers: Headers): Promise<RealtimeSession | null>;
  backend: RealtimeBackend;
  operations?: RealtimeOperationProvider;
  operationsForSession?: (headers: Headers, session: RealtimeSession) => RealtimeOperationProvider | undefined;
  /** Test/host injection; production defaults are the published limits. */
  authorizationRecheckMs?: number;
  reconcileMs?: number;
}
function headersFrom(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}
function reject(socket: Duplex, status: number) {
  realtimeMetrics.rejected++;
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
/** Attach to the actual standalone or Astro Node HTTP server before it listens.
 * The adapter owns only /v1/realtime; other upgrade handlers remain untouched.
 */
export function attachRealtimeServer(server: Server, options: RealtimeHostOptions) {
  const broker = new RealtimeBroker(options.backend, options.reconcileMs);
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frameBytes, perMessageDeflate: false });
  const epoch = randomUUID();
  const users = new Map<string, number>();
  const admissions = new Map<string, { started: number; count: number }>();
  let pending = 0;
  let draining = false;
  const controllers = new Set<AbortController>();
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(request.url ?? "", "http://realtime.invalid"); } catch { return; }
    if (url.pathname !== "/v1/realtime") return;
    // Upgrade authentication is asynchronous; a peer reset during that gap
    // must remain a transport close, never an unhandled socket error.
    socket.on("error", () => socket.destroy());
    if (!options.enabled || draining) return reject(socket, 503);
    const headers = headersFrom(request);
    const origin = headers.get("origin");
    if (request.method !== "GET" || url.search || !origin || origin === "null" ||
        !options.allowedOrigins.includes(origin) || headers.has("authorization") || headers.has("x-api-key") ||
        headers.has("sec-websocket-protocol")) return reject(socket, 403);
    if (pending + wss.clients.size >= 512) return reject(socket, 503);
    pending++;
    let settled = false;
    const finish = () => { settled = true; };
    const timeout = setTimeout(() => { finish(); reject(socket, 408); socket.destroy(); }, 5_000);
    socket.once("close", finish);
    void options.authenticate(headers).then(session => {
      if (settled || socket.destroyed) return;
      if (!session) { reject(socket, 401); return; }
      const now = Date.now();
      if (admissions.size >= 4_096) {
        for (const [id, window] of admissions) if (now - window.started >= 60_000) admissions.delete(id);
        if (admissions.size >= 4_096 && !admissions.has(session.userId)) { reject(socket, 503); return; }
      }
      let admission = admissions.get(session.userId);
      if (!admission || now - admission.started >= 60_000) {
        admission = { started: now, count: 0 }; admissions.set(session.userId, admission);
      }
      if (++admission.count > 40) { reject(socket, 429); return; }
      if ((users.get(session.userId) ?? 0) >= 8) { reject(socket, 429); return; }
      users.set(session.userId, (users.get(session.userId) ?? 0) + 1);
      let transferred = false;
      const releaseReservation = () => {
        if (transferred) return;
        transferred = true;
        const remaining = (users.get(session.userId) ?? 1) - 1;
        if (remaining > 0) users.set(session.userId, remaining); else users.delete(session.userId);
      };
      socket.once("close", releaseReservation);
      try {
        wss.handleUpgrade(request, socket, head, ws => {
          transferred = true;
          socket.removeListener("close", releaseReservation);
          realtimeMetrics.connections++;
          realtimeMetrics.opened++;
          const operations = options.operationsForSession?.(headers, session) ?? options.operations;
          const controller = new AbortController();
          controllers.add(controller);
          const subscriptions = new Map<string, { generation: number; resource: RealtimeResource; close(): void | Promise<void> }>();
          const generations = new Map<string, number>();
          let messages = 0;
          let windowStart = Date.now();
          let inFlight = 0;
          let chain = Promise.resolve();
          let verifying = false;
          let pong = true;
          let aliveAt = Date.now();
          const close = (code = 1008, reason = "access_revoked") => {
            if (controller.signal.aborted) return;
            controller.abort();
            if (Object.hasOwn(realtimeCloseReasons, reason)) realtimeCloseReasons[reason]++;
            ws.close(code, reason);
            const timer = setTimeout(() => ws.terminate(), 1_000); timer.unref();
          };
          const live = async () => {
            if (controller.signal.aborted) return false;
            const current = await options.authenticate(headers);
            const valid = current?.userId === session.userId && current?.sessionId === session.sessionId;
            if (!valid) close();
            else aliveAt = Date.now();
            return valid && !controller.signal.aborted;
          };
          const send = (frame: unknown) => {
            if (controller.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
            const text = JSON.stringify(frame);
            const bytes = Buffer.byteLength(text);
            if (bytes > LIMITS.snapshotBytes || ws.bufferedAmount + bytes > LIMITS.queuedBytes) {
              realtimeMetrics.resyncs++; close(1013, "resync_required"); return;
            }
            realtimeMetrics.queuedBytes += bytes;
            ws.send(text, () => { realtimeMetrics.queuedBytes -= bytes; });
          };
          const frameFor = (id: string, generation: number, resource: RealtimeResource, type: string, revision: number, data?: unknown, code?: string) =>
            ({ v: 1, type, subscriptionId: id, generation, resource, epoch, revision, data, code });
          const deliver = async (id: string, generation: number, resource: RealtimeResource, type: string, revision: number, data: unknown) => {
            if (subscriptions.get(id)?.generation !== generation || !await live()) return;
            if (resource.kind !== "operation" && !await options.backend.authorize(session.userId, resource)) {
              send(frameFor(id, generation, resource, "error", revision, undefined, "access_revoked"));
              await subscriptions.get(id)?.close(); subscriptions.delete(id); return;
            }
            if (subscriptions.get(id)?.generation !== generation || controller.signal.aborted) return;
            send(frameFor(id, generation, resource, type, revision, data));
          };
          ws.on("message", (raw, binary) => {
            if (binary) return close(1003, "text_only");
            if (Date.now() - windowStart >= 60_000) { messages = 0; windowStart = Date.now(); }
            if (++messages > LIMITS.messagesPerMinute || ++inFlight > 16) return close(1008, "rate_limit");
            chain = chain.then(async () => {
              if (controller.signal.aborted) return;
              const frame = parseRealtimeClientFrame(raw.toString());
              if (frame.type === "heartbeat") { send({ v: 1, type: "heartbeat", epoch }); return; }
              if (frame.type === "unsubscribe") {
                if (subscriptions.get(frame.subscriptionId)?.generation === frame.generation) {
                  await subscriptions.get(frame.subscriptionId)?.close(); subscriptions.delete(frame.subscriptionId);
                }
                return;
              }
              if (!await live()) return;
              if (frame.generation <= (generations.get(frame.subscriptionId) ?? -1)) return;
              if (generations.size >= 256 && !generations.has(frame.subscriptionId)) return close(1008, "generation_limit");
              if (!subscriptions.has(frame.subscriptionId) && subscriptions.size >= LIMITS.subscriptions) return close(1008, "subscription_limit");
              generations.set(frame.subscriptionId, frame.generation);
              await subscriptions.get(frame.subscriptionId)?.close();
              const abort = new AbortController();
              const detach = () => abort.abort();
              controller.signal.addEventListener("abort", detach, { once: true });
              let dispose: (() => void | Promise<void>) | undefined;
              const subscription = { generation: frame.generation, resource: frame.resource, close: async () => {
                controller.signal.removeEventListener("abort", detach); abort.abort(); await dispose?.();
              } };
              subscriptions.set(frame.subscriptionId, subscription);
              try {
                let operationRevision = 0;
                const deliverFrame = (type: string, data: unknown, revision: number) =>
                  deliver(frame.subscriptionId, frame.generation, frame.resource, type,
                    frame.resource.kind === "operation" ? ++operationRevision : revision, data);
                if (frame.resource.kind === "operation") {
                  if (!operations) throw new Error("operation_unavailable");
                  const observer = await operations.subscribe({ userId: session.userId, resource: frame.resource, signal: abort.signal,
                    observer: { snapshot: (data, seq) => deliverFrame("snapshot", data, seq), append: (data, seq) => deliverFrame("upsert", data, seq),
                      resync: (data, seq, code) => deliverFrame(code === "operation_unavailable" ? "error" : "resync-required", { state: data, code }, seq) } });
                  dispose = () => observer.close();
                } else dispose = await broker.subscribe(session.userId, frame.resource, Object.assign(
                  (data: unknown, revision: number) => deliverFrame("snapshot", data, revision),
                  { failed: () => close(1013, "projection_unavailable"), revoked: async () => {
                    send(frameFor(frame.subscriptionId, frame.generation, frame.resource, "error", 0, undefined, "access_revoked"));
                    await subscription.close();
                    if (subscriptions.get(frame.subscriptionId) === subscription) subscriptions.delete(frame.subscriptionId);
                  } }));
                if (controller.signal.aborted) await subscription.close();
                else send(frameFor(frame.subscriptionId, frame.generation, frame.resource, "ack", 0));
              } catch {
                await subscription.close(); subscriptions.delete(frame.subscriptionId);
                send(frameFor(frame.subscriptionId, frame.generation, frame.resource, "error", 0, undefined, "subscription_unavailable"));
              }
            }).catch(() => close(1008, "invalid_frame")).finally(() => { inFlight--; });
          });
          const verifyTimer = setInterval(() => {
            // A stalled authorization backend cannot prolong an old decision.
            if (Date.now() - aliveAt > (options.authorizationRecheckMs ?? LIMITS.authorizationRecheckMs)) return close(1011, "authorization_timeout");
            if (verifying) return;
            verifying = true;
            void live().then(async valid => {
              if (!valid) return;
              for (const [id, sub] of subscriptions) {
                if (sub.resource.kind !== "operation" && !await options.backend.authorize(session.userId, sub.resource)) {
                  send(frameFor(id, sub.generation, sub.resource, "error", 0, undefined, "access_revoked"));
                  await sub.close(); subscriptions.delete(id);
                }
              }
            }).catch(() => close(1011, "authorization_failed")).finally(() => { verifying = false; });
          }, Math.min(1_000, (options.authorizationRecheckMs ?? LIMITS.authorizationRecheckMs) / 2));
          const heartbeat = setInterval(() => {
            if (!pong) return close(1001, "heartbeat_timeout");
            pong = false; ws.ping(); send({ v: 1, type: "heartbeat", epoch });
          }, LIMITS.heartbeatMs);
          ws.on("pong", () => { pong = true; });
          ws.on("error", () => close(1011, "transport_error"));
          ws.once("close", () => {
            controller.abort(); controllers.delete(controller);
            clearInterval(verifyTimer); clearInterval(heartbeat);
            for (const sub of subscriptions.values()) void Promise.resolve(sub.close()).catch(() => {});
            subscriptions.clear();
            realtimeMetrics.connections--;
            users.set(session.userId, Math.max(0, (users.get(session.userId) ?? 1) - 1));
            if (!users.get(session.userId)) users.delete(session.userId);
          });
        });
      } catch { releaseReservation(); socket.destroy(); }
    }).catch(() => { if (!socket.destroyed) reject(socket, 503); }).finally(() => { pending--; finish(); clearTimeout(timeout); socket.removeListener("close", finish); });
  };
  server.on("upgrade", upgrade);
  return {
    metrics: realtimeMetrics,
    async close() {
      if (draining) return;
      draining = true;
      server.off("upgrade", upgrade);
      for (const controller of controllers) controller.abort();
      for (const ws of wss.clients) { realtimeCloseReasons.server_restart++; ws.close(1012, "server_restart"); setTimeout(() => ws.terminate(), 1_000).unref(); }
      await broker.close();
      wss.close();
    },
  };
}
