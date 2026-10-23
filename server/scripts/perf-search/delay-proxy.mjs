// TCP proxy adding fixed one-way latency per chunk each direction: node delay-proxy.mjs <listenPort> <host:port> <oneWayMs>
import net from "node:net";
const [listen, target, ms] = process.argv.slice(2);
const [host, port] = target.split(":");
const d = Number(ms);
net.createServer((c) => {
  const u = net.connect(Number(port), host);
  const pipe = (from, to) => {
    from.on("data", (b) => setTimeout(() => to.writable && to.write(b), d));
    from.on("end", () => setTimeout(() => to.end(), d));
    from.on("error", () => to.destroy());
  };
  pipe(c, u); pipe(u, c);
  c.setNoDelay(true); u.setNoDelay(true);
}).listen(Number(listen), "127.0.0.1", () => console.log(`proxy :${listen} -> ${target} +${d}ms/way`));
