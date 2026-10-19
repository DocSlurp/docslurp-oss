import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function invoke(args, respond, options = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
    const result = respond(requests.at(-1), requests.length);
    if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ["dist/index.js", ...args, ...(options.environmentUrl ? [] : ["--api-url", `${url}/`])], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", DOCSLURP_API_KEY: options.noKey ? "" : "test-key", DOCSLURP_URL: options.environmentUrl ? `${url}/` : "https://ignored-env.test", DOCSLURP_WORKSPACE_ID: options.workspaceId ?? "" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const kill = setTimeout(() => child.kill(), 2000);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(kill);
    return { code, stdout, stderr, requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const run = (status, extra = {}) => ({ id: "run", status, stage: "index", totalDocuments: 1, processedDocuments: status === "completed" ? 1 : 0, pagesTotal: 3, pagesProcessed: status === "completed" ? 3 : 0, ...extra });

test("license is available without credentials or network access", async () => {
  const result = await invoke(["--license"], () => { throw new Error("License must be local"); }, { noKey: true });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.requests, []);
  assert.match(result.stdout, /Server Side Public License/);
});

test("search scopes to workspace and authenticates", async () => {
  const result = await invoke(["search", "termination", "policy", "--workspace", "workspace"], () => ({ body: {
    results: [{ score: 0.8, text: "Termination requires notice.\nExceptions apply.", citation: { filename: "policy.pdf", pageNumbers: [2, 3] } }],
  } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].headers.authorization, "Bearer test-key");
  const url = new URL(result.requests[0].url, "http://localhost");
  assert.equal(url.pathname, "/v1/search");
  assert.equal(url.searchParams.get("workspaceId"), "workspace");
  assert.equal(url.searchParams.get("q"), "termination policy");
});

test("search --min-score validates its value instead of silently disabling the floor", async () => {
  const ok = await invoke(["search", "question", "--min-score", "0.3"], () => ({ body: { results: [] } }), { workspaceId: "workspace" });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(new URL(ok.requests[0].url, "http://localhost").searchParams.get("minScore"), "0.3");
  for (const args of [["--min-score"], ["--min-score", ""], ["--min-score", "abc"], ["--min-score", "2"]]) {
    const bad = await invoke(["search", "question", ...args], () => ({ body: { results: [] } }), { workspaceId: "workspace" });
    assert.notEqual(bad.code, 0, JSON.stringify(args));
    assert.match(bad.stderr, /--min-score must be a number from 0 to 1/);
    assert.deepEqual(bad.requests, []);
  }
});

test("search without a workspace uses the default workspace; API commands require a key before network access", async () => {
  let result = await invoke(["search", "question"], () => ({ body: { results: [] } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/search?q=question&workspaceId=default");
  result = await invoke(["runs"], () => ({ body: {} }), { noKey: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DOCSLURP_API_KEY/);
  assert.equal(result.requests.length, 0);
});

test("upload sends actual named file bytes and authenticates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "policy.txt");
    await writeFile(file, "Actual source bytes");
    const result = await invoke(["upload", file, "--workspace", "workspace"], () => ({ body: {
      run: { id: "run" }, workspace: { id: "workspace", name: "Policies" }, documents: [{}], warnings: ["Processing is deferred"],
    } }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].headers.authorization, "Bearer test-key");
    assert.equal(result.requests[0].url, "/v1/uploads/bulk");
    assert.match(result.requests[0].body, /filename="policy\.txt"/);
    assert.match(result.requests[0].body, /Actual source bytes/);
    assert.match(result.requests[0].body, /name="workspaceId"\r\n\r\nworkspace/);
    assert.doesNotMatch(result.requests[0].body, /name="pipeline"/);
    assert.match(result.stdout, /Run ID:\s+run/);
    assert.match(result.stderr, /Processing is deferred/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upload over the multipart cap goes straight to storage through a direct session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "scan.pdf");
    const size = 20 * 1024 * 1024 + 1;
    await writeFile(file, Buffer.alloc(size, 1));
    const result = await invoke(["upload", file, "--workspace", "workspace"], (request) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        return { status: 201, body: { sessionId: "s1", files: [{ id: "f1", filename: "scan.pdf", mimeType: "application/pdf", sizeBytes: size, mode: "single", putUrl: `http://${request.headers.host}/storage/put/f1` }] } };
      }
      if (request.url.startsWith("/storage/")) return { body: {} };
      if (request.url.endsWith("/files/complete")) return { body: { ok: true } };
      return { status: 201, body: { run: { id: "run" }, workspace: { id: "workspace", name: "Scans" }, documents: [{}] } };
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.requests.map((request) => `${request.method} ${request.url}`), [
      "POST /v1/uploads/direct/sessions",
      "PUT /storage/put/f1",
      "POST /v1/uploads/direct/sessions/s1/files/complete",
      "POST /v1/uploads/direct/sessions/s1/confirm",
    ]);
    assert.deepEqual(JSON.parse(result.requests[0].body), { workspaceId: "workspace", files: [{ filename: "scan.pdf", mimeType: "application/pdf", sizeBytes: size }] });
    assert.equal(result.requests[1].headers.authorization, undefined, "storage never receives the API key");
    assert.equal(result.requests[1].body.length, size);
    assert.match(result.stdout, /Run ID:\s+run/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("status uses progress, encodes run id and respects bearer key", async () => {
  const result = await invoke(["status", "run/id"], () => ({ body: { run: run("completed") } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/runs/run%2Fid/progress");
  assert.equal(result.requests[0].headers.authorization, "Bearer test-key");
});

test("watch exits on failed requests and failed or paused runs", async () => {
  for (const reply of [
    { status: 403, body: { error: "Forbidden" } },
    { body: { run: run("failed", { error: "Parser failed" }) } },
    { body: { run: run("queued", { controlState: "paused" }) } },
  ]) {
    const result = await invoke(["status", "run", "--watch"], () => reply);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
  }
});

test("deferred queued watch is bounded", async () => {
  const result = await invoke(["status", "run", "--watch", "--timeout", "0.15"], () => ({ body: { run: run("queued") } }));
  assert.equal(result.code, 1, result.stderr);
  assert.ok(result.requests.length >= 1);
});

test("runs list authenticates and prints run summary", async () => {
  const result = await invoke(["runs", "--api-key", "flag-key"], () => ({ body: { runs: [run("completed", { createdAt: "2026-10-02" })] } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].headers.authorization, "Bearer flag-key");
  assert.equal(result.requests[0].url, "/v1/runs");
  assert.match(result.stdout, /completed/);
  assert.match(result.stdout, /2026-10-02/);
});

test("CLI honors environment URL/workspace and flags override workspace", async () => {
  for (const override of [false, true]) {
    const result = await invoke(["search", "question", ...(override ? ["--workspace", "flag-workspace"] : [])], () => ({ body: { results: [] } }), { environmentUrl: true, workspaceId: "env-workspace" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url, "http://localhost").searchParams.get("workspaceId"), override ? "flag-workspace" : "env-workspace");
  }
});

test("upload targets flag, environment, then the default workspace; --new-workspace opts out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "note.txt");
    await writeFile(file, "Plain text");
    for (const [environmentWorkspace, flagWorkspace, expected, extra] of [
      [undefined, undefined, "default", []],
      ["env-workspace", undefined, "env-workspace", []],
      ["env-workspace", "flag-workspace", "flag-workspace", []],
      ["env-workspace", undefined, undefined, ["--new-workspace"]],
    ]) {
      const result = await invoke(["upload", file, ...extra, ...(flagWorkspace ? ["--workspace", flagWorkspace] : [])], () => ({ body: {
        run: { id: "run" }, workspace: { id: "workspace", name: "Notes" }, documents: [],
      } }), { environmentUrl: true, workspaceId: environmentWorkspace });
      assert.equal(result.code, 0, result.stderr);
      if (expected) assert.match(result.requests[0].body, new RegExp(`name="workspaceId"\\r\\n\\r\\n${expected}`));
      else {
        assert.doesNotMatch(result.requests[0].body, /name="workspaceId"/);
        assert.match(result.requests[0].body, /name="newWorkspace"\r\n\r\ntrue/);
      }
      assert.match(result.requests[0].body, /Plain text/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upload --workspace-name or --template creates a workspace instead of targeting the default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "note.txt");
    await writeFile(file, "Plain text");
    const respond = () => ({ body: { run: { id: "run" }, workspace: { id: "workspace", name: "Contracts" }, documents: [] } });
    let result = await invoke(["upload", file, "--workspace-name", "Contracts", "--template", "legal-contracts"], respond, { environmentUrl: true, workspaceId: "env-workspace" });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.requests[0].body, /name="workspaceId"/);
    assert.match(result.requests[0].body, /name="newWorkspace"\r\n\r\ntrue/);
    assert.match(result.requests[0].body, /name="workspaceName"\r\n\r\nContracts/);
    assert.match(result.requests[0].body, /name="templateKey"\r\n\r\nlegal-contracts/);

    // An explicit --workspace still wins over a name.
    result = await invoke(["upload", file, "--workspace", "legal", "--workspace-name", "Contracts"], respond, { environmentUrl: true });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.requests[0].body, /name="workspaceId"\r\n\r\nlegal/);
    assert.doesNotMatch(result.requests[0].body, /name="newWorkspace"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ingest-url posts URLs with the same workspace targeting as upload", async () => {
  const respond = () => ({ body: { run: { id: "run" }, workspace: { id: "workspace", name: "Docs" }, documents: [{}] } });
  let result = await invoke(["ingest-url", "https://example.test/a.pdf", "--template", "legal-contracts"], respond);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/uploads/url");
  assert.deepEqual(JSON.parse(result.requests[0].body), { urls: ["https://example.test/a.pdf"], newWorkspace: true, templateKey: "legal-contracts" });
  assert.match(result.stdout, /Run ID: +run/);

  result = await invoke(["ingest-url", "https://example.test/a.pdf"], respond);
  assert.deepEqual(JSON.parse(result.requests[0].body), { urls: ["https://example.test/a.pdf"], newWorkspace: false, workspaceId: "default" });
});

test("runs can print newly queued runs without a stage", async () => {
  const result = await invoke(["runs"], () => ({ body: { runs: [run("queued", { stage: null, createdAt: "2026-10-02" })] } }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /queued/);
});

test("request timeout cancels stalled responses and invalid timeout fails before requests", async () => {
  let result = await invoke(["runs", "--timeout", "0.02"], () => ({ body: { runs: [] }, delayMs: 80 }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timeout|aborted/i);
  result = await invoke(["runs", "--timeout", "0"], () => ({ body: {} }));
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 0);
});

test("chat supports sessions and machine-readable answers", async () => {
  const body = { answer: "Grounded answer", sessionId: "session", citations: [], usage: { inputTokens: 5, outputTokens: 2 } };
  const result = await invoke(["chat", "What", "changed?", "--session", "prior", "--json"], () => ({ body }), { workspaceId: "workspace" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/chat");
  assert.deepEqual(JSON.parse(result.requests[0].body), { q: "What changed?", workspaceId: "workspace", sessionId: "prior" });
  assert.deepEqual(JSON.parse(result.stdout), body);
});

test("search context emits full cited text and JSON emits the API envelope", async () => {
  const text = "Long evidence ".repeat(50);
  const body = { results: [{ score: 1, text, citation: { filename: "policy.pdf", documentId: "doc", pageNumbers: [2] } }], availability: null };
  const context = await invoke(["search", "policy", "--context"], () => ({ body }), { workspaceId: "workspace" });
  assert.equal(context.code, 0, context.stderr);
  assert.ok(context.stdout.includes(text));
  const result = await invoke(["search", "policy", "--json"], () => ({ body }), { workspaceId: "workspace" });
  assert.deepEqual(JSON.parse(result.stdout), body);
});

test("batch search reads a portable query file and reports ordered partial failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const path = join(dir, "queries.json");
    await writeFile(path, JSON.stringify(["first", { q: "second", workspaceId: "other" }]));
    const body = { results: [{ ok: true, data: { results: [] } }, { ok: false, error: { code: "forbidden", message: "Forbidden", status: 403 } }] };
    const result = await invoke(["search", "--queries-file", path, "--concurrency", "3", "--json"], () => ({ body }), { workspaceId: "workspace" });
    assert.equal(result.code, 1);
    assert.equal(result.requests[0].url, "/v1/search");
    assert.deepEqual(JSON.parse(result.requests[0].body), { queries: [{ q: "first", workspaceId: "workspace" }, { q: "second", workspaceId: "other" }], concurrency: 3 });
    assert.deepEqual(JSON.parse(result.stdout), body);
    const invalid = await invoke(["search", "--queries-file", path, "--concurrency", "5"], () => ({ body }), { workspaceId: "workspace" });
    assert.equal(invalid.code, 1);
    assert.equal(invalid.requests.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
