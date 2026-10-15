import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const request = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
async function invoke(lines) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    const result = req.url === "/v1/mcp/tools" ? { tools: [{ id: "workspace.suggest", title: "Suggest", inputSchema: { type: "object" } }] }
      : req.url === "/v1/mcp/prompts/workspace-grounded-answer" ? { prompt: "Use citations" }
      : req.url === "/v1/mcp/resources/ai.capabilities" ? { capabilities: [] }
      : req.url.startsWith("/v1/mcp/resources/ai.operation?") ? { operation: { id: "op", status: "running" } }
      : { suggestions: ["renewal" ] };
    res.writeHead(req.url.endsWith("unknown") ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, ["dist/index.js", "mcp-server"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DOCSLURP_API_KEY: "test-key", DOCSLURP_URL: `http://127.0.0.1:${server.address().port}/`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    });
    let out = "", err = "";
    child.stdout.on("data", data => out += data);
    child.stderr.on("data", data => err += data);
    child.stdin.end(lines.map(x => typeof x === "string" ? x : JSON.stringify(x)).join("\n") + "\n");
    const timer = setTimeout(() => child.kill(), 5000);
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    clearTimeout(timer);
    assert.equal(code, 0, err);
    return { responses: out.trim().split("\n").map(JSON.parse), requests };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
const init = request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const ready = { jsonrpc: "2.0", method: "notifications/initialized" };

test("MCP stdio lifecycle, discovery, tool content, resources and prompts use protocol shapes", async () => {
  const { responses, requests } = await invoke([init, ready, request(2, "tools/list"), request(3, "tools/call", { name: "workspace.suggest", arguments: { workspaceId: "ws" } }), request(4, "resources/list"), request(5, "resources/read", { uri: "docslurp://ai/capabilities" }), request(6, "prompts/list"), request(7, "prompts/get", { name: "workspace-grounded-answer" }), request(8, "ping")]);
  assert.equal(responses.length, 8, "Notifications must not receive replies");
  for (const response of responses) assert.equal(response.jsonrpc, "2.0");
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(responses[0].result.capabilities, { tools: {}, resources: {}, prompts: {} });
  assert.equal(responses[1].result.tools[0].name, "workspace.suggest");
  assert.equal(responses[2].result.isError, false);
  assert.deepEqual(JSON.parse(responses[2].result.content[0].text), { suggestions: ["renewal"] });
  assert.equal(responses[3].result.resources[0].uri, "docslurp://ai/capabilities");
  assert.equal(responses[4].result.contents[0].uri, "docslurp://ai/capabilities");
  assert.equal(responses[6].result.messages[0].content.text, "Use citations");
  assert.ok(requests.every(x => x.authorization === "Bearer test-key"));
});

test("MCP stdio exposes the operation resource template like the HTTP server", async () => {
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const uri = `docslurp://ai/operations/${operationId}`;
  const { responses, requests } = await invoke([init, ready, request(2, "resources/templates/list"), request(3, "resources/read", { uri }), request(4, "resources/read", { uri: "docslurp://ai/operations/not-a-uuid" }), request(5, "resources/read", { uri: "docslurp://ai.capabilities" })]);
  assert.deepEqual(responses[1].result.resourceTemplates.map(x => [x.uriTemplate, x.name]), [["docslurp://ai/operations/{operationId}", "ai.operation"]]);
  assert.equal(responses[2].result.contents[0].uri, uri);
  assert.deepEqual(JSON.parse(responses[2].result.contents[0].text), { operation: { id: "op", status: "running" } });
  assert.equal(responses[3].error.code, -32602);
  assert.equal(responses[4].error.code, -32602, "The old dotted capabilities URI is no longer served");
  assert.deepEqual(requests.map(x => x.path), [`/v1/mcp/resources/ai.operation?operationId=${operationId}`]);
});

test("MCP rejects invalid requests, guards initialization and path traversal, returns tool errors", async () => {
  const { responses, requests } = await invoke(["{", "null", request(0, "tools/list"), init, ready, request(2, "tools/call", { name: "../api-keys" }), request(3, "tools/call", { name: "unknown" }), request(4, "resources/read", { uri: "https://evil.test" }), request(5, "unknown")]);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].error.code, -32600);
  assert.equal(responses[2].error.code, -32602);
  assert.equal(responses[4].error.code, -32602);
  assert.equal(responses[5].result.isError, true);
  assert.match(responses[5].result.content[0].text, /couldn’t complete this tool request/);
  assert.equal(responses[6].error.code, -32602);
  assert.equal(responses[7].error.code, -32601);
  assert.deepEqual(requests.map(x => x.path), ["/v1/mcp/tools/unknown"]);
});
