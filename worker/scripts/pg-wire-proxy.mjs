// Postgres wire proxy for round-trip diagnostics: counts statements (Sync/simple Query messages) and
// serial round trips ("flights": a client send while no earlier statement is outstanding on that
// connection), and can add a fixed one-way delay in each direction (15 ms => ~30 ms RTT, like a managed
// Postgres reached across regions).
// CLI: node pg-wire-proxy.mjs <listenPort> <targetHost> <targetPort> [oneWayDelayMs=0] [controlPort=listenPort+1000]
//   Control: GET /stats -> {connections, statements, flights, bySql}, POST /reset.
// Module: startPgWireProxy({ targetPort, ... }) -> { port, stats(), reset(), close() }.
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";

function frames(onMessage, startup) {
  let buffer = Buffer.alloc(0);
  let started = !startup;
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (!started) {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        started = true;
        continue;
      }
      if (buffer.length < 5) return;
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      onMessage(String.fromCharCode(buffer[0]), buffer.subarray(5, length + 1));
      buffer = buffer.subarray(length + 1);
    }
  };
}

export async function startPgWireProxy({ listenPort = 0, targetHost = "127.0.0.1", targetPort, delayMs = 0 }) {
  const stats = { connections: 0, statements: 0, flights: 0, bySql: {} };
  const reset = () => Object.assign(stats, { connections: 0, statements: 0, flights: 0, bySql: {} });
  const sockets = new Set();
  const server = net.createServer((client) => {
    stats.connections += 1;
    const upstream = net.connect(Number(targetPort), targetHost);
    sockets.add(client); sockets.add(upstream);
    client.setNoDelay(true); upstream.setNoDelay(true);
    let outstanding = 0, lastSql = "";
    const fromClient = frames((type, body) => {
      if (type === "P" || type === "Q") {
        const text = type === "Q" ? body.toString("utf8", 0, body.length - 1) : body.toString("utf8", body.indexOf(0) + 1, body.indexOf(0, body.indexOf(0) + 1));
        if (text) lastSql = text.replace(/\s+/g, " ").trim().slice(0, 100);
      }
      if (type === "S" || type === "Q") {
        stats.statements += 1;
        if (outstanding === 0) stats.flights += 1;
        outstanding += 1;
        stats.bySql[lastSql] = (stats.bySql[lastSql] ?? 0) + 1;
      }
    }, true);
    const fromServer = frames((type) => { if (type === "Z" && outstanding > 0) outstanding -= 1; }, false);
    const pipe = (from, to, parse) => {
      from.on("data", (buf) => { parse(buf); if (delayMs > 0) setTimeout(() => { if (!to.destroyed) to.write(buf); }, delayMs); else if (!to.destroyed) to.write(buf); });
      from.on("end", () => setTimeout(() => to.end(), delayMs));
      from.on("error", () => to.destroy());
    };
    pipe(client, upstream, fromClient); pipe(upstream, client, fromServer);
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise((resolve) => server.listen(Number(listenPort), "127.0.0.1", resolve));
  return {
    port: server.address().port,
    stats: () => ({ ...stats, bySql: { ...stats.bySql } }),
    reset,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [lp, th, tp, d = "0", cp] = process.argv.slice(2);
  const proxy = await startPgWireProxy({ listenPort: Number(lp), targetHost: th, targetPort: Number(tp), delayMs: Number(d) });
  console.log(`pg-wire-proxy ${lp} -> ${th}:${tp} +${d}ms each way`);
  http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/reset") { proxy.reset(); res.end("ok"); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(proxy.stats()));
  }).listen(Number(cp ?? Number(lp) + 1000), "127.0.0.1");
}
