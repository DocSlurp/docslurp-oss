// A TCP proxy in its own process that can reset every connection through it on
// demand, like a NAT or pooler that dropped its state while the app was frozen.
// IPC: { type: "listen", target } -> { type: "listening", port };
//      { type: "sever" } -> { type: "severed", count }.
import net from "node:net";

const sockets = new Set();
let server;

process.on("message", (message) => {
  if (message.type === "listen") {
    server = net.createServer((client) => {
      const upstream = net.connect(message.target, message.host);
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("error", () => client.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.listen(0, "127.0.0.1", () => process.send({ type: "listening", port: server.address().port }));
  } else if (message.type === "sever") {
    const count = sockets.size;
    for (const socket of sockets) { socket.resetAndDestroy(); }
    sockets.clear();
    process.send({ type: "severed", count });
  }
});
