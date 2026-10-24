// TCP proxy that adds a fixed one-way delay in each direction (default 15 ms => ~31 ms RTT like Neon from Fly).
// Usage: node latency-proxy.mjs <listenPort> <targetHost> <targetPort> [delayMs=15]
import net from "node:net";
const [lp, th, tp, d = "15"] = process.argv.slice(2);
const delay = Number(d);
function pipeDelayed(from, to) {
  from.on("data", (buf) => setTimeout(() => { if (!to.destroyed) to.write(buf); }, delay));
  from.on("end", () => setTimeout(() => to.end(), delay));
  from.on("error", () => to.destroy());
}
net.createServer((c) => {
  const s = net.connect(Number(tp), th);
  c.setNoDelay(true); s.setNoDelay(true);
  pipeDelayed(c, s); pipeDelayed(s, c);
  c.on("close", () => s.destroy()); s.on("close", () => c.destroy());
}).listen(Number(lp), "127.0.0.1", () => console.log(`proxy ${lp} -> ${th}:${tp} +${delay}ms each way`));
