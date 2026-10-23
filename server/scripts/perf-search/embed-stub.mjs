// OpenAI-compatible /v1/embeddings stub: node embed-stub.mjs <port> <delayMs>
import http from "node:http";
import { hashEmbed } from "./hash-embed.mjs";
const [port, delay] = process.argv.slice(2);
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
    const j = JSON.parse(body || "{}"); const inputs = Array.isArray(j.input) ? j.input : [j.input];
    setTimeout(() => { res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", model: j.model, data: inputs.map((t, i) => ({ object: "embedding", index: i, embedding: hashEmbed(String(t)) })), usage: { prompt_tokens: 8, total_tokens: 8 } })); }, Number(delay));
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`embed stub :${port} +${delay}ms`));
