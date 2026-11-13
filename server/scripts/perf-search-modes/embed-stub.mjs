// OpenAI-compatible /v1/embeddings stub: node embed-stub.mjs <port> <delayMs>. Counts requests and inputs.
import http from "node:http";
import { hashEmbed } from "./hash-embed.mjs";
const [port, delay] = process.argv.slice(2);
let requests = 0, inputs = 0;
http.createServer((req, res) => {
  if (req.url === "/stats") { res.end(JSON.stringify({ requests, inputs })); return; }
  let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
    const j = JSON.parse(body || "{}"); const list = Array.isArray(j.input) ? j.input : [j.input];
    requests++; inputs += list.length;
    setTimeout(() => { res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", model: j.model, data: list.map((t, i) => ({ object: "embedding", index: i, embedding: hashEmbed(String(t)) })), usage: { prompt_tokens: list.reduce((s, t) => s + Math.ceil(String(t).length / 4), 0), total_tokens: 0 } })); }, Number(delay));
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`embed stub :${port} +${delay}ms`));
