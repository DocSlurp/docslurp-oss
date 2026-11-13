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
    response.writeHead(result.status ?? 200, { "content-type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    // "{{server}}" in an argument is this test server (URLs the CLI itself fetches, such as ingest-url --estimate).
    const child = spawn(process.execPath, ["dist/index.js", ...args.map((arg) => arg.replaceAll("{{server}}", url)), ...(options.environmentUrl ? [] : ["--api-url", `${url}/`])], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", DOCSLURP_API_KEY: options.noKey ? "" : "test-key", DOCSLURP_URL: options.environmentUrl ? `${url}/` : "https://ignored-env.test", DOCSLURP_PROJECT: options.project ?? "" },
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
  assert.match(result.stdout, /Business Source License 1\.1/);
});

test("search scopes to project and authenticates", async () => {
  const result = await invoke(["search", "termination", "policy", "--project", "project"], () => ({ body: {
    results: [{ score: 0.8, text: "Termination requires notice.\nExceptions apply.", citation: { filename: "policy.pdf", pageNumbers: [2, 3] } }],
  } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].headers.authorization, "Bearer test-key");
  const url = new URL(result.requests[0].url, "http://localhost");
  assert.equal(url.pathname, "/v1/search");
  assert.equal(url.searchParams.get("project"), "project");
  assert.equal(url.searchParams.get("q"), "termination policy");
});

test("search --min-score validates its value instead of silently disabling the floor", async () => {
  const ok = await invoke(["search", "question", "--min-score", "0.3"], () => ({ body: { results: [] } }), { project: "project" });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(new URL(ok.requests[0].url, "http://localhost").searchParams.get("minScore"), "0.3");
  for (const args of [["--min-score"], ["--min-score", ""], ["--min-score", "abc"], ["--min-score", "2"]]) {
    const bad = await invoke(["search", "question", ...args], () => ({ body: { results: [] } }), { project: "project" });
    assert.notEqual(bad.code, 0, JSON.stringify(args));
    assert.match(bad.stderr, /--min-score must be a number from 0 to 1|--min-score needs a value/);
    assert.deepEqual(bad.requests, []);
  }
});

test("search without a project uses the default project; API commands require a key before network access", async () => {
  let result = await invoke(["search", "question"], () => ({ body: { results: [] } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/search?q=question&project=default");
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
    const result = await invoke(["upload", file, "--project", "project"], () => ({ body: {
      run: { id: "run" }, project: { id: "project", name: "Policies" }, documents: [{}], warnings: ["Processing is deferred"],
    } }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].headers.authorization, "Bearer test-key");
    assert.equal(result.requests[0].url, "/v1/uploads/bulk");
    assert.match(result.requests[0].body, /filename="policy\.txt"/);
    assert.match(result.requests[0].body, /Actual source bytes/);
    assert.match(result.requests[0].body, /name="project"\r\n\r\nproject/);
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
    const result = await invoke(["upload", file, "--project", "project"], (request) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        return { status: 201, body: { sessionId: "s1", files: [{ id: "f1", filename: "scan.pdf", mimeType: "application/pdf", sizeBytes: size, mode: "single", putUrl: `http://${request.headers.host}/storage/put/f1` }] } };
      }
      if (request.url.startsWith("/storage/")) return { body: {} };
      if (request.url.endsWith("/files/complete")) return { body: { ok: true } };
      return { status: 201, body: { run: { id: "run" }, project: { id: "project", name: "Scans" }, documents: [{}] } };
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.requests.map((request) => `${request.method} ${request.url}`), [
      "POST /v1/uploads/direct/sessions",
      "PUT /storage/put/f1",
      "POST /v1/uploads/direct/sessions/s1/files/complete",
      "POST /v1/uploads/direct/sessions/s1/confirm",
    ]);
    assert.deepEqual(JSON.parse(result.requests[0].body), { project: "project", files: [{ clientId: "0", filename: "scan.pdf", mimeType: "application/octet-stream", sizeBytes: size }] });
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

test("watch keeps waiting on a run paused for credits instead of stopping at once", async () => {
  const result = await invoke(["status", "run", "--watch", "--timeout", "0.15"], () => ({
    body: { run: run("processing", { controlState: "paused", pauseReason: "credit_exhausted" }) },
  }));
  // It ran until its own deadline (an operator pause or failure would have ended after one request, with "Stopped").
  assert.match(result.stdout, /paused \(out of credits; resumes after a top-up\)/);
  assert.doesNotMatch(result.stdout, /Stopped/);
  assert.match(result.stderr, /did not complete within/);
  assert.equal(result.code, 1);
});

test("a single status of a credit-paused run is not a failure", async () => {
  const result = await invoke(["status", "run"], () => ({ body: { run: run("processing", { controlState: "paused", pauseReason: "org_budget_paused" }) } }));
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Stopped/);
});

test("deferred queued watch is bounded", async () => {
  const result = await invoke(["status", "run", "--watch", "--timeout", "0.15"], () => ({ body: { run: run("queued") } }));
  assert.equal(result.code, 1, result.stderr);
  assert.ok(result.requests.length >= 1);
});

test("runs prints the cursor for the next page and forwards --limit and --cursor", async () => {
  const result = await invoke(["runs", "--limit", "1", "--cursor", "abc"], () => ({ body: { runs: [run("completed", { createdAt: "2026-10-02" })], hasMore: true, nextCursor: "next-page" } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/runs?limit=1&cursor=abc");
  assert.match(result.stdout, /More runs exist\. Next page: docslurp runs --cursor next-page/);
});

test("runs list authenticates and prints run summary", async () => {
  const result = await invoke(["runs", "--api-key", "flag-key"], () => ({ body: { runs: [run("completed", { createdAt: "2026-10-02" })] } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].headers.authorization, "Bearer flag-key");
  assert.equal(result.requests[0].url, "/v1/runs");
  assert.match(result.stdout, /completed/);
  assert.match(result.stdout, /2026-10-02/);
});

test("CLI honors environment URL/project and flags override project", async () => {
  for (const override of [false, true]) {
    const result = await invoke(["search", "question", ...(override ? ["--project", "flag-project"] : [])], () => ({ body: { results: [] } }), { environmentUrl: true, project: "env-project" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url, "http://localhost").searchParams.get("project"), override ? "flag-project" : "env-project");
  }
});

test("upload targets flag, environment, then the default project; --new-project opts out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "note.txt");
    await writeFile(file, "Plain text");
    for (const [environmentProject, flagProject, expected, extra] of [
      [undefined, undefined, "default", []],
      ["env-project", undefined, "env-project", []],
      ["env-project", "flag-project", "flag-project", []],
      ["env-project", undefined, undefined, ["--new-project"]],
    ]) {
      const result = await invoke(["upload", file, ...extra, ...(flagProject ? ["--project", flagProject] : [])], () => ({ body: {
        run: { id: "run" }, project: { id: "project", name: "Notes" }, documents: [],
      } }), { environmentUrl: true, project: environmentProject });
      assert.equal(result.code, 0, result.stderr);
      if (expected) assert.match(result.requests[0].body, new RegExp(`name="project"\\r\\n\\r\\n${expected}`));
      else {
        assert.doesNotMatch(result.requests[0].body, /name="project"/);
        assert.match(result.requests[0].body, /name="newProject"\r\n\r\ntrue/);
      }
      assert.match(result.requests[0].body, /Plain text/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upload --project sends a name as-is (the server finds or creates it) and --template alone creates a project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "note.txt");
    await writeFile(file, "Plain text");
    const respond = () => ({ body: { run: { id: "run" }, project: { id: "project", name: "Contracts" }, documents: [] } });
    let result = await invoke(["upload", file, "--template", "legal-contracts"], respond, { environmentUrl: true, project: "env-project" });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.requests[0].body, /name="project"/);
    assert.match(result.requests[0].body, /name="newProject"\r\n\r\ntrue/);
    assert.match(result.requests[0].body, /name="templateKey"\r\n\r\nlegal-contracts/);

    // A name goes to the server as the project; --template applies if it gets created.
    result = await invoke(["upload", file, "--project", "Legal Contracts", "--template", "legal-contracts"], respond, { environmentUrl: true });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.requests[0].body, /name="project"\r\n\r\nLegal Contracts/);
    assert.match(result.requests[0].body, /name="templateKey"\r\n\r\nlegal-contracts/);
    assert.doesNotMatch(result.requests[0].body, /name="newProject"/);

    // --project-name is gone.
    result = await invoke(["upload", file, "--project-name", "Contracts"], respond, { environmentUrl: true });
    assert.notEqual(result.code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ingest-url posts URLs with the same project targeting as upload", async () => {
  const respond = () => ({ body: { run: { id: "run" }, project: { id: "project", name: "Docs" }, documents: [{}] } });
  let result = await invoke(["ingest-url", "https://example.test/a.pdf", "--template", "legal-contracts"], respond);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/uploads/url");
  assert.deepEqual(JSON.parse(result.requests[0].body), { urls: ["https://example.test/a.pdf"], newProject: true, templateKey: "legal-contracts" });
  assert.match(result.stdout, /Run ID: +run/);

  result = await invoke(["ingest-url", "https://example.test/a.pdf"], respond);
  assert.deepEqual(JSON.parse(result.requests[0].body), { urls: ["https://example.test/a.pdf"], newProject: false, project: "default" });
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
  const result = await invoke(["chat", "What", "changed?", "--session", "prior", "--json"], () => ({ body }), { project: "project" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/chat");
  assert.deepEqual(JSON.parse(result.requests[0].body), { q: "What changed?", project: "project", sessionId: "prior" });
  assert.deepEqual(JSON.parse(result.stdout), body);
});

test("chat sends a tier and refuses --model before any request", async () => {
  const body = { answer: "A", sessionId: "s", citations: [] };
  const tiered = await invoke(["chat", "Why?", "--tier", "smart", "--reasoning", "low", "--json"], () => ({ body }), { project: "project" });
  assert.equal(tiered.code, 0, tiered.stderr);
  assert.deepEqual(JSON.parse(tiered.requests[0].body), { q: "Why?", project: "project", tier: "smart", reasoning: "low" });
  for (const args of [["--model", "anthropic/claude-haiku-5.5"], ["--tier", "openai/gpt-6.1-sol"]]) {
    const refused = await invoke(["chat", "Why?", ...args], () => ({ body }), { project: "project" });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /fastest, balanced, smart/);
    assert.equal(refused.requests.length, 0);
  }
});

test("search context emits full cited text and JSON emits the API envelope", async () => {
  const text = "Long evidence ".repeat(50);
  const body = { results: [{ score: 1, text, citation: { filename: "policy.pdf", documentId: "doc", pageNumbers: [2] } }], availability: null };
  const context = await invoke(["search", "policy", "--context"], () => ({ body }), { project: "project" });
  assert.equal(context.code, 0, context.stderr);
  assert.ok(context.stdout.includes(text));
  const result = await invoke(["search", "policy", "--json"], () => ({ body }), { project: "project" });
  assert.deepEqual(JSON.parse(result.stdout), body);
});

test("batch search reads a portable query file and reports ordered partial failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const path = join(dir, "queries.json");
    await writeFile(path, JSON.stringify(["first", { q: "second", project: "other" }]));
    const body = { results: [{ ok: true, data: { results: [] } }, { ok: false, error: { code: "forbidden", message: "Forbidden", status: 403 } }] };
    const result = await invoke(["search", "--queries-file", path, "--concurrency", "3", "--json"], () => ({ body }), { project: "project" });
    assert.equal(result.code, 1);
    assert.equal(result.requests[0].url, "/v1/search");
    assert.deepEqual(JSON.parse(result.requests[0].body), { queries: [{ q: "first", project: "project" }, { q: "second", project: "other" }], concurrency: 3 });
    assert.deepEqual(JSON.parse(result.stdout), body);
    const invalid = await invoke(["search", "--queries-file", path, "--concurrency", "5"], () => ({ body }), { project: "project" });
    assert.equal(invalid.code, 1);
    assert.equal(invalid.requests.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upload --estimate posts file sizes to the estimate route and uploads nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "a.txt");
    await writeFile(file, "hello");
    const result = await invoke(["upload", file, "--estimate", "--project", "ws"], () => ({ body: {
      estimate: { pages: 2, documents: 1, billing: "disabled", credits: null, seconds: { low: 1, high: 3 }, basis: "fixture" }, billing: "disabled",
    } }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].url, "/v1/uploads/estimate");
    assert.deepEqual(JSON.parse(result.requests[0].body), { files: [{ name: "a.txt", size: 5 }], project: "ws" });
    assert.match(result.stdout, /billing disabled/);
    assert.match(result.stdout, /nothing was started/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("full-index and reprocess --estimate hit estimate routes only", async () => {
  const body = { estimate: { pages: 1, documents: 1, billing: "enforced", credits: { low: 2, high: 4 }, seconds: null, basis: "b" }, billing: "enforced" };
  const doc = await invoke(["full-index", "--document", "d1", "--estimate"], () => ({ body }));
  assert.equal(doc.code, 0, doc.stderr);
  assert.deepEqual(doc.requests.map((r) => [r.method, r.url]), [["POST", "/v1/documents/d1/full-index/estimate"]]);
  assert.match(doc.stdout, /Credits:   2–4/);
  const ws = await invoke(["full-index", "--project", "w", "--estimate"], () => ({ body }));
  assert.equal(ws.requests[0].url, "/v1/projects/w/full-index/estimate");
  const re = await invoke(["reprocess", "run1", "--stage-from", "embed", "--estimate"], () => ({ body }));
  assert.equal(re.requests[0].url, "/v1/runs/run1/reprocess/estimate");
  assert.deepEqual(JSON.parse(re.requests[0].body), { stageFrom: "embed" });
});

test("jobs get prints the job and watch polls to completion", async () => {
  const job = (status) => ({ id: "j1", kind: "reindex", status, runIds: [], queue: { position: null, ahead: null }, estimate: null, statusUrl: "/v1/jobs/j1" });
  const got = await invoke(["jobs", "get", "j1"], () => ({ body: job("blocked") }));
  assert.equal(got.requests[0].url, "/v1/jobs/j1");
  assert.match(got.stdout, /Job j1: reindex blocked/);
  const watched = await invoke(["jobs", "watch", "j1"], ({ url }) => url.endsWith("/events") ? { status: 404, body: {} } : { body: job("completed") });
  assert.equal(watched.code, 0, watched.stderr);
  assert.deepEqual(watched.requests.map((r) => r.url), ["/v1/jobs/j1/events", "/v1/jobs/j1"]);
  assert.match(watched.stdout, /reindex completed/);
});

test("extract sends URLs to /v1/extracts/url with the retention options and prints the extract", async () => {
  const result = await invoke(["extract", "https://example.com/a.pdf", "--retention-days", "7", "--no-email", "--download", "all"], () => ({ status: 201, body: {
    project: { id: "w", name: "Inbox" }, run: { id: "run" }, documents: [{}],
    extract: { id: "ext_1", expiresAt: "2026-11-02T00:00:00.000Z", paidRetention: true, notifyEmail: false },
  } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/extracts/url");
  assert.deepEqual(JSON.parse(result.requests[0].body), { urls: ["https://example.com/a.pdf"], newProject: false, project: "default", retentionDays: 7, notifyEmail: false, download: "all" });
  assert.match(result.stdout, /Extract:\s+ext_1/);
  assert.match(result.stdout, /extended retention/);
});

test("extract refuses a bad retention and a mix of files and URLs before any request", async () => {
  const bad = await invoke(["extract", "https://example.com/a.pdf", "--retention-days", "1.5"], () => ({ body: {} }));
  assert.notEqual(bad.code, 0);
  assert.deepEqual(bad.requests, []);
  const mixed = await invoke(["extract", "https://example.com/a.pdf", "notes.txt"], () => ({ body: {} }));
  assert.notEqual(mixed.code, 0);
  assert.deepEqual(mixed.requests, []);
});

test("extract files go through /v1/extracts/bulk and extract-status reports an expired extract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-extract-"));
  try {
    const file = join(dir, "notes.txt");
    await writeFile(file, "hello");
    const uploaded = await invoke(["extract", file], () => ({ status: 201, body: { project: { id: "w", name: "Inbox" }, run: { id: "run" }, documents: [{}], extract: { id: "ext_1", expiresAt: "2026-10-29T00:00:00.000Z", paidRetention: false, notifyEmail: true } } }));
    assert.equal(uploaded.code, 0, uploaded.stderr);
    assert.equal(uploaded.requests[0].url, "/v1/extracts/bulk");
    assert.match(uploaded.stdout, /email with a download link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const gone = await invoke(["extract-status", "ext_1"], () => ({ status: 410, body: { error: { code: "extract_expired" } } }));
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /expired/);
});

test("HTTP failures print reviewed recovery copy and a safe support ID", async () => {
  const result = await invoke(["search", "question"], () => ({ status: 403, body: {
    error: { code: "mfa_required", message: "secret provider text", requestId: "req-safe-1", details: { secret: "private" } },
  } }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /authenticator/);
  assert.match(result.stderr, /req-safe-1/);
  assert.doesNotMatch(result.stderr, /secret|private/);
});

test("--json emits a safe typed HTTP error without raw body diagnostics", async () => {
  const result = await invoke(["search", "question", "--json"], () => ({ status: 402, body: {
    error: { code: "credit_exhausted", message: "secret provider text", requestId: "req-safe-2", details: { secret: "private", retryAfterSeconds: 30 } },
  } }));
  assert.equal(result.code, 1);
  const body = JSON.parse(result.stderr);
  assert.equal(body.error.code, "credit_exhausted");
  assert.equal(body.error.status, 402);
  assert.equal(body.error.requestId, "req-safe-2");
  assert.equal(body.error.retryAfterSeconds, 30);
  assert.doesNotMatch(result.stderr, /secret|private/);
});

test("--chart-export sends pipeline.chartExport on upload and ingest-url, chartExport on reprocess and estimates, and rejects unknown tiers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "note.txt");
    await writeFile(file, "Plain text");
    const respond = () => ({ body: { run: { id: "run" }, project: { id: "project", name: "Docs" }, documents: [{}], estimate: { pages: 1, documents: 1, credits: null, seconds: null, basis: "x" } } });
    let result = await invoke(["upload", file, "--chart-export", "free", "--quality", "fast"], respond);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.requests[0].body, /name="pipeline"\r\n\r\n\{"quality":"fast","chartExport":\{"tier":"free"\}\}/);

    result = await invoke(["ingest-url", "https://example.test/a.pdf", "--chart-export", "models"], respond);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.requests[0].body).pipeline, { chartExport: { tier: "models" } });

    result = await invoke(["reprocess", "run-1", "--chart-export", "off"], respond);
    assert.deepEqual(JSON.parse(result.requests[0].body), { chartExport: { tier: "off" } });
    result = await invoke(["reprocess", "run-1", "--chart-export", "models", "--estimate"], respond);
    assert.match(result.requests[0].url, /\/reprocess\/estimate$/);
    assert.deepEqual(JSON.parse(result.requests[0].body), { chartExport: { tier: "models" } });

    result = await invoke(["upload", file, "--chart-export", "models", "--estimate"], respond);
    assert.match(result.requests[0].url, /\/v1\/uploads\/estimate$/);
    assert.deepEqual(JSON.parse(result.requests[0].body).chartExport, { tier: "models" });

    // Without the flag the project's setting (or the API default, off) applies: nothing is sent.
    result = await invoke(["upload", file], respond);
    assert.doesNotMatch(result.requests[0].body, /chartExport/);

    for (const bad of ["smart", "on", ""]) {
      result = await invoke(["upload", file, "--chart-export", bad], respond);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--chart-export must be off, free or models|--chart-export needs a value/);
      assert.deepEqual(result.requests, []);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("--quality sends pipeline.quality on upload and ingest-url, and rejects unknown modes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "note.txt");
    await writeFile(file, "Plain text");
    const respond = () => ({ body: { run: { id: "run" }, project: { id: "project", name: "Docs" }, documents: [{}] } });
    let result = await invoke(["upload", file, "--quality", "fast"], respond);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.requests[0].body, /name="pipeline"\r\n\r\n\{"quality":"fast"\}/);

    result = await invoke(["ingest-url", "https://example.test/a.pdf", "--quality", "good"], respond);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.requests[0].body).pipeline, { quality: "good" });

    // Without --quality the project setting applies.
    result = await invoke(["upload", file], respond);
    assert.doesNotMatch(result.requests[0].body, /name="pipeline"/);

    result = await invoke(["upload", file, "--quality", "deep"], respond);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--quality must be fast, auto or good/);
    assert.deepEqual(result.requests, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ingest-url --estimate prices the URLs and never starts an ingest (council #387 M1)", async () => {
  const estimate = { estimate: { pages: 4, documents: 1, billing: "enforced", credits: { low: 1, high: 2 }, seconds: null, basis: "b" } };
  const respond = (request) => request.method === "HEAD"
    ? { headers: { "content-length": "2400000", "content-type": "application/pdf; charset=binary" }, body: null }
    : { body: estimate };
  const result = await invoke(["ingest-url", "{{server}}/files/q3-earnings.pdf", "--chart-export", "models", "--quality", "good", "--project", "w", "--estimate"], respond);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.requests.map((r) => [r.method, r.url]), [["HEAD", "/files/q3-earnings.pdf"], ["POST", "/v1/uploads/estimate"]]);
  assert.deepEqual(JSON.parse(result.requests[1].body), {
    files: [{ name: "q3-earnings.pdf", size: 2400000, type: "application/pdf" }], project: "w", chartExport: { tier: "models" }, settings: { quality: "good" },
  });
  assert.ok(!result.requests.some((r) => r.url === "/v1/uploads/url"));
  assert.match(result.stdout, /nothing was started/);
});

test("ingest-url --estimate fails, sending nothing to DocSlurp, when a URL reports no size", async () => {
  const respond = (request) => request.method === "HEAD" ? { status: 404, body: null } : { body: {} };
  const result = await invoke(["ingest-url", "{{server}}/missing.pdf", "--estimate"], respond);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /reports no size/);
  assert.deepEqual(result.requests.map((r) => r.method), ["HEAD"]);
});

test("a flag can never swallow --estimate: unknown flags, --flag=value and missing values (council #387 r2 M1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-cli-"));
  try {
    const file = join(dir, "q3.pdf");
    await writeFile(file, "%PDF-1.4 tiny");
    const respond = (request) => request.method === "HEAD"
      ? { headers: { "content-length": "123456", "content-type": "application/pdf" }, body: null }
      : { body: { estimate: { pages: 1, documents: 1, billing: "enforced", credits: { low: 1, high: 1 }, seconds: null, basis: "b" } } };
    const url = "{{server}}/files/q3.pdf";
    // The reviewer's repro, on both commands: each refused before anything reaches DocSlurp.
    const refused = [
      [["ingest-url", url, "--yes", "--estimate"], /Unknown flag --yes/],
      [["ingest-url", url, "--estimate=true"], /--estimate takes no value/],
      [["ingest-url", "--dry-run", "--estimate", url], /Unknown flag --dry-run/],
      [["ingest-url", "--project", "--estimate", url], /--project needs a value/],
      [["upload", file, "--yes", "--estimate"], /Unknown flag --yes/],
      [["upload", file, "--estimate=true"], /--estimate takes no value/],
      [["upload", "--dry-run", "--estimate", file], /Unknown flag --dry-run/],
      [["upload", "--project", "--estimate", file], /--project needs a value/],
      [["upload", file, "--chart-export"], /--chart-export needs a value/],
    ];
    for (const [args, message] of refused) {
      const result = await invoke(args, respond);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(result.stderr, message, args.join(" "));
      assert.deepEqual(result.requests, [], args.join(" "));
    }
    // --flag=value works, and the estimate still only estimates.
    const ok = await invoke(["ingest-url", url, "--chart-export=models", "--project=w", "--estimate"], respond);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(ok.requests.map((r) => [r.method, r.url]), [["HEAD", "/files/q3.pdf"], ["POST", "/v1/uploads/estimate"]]);
    assert.deepEqual(JSON.parse(ok.requests[1].body), { files: [{ name: "q3.pdf", size: 123456, type: "application/pdf" }], project: "w", chartExport: { tier: "models" } });
    const upload = await invoke(["upload", file, "--chart-export=free", "--estimate"], respond);
    assert.equal(upload.code, 0, upload.stderr);
    assert.deepEqual(upload.requests.map((r) => r.url), ["/v1/uploads/estimate"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ingest-url checks every URL before sending anything: dash-led words, non-URLs, other schemes, credentials (council #387 r3)", async () => {
  const respond = () => ({ body: { run: { id: "run" }, project: { id: "p", name: "P" }, documents: [{}] } });
  const cases = [
    ["-e", /looks like a flag/], ["-estimate", /looks like a flag/], ["\u2014estimate", /looks like a flag/], ["\u2013estimate", /looks like a flag/],
    ["\u2212estimate", /looks like a flag/], ["\uFF0Destimate", /looks like a flag/],
    ["q3-earnings.pdf", /is not a URL/], ["ftp://example.test/a.pdf", /not an http\(s\) URL/], ["https://user:pw@example.test/a.pdf", /credentials/],
  ];
  for (const [bad, message] of cases) {
    for (const extra of [[], ["--estimate"]]) {
      const result = await invoke(["ingest-url", "https://example.test/ok.pdf", bad, ...extra], respond);
      assert.notEqual(result.code, 0, `${bad} ${extra.join(" ")}`);
      assert.match(result.stderr, message, bad);
      assert.deepEqual(result.requests, [], bad);
    }
  }
});

test("an empty flag value is an error, never a silent default (--project=)", async () => {
  for (const args of [["ingest-url", "https://example.test/a.pdf", "--project="], ["search", "q", "--project="], ["ingest-url", "https://example.test/a.pdf", "--project", " "]]) {
    const result = await invoke(args, () => ({ body: {} }));
    assert.notEqual(result.code, 0, args.join(" "));
    assert.match(result.stderr, /--project needs a value/);
    assert.deepEqual(result.requests, []);
  }
});

test("--estimate is refused on commands that do not estimate, before any request", async () => {
  for (const args of [["extract", "https://example.test/a.pdf", "--estimate"], ["search", "q", "--estimate"]]) {
    const result = await invoke(args, () => ({ body: {} }));
    assert.notEqual(result.code, 0, args.join(" "));
    assert.match(result.stderr, /--estimate is not supported by/);
    assert.deepEqual(result.requests, []);
  }
});

async function invokeStream(args, handler, options = {}) {
  // Like invoke(), but the handler controls the raw response (SSE bodies, status codes, content types).
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
    await handler(request, response, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ["dist/index.js", ...args, "--api-url", `${url}/`], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", DOCSLURP_API_KEY: "test-key", DOCSLURP_URL: "https://ignored-env.test", DOCSLURP_PROJECT: options.project ?? "project" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const kill = setTimeout(() => child.kill(), 4000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(kill);
    return { code, stdout, stderr, requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const streamHit = { score: 1, text: "Quarterly revenue beat the forecast by 12 percent", citation: { documentId: "d1", chunkIndex: 0, filename: "earnings.pdf", pageNumber: 4 } };
const streamFinal = { results: [streamHit], sessionId: "sess", availability: null };
const streamEvents = [
  { searchId: "s", seq: 0, elapsedMs: 1, type: "search.started", protocol: 1, projectId: "project", cached: false },
  { searchId: "s", seq: 1, elapsedMs: 30, type: "search.hits", leg: "vector", hits: [{ id: "document:d1:0", legRank: 0, result: streamHit }], truncated: false, stats: { ms: 29, candidates: 8 } },
  { searchId: "s", seq: 2, elapsedMs: 40, type: "search.results", ids: ["document:d1:0"], response: streamFinal },
  { searchId: "s", seq: 3, elapsedMs: 41, type: "search.done", sessionId: "sess", resultCount: 1 },
];
const writeSse = (response, events, chunk = 17) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const text = ": hb\r\n\r\n" + events.map((e) => `event: ${e.type}\r\nid: ${e.seq}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join("");
  for (let i = 0; i < text.length; i += chunk) response.write(text.slice(i, i + chunk));
  response.end();
};

test("search --stream prints legs as they land and the final ranking; --stats adds per-leg ms", async () => {
  const result = await invokeStream(["search", "revenue", "--stream", "--stats"], (_req, res) => writeSse(res, streamEvents));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "/v1/search/stream");
  assert.equal(result.requests[0].method, "POST");
  assert.equal(result.requests[0].headers.accept, "text/event-stream");
  assert.deepEqual(JSON.parse(result.requests[0].body), { q: "revenue", project: "project", stats: true });
  assert.match(result.stderr, /\[vector\] 1 hit 29ms, 8 candidates/);
  assert.match(result.stderr, /vector #1 earnings\.pdf \(p\.4\)/);
  assert.match(result.stdout, /Final ranking/);
  assert.match(result.stdout, /earnings\.pdf \(p\.4\)/);
});

test("search --stream accepts a search.results frame larger than 1 MiB", async () => {
  const big = { ...streamHit, text: "y".repeat(3 * 1_048_576) };
  const events = streamEvents.map((e) => e.type === "search.results" ? { ...e, response: { ...streamFinal, results: [big] } } : e);
  const result = await invokeStream(["search", "revenue", "--stream", "--json"], (_req, res) => writeSse(res, events, 65536));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").map((line) => JSON.parse(line).type), events.map((e) => e.type));
});

test("search --stream --json prints one event per line", async () => {
  const result = await invokeStream(["search", "revenue", "--stream", "--json"], (_req, res) => writeSse(res, streamEvents));
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((e) => e.type), streamEvents.map((e) => e.type));
  assert.equal(result.stderr, "");
});

test("search --stream falls back to the JSON endpoint only when the stream never started", async () => {
  for (const first of [
    (res) => { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); },
    (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); },
  ]) {
    const result = await invokeStream(["search", "revenue", "--stream", "--json"], (req, res) => {
      if (req.url === "/v1/search/stream") return first(res);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(streamFinal));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.requests.map((r) => r.url.split("?")[0]), ["/v1/search/stream", "/v1/search"]);
    const types = result.stdout.trim().split("\n").map((line) => JSON.parse(line).type);
    assert.equal(types.at(-2), "search.results");
    assert.equal(types.at(-1), "search.done");
  }
});

test("search --stream never issues a second search after the stream started", async () => {
  const dropped = (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`event: search.started\ndata: ${JSON.stringify(streamEvents[0])}\n\n`); setTimeout(() => res.destroy(), 20); };
  const cases = [
    (res) => writeSse(res, streamEvents.slice(0, 2)),
    dropped,
    (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: search.started\ndata: ${JSON.stringify(streamEvents[0])}\n\nevent: search.hits\ndata: {oops\n\n`); },
    (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: search.started\ndata: ${JSON.stringify(streamEvents[0])}\n\ndata: ${"x".repeat(1_100_000)}\n\n`); },
  ];
  for (const first of cases) {
    const result = await invokeStream(["search", "revenue", "--stream"], (req, res) => {
      if (req.url === "/v1/search/stream") return first(res);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(streamFinal));
    });
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.requests.map((r) => r.url.split("?")[0]), ["/v1/search/stream"]);
    assert.match(result.stderr, /Not retried/);
  }
  // A drop after search.results still prints the answer, with no second request.
  const late = await invokeStream(["search", "revenue", "--stream"], (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(streamEvents.slice(0, 3).map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    setTimeout(() => res.destroy(), 20);
  });
  assert.equal(late.code, 0, late.stderr);
  assert.equal(late.requests.length, 1);
  assert.match(late.stdout, /Final ranking/);
});

test("search --stream reports a later leg's body-less hit as found by the earlier leg; NDJSON stays verbatim", async () => {
  const events = [
    streamEvents[0], streamEvents[1],
    { searchId: "s", seq: 2, elapsedMs: 35, type: "search.hits", leg: "lexical", hits: [{ id: "document:d1:0", legRank: 2 }], truncated: false },
    { ...streamEvents[2], seq: 3 }, { ...streamEvents[3], seq: 4 },
  ];
  const text = await invokeStream(["search", "revenue", "--stream"], (_req, res) => writeSse(res, events));
  assert.match(text.stderr, /lexical #3 also found by vector #1 \(earnings\.pdf, p\.4\)/);
  assert.doesNotMatch(text.stderr, /lexical #3 earnings/);
  const nd = await invokeStream(["search", "revenue", "--stream", "--json"], (_req, res) => writeSse(res, events));
  assert.deepEqual(nd.stdout.trim().split("\n").map((line) => JSON.parse(line)), events);
});

test("search --stream falls back when the connection fails before any response", async () => {
  const result = await invokeStream(["search", "revenue", "--stream", "--json"], (req, res) => {
    if (req.url === "/v1/search/stream") return res.destroy();
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(streamFinal));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.requests.map((r) => r.url.split("?")[0]), ["/v1/search/stream", "/v1/search"]);
});

test("search --stream does not fall back on auth errors and surfaces search.error", async () => {
  const denied = await invokeStream(["search", "revenue", "--stream"], (_req, res) => { res.writeHead(403, { "content-type": "application/json" }); res.end("{}"); });
  assert.notEqual(denied.code, 0);
  assert.equal(denied.requests.length, 1);
  const failed = await invokeStream(["search", "revenue", "--stream"], (_req, res) => writeSse(res, [streamEvents[0], { searchId: "s", seq: 1, elapsedMs: 2, type: "search.error", error: { code: "rate_limited", message: "internal", status: 429 } }]));
  assert.notEqual(failed.code, 0);
  assert.equal(failed.requests.length, 1);
  assert.doesNotMatch(failed.stderr, /internal/);
  const stats = await invokeStream(["search", "revenue", "--stats"], () => {});
  assert.notEqual(stats.code, 0);
  assert.match(stats.stderr, /--stats requires --stream/);
});

test("search without --stream is unchanged", async () => {
  const result = await invoke(["search", "revenue"], () => ({ body: streamFinal }), { project: "project" });
  assert.equal(result.requests[0].method, "GET");
  assert.doesNotMatch(result.stdout, /Final ranking/);
});
