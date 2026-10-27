import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * docslurp login / logout / whoami / auth token / exec against a fake
 * DocSlurp authorization server. The test plays the browser by reading the
 * authorize URL the CLI prints and calling its loopback callback.
 */

function fakeServer(options = {}) {
  const state = { requests: [], authorize: null, access: "dscli_access_1", refresh: "dsclir_refresh_1", issued: 1, devicePolls: 0, revoked: [] };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url, "http://x");
    state.requests.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization, body });
    const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const origin = `http://127.0.0.1:${server.address().port}`;
    const issue = () => {
      state.issued++;
      state.access = `dscli_access_${state.issued}`;
      state.refresh = `dsclir_refresh_${state.issued}`;
      return { access_token: state.access, refresh_token: state.refresh, token_type: "Bearer", expires_in: 900, scope: "search read" };
    };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: options.issuer ?? origin,
        authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`,
        revocation_endpoint: `${origin}/oauth/mcp/revoke`, device_authorization_endpoint: `${origin}/oauth/mcp/device_authorization`,
      });
    }
    if (url.pathname === "/oauth/mcp/token") {
      const form = new URLSearchParams(body);
      assert.equal(form.get("client_id"), "docslurp-cli");
      assert.equal(form.get("resource"), `${origin}/v1`);
      if (form.get("grant_type") === "authorization_code") {
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (form.get("code") !== "good-code" || challenge !== state.authorize?.get("code_challenge") || form.get("redirect_uri") !== state.authorize?.get("redirect_uri")) return send(400, { error: "invalid_grant" });
        return send(200, issue());
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshCalls = (state.refreshCalls ?? 0) + 1;
        if (options.anyRefresh && String(form.get("refresh_token")).startsWith("dsclir_")) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return send(200, issue());
        }
        if (options.refreshFails || form.get("refresh_token") !== state.refresh) return send(400, { error: "invalid_grant", error_description: "The grant was revoked." });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return send(200, issue());
      }
      if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        state.devicePolls++;
        const script = options.deviceScript ?? ["authorization_pending", "ok"];
        const step = script[Math.min(state.devicePolls - 1, script.length - 1)];
        return step === "ok" ? send(200, issue()) : send(400, { error: step });
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/oauth/mcp/device_authorization") {
      const form = new URLSearchParams(body);
      state.deviceRequest = form;
      return send(200, { device_code: "dsclid_device", user_code: "WDJB-MJHT", verification_uri: options.verificationUri ?? `${origin}/oauth/mcp/device`, expires_in: 600, interval: 1 });
    }
    if (url.pathname === "/oauth/mcp/revoke") {
      if (options.revokeFails) return send(503, {});
      state.revoked.push(new URLSearchParams(body).get("token"));
      return send(200, {});
    }
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    if (url.pathname === "/v1/whoami") {
      if (bearer !== state.access && !String(bearer).startsWith("env-") && !String(bearer).startsWith("key-")) return send(401, { error: "unauthorized" });
      return send(200, { user: { id: "owner", email: "owner@example.test", name: "Owner" }, organization: { id: "org", name: "Acme" }, defaultWorkspace: { id: "ws", name: "Default", slug: "default" }, credential: { type: "oauth", scopes: ["search", "read"], apiKeyScopes: ["search", "artifacts"], expiresAt: new Date(Date.now() + 900_000).toISOString() } });
    }
    if (url.pathname === "/v1/search") return send(200, { results: [] });
    if (url.pathname === "/v1/mcp/tools") return send(bearer === state.access ? 200 : 401, { tools: [] });
    send(404, {});
  });
  return {
    state,
    async start() { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "docslurp-cli-auth-"));
  return { root, config: join(root, "config"), dispose: () => rm(root, { recursive: true, force: true }) };
}

function cli(args, { url, config, env = {}, onStderr, input, timeoutMs = 20_000 } = {}) {
  const child = spawn(process.execPath, ["dist/index.js", ...args], {
    cwd: new URL("..", import.meta.url),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
      DOCSLURP_URL: url, XDG_CONFIG_HOME: config, DOCSLURP_CREDENTIAL_STORE: "file", DOCSLURP_NO_BROWSER: "1", ...env,
    },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; onStderr?.(stderr, child); });
  child.stdin.end(input ?? "");
  const kill = setTimeout(() => child.kill(), timeoutMs);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(kill); resolve({ code, stdout, stderr }); });
  });
}

/** Plays the browser: once the CLI prints its authorize URL, call the loopback callback (once per callback given, in order). */
function browser(fake, url, ...callbacks) {
  let done = false;
  return (stderr) => {
    const match = stderr.match(/(http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+)/);
    if (!match || done) return;
    done = true;
    const authorize = new URL(match[1]);
    fake.state.authorize = authorize.searchParams;
    fake.state.callbackStatuses = [];
    (async () => {
      for (const callback of callbacks) {
        const redirect = new URL(authorize.searchParams.get("redirect_uri"));
        for (const [key, value] of Object.entries(callback(authorize.searchParams, url))) redirect.searchParams.set(key, value);
        const response = await fetch(redirect).catch(() => null);
        fake.state.callbackStatuses.push(response?.status ?? 0);
      }
    })();
  };
}

async function writeStored(config, url, credential, { fileMode = 0o600, dirMode = 0o700 } = {}) {
  const dir = join(config, "docslurp");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "credentials.json");
  await writeFile(file, JSON.stringify({ version: 1, credentials: { [`default@${url}`]: {
    version: 1, apiUrl: url, profile: "default", clientId: "docslurp-cli", scopes: ["search", "read"], updatedAt: new Date().toISOString(),
    accessToken: "dscli_access_1", refreshToken: "dsclir_refresh_1", accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(), ...credential,
  } } }));
  await chmod(file, fileMode);
  await chmod(dir, dirMode);
  return file;
}

test("login: loopback authorization code with PKCE, least-privilege scopes, private storage", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    const result = await cli(["login"], { url, config: box.config, onStderr: browser(fake, url, (params, origin) => ({ code: "good-code", state: params.get("state"), iss: origin })) });
    assert.equal(result.code, 0, result.stderr);
    const authorize = fake.state.authorize;
    assert.equal(authorize.get("client_id"), "docslurp-cli");
    assert.equal(authorize.get("code_challenge_method"), "S256");
    assert.equal(authorize.get("scope"), "search read");
    assert.equal(authorize.get("resource"), `${url}/v1`);
    assert.match(authorize.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.ok(authorize.get("state").length >= 43);
    assert.match(result.stdout, /Signed in to .* as owner@example\.test/);
    assert.match(result.stdout, /Organization: Acme/);
    assert.match(result.stdout, /Default workspace: Default/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(fake.state.access), "token printed");
    const file = join(box.config, "docslurp", "credentials.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(box.config, "docslurp"))).mode & 0o777, 0o700);
    const stored = JSON.parse(await readFile(file, "utf8")).credentials[`default@${url}`];
    assert.equal(stored.refreshToken, fake.state.refresh);
  } finally { await fake.close(); await box.dispose(); }
});

test("login: --scopes is validated and forwarded", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    const bad = await cli(["login", "--scopes", "search admin"], { url, config: box.config });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Unknown scope admin/);
    const ok = await cli(["login", "--scopes", "search ingest"], { url, config: box.config, onStderr: browser(fake, url, (params, origin) => ({ code: "good-code", state: params.get("state"), iss: origin })) });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(fake.state.authorize.get("scope"), "search ingest");
  } finally { await fake.close(); await box.dispose(); }
});

test("login: a callback with the wrong state is refused, its code never exchanged, and the login keeps waiting", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    const result = await cli(["login"], { url, config: box.config, onStderr: browser(fake, url,
      (_params, origin) => ({ code: "attacker-code", state: "attacker-state", iss: origin }),
      (params, origin) => ({ code: "good-code", state: params.get("state"), iss: origin })) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.state.callbackStatuses, [400, 200]);
    assert.match(result.stderr, /wrong state/);
    const exchanges = fake.state.requests.filter((r) => r.path === "/oauth/mcp/token");
    assert.equal(exchanges.length, 1);
    assert.equal(new URLSearchParams(exchanges[0].body).get("code"), "good-code");
  } finally { await fake.close(); await box.dispose(); }
});

test("login: a foreign issuer in the callback or in discovery is refused", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    const result = await cli(["login"], { url, config: box.config, onStderr: browser(fake, url, (params) => ({ code: "good-code", state: params.get("state"), iss: "https://attacker.example" })) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unexpected issuer/);
  } finally { await fake.close(); await box.dispose(); }
  const spoof = fakeServer({ issuer: "https://attacker.example" }); const spoofUrl = await spoof.start(); const box2 = await sandbox();
  try {
    const result = await cli(["login"], { url: spoofUrl, config: box2.config });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /identifies as https:\/\/attacker\.example/);
  } finally { await spoof.close(); await box2.dispose(); }
});

test("login --device: prints the code, honours slow_down and stores the login", async () => {
  const fake = fakeServer({ deviceScript: ["authorization_pending", "slow_down", "ok"] }); const url = await fake.start(); const box = await sandbox();
  try {
    const result = await cli(["login", "--device", "--scopes", "search"], { url, config: box.config, timeoutMs: 30_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /WDJB-MJHT/);
    assert.match(result.stderr, /\/oauth\/mcp\/device/);
    assert.equal(fake.state.deviceRequest.get("scope"), "search");
    assert.equal(fake.state.devicePolls, 3);
    const polls = fake.state.requests.filter((r) => r.path === "/oauth/mcp/token");
    assert.equal(polls.length, 3);
    assert.match(result.stdout, /Signed in/);
  } finally { await fake.close(); await box.dispose(); }
});

test("login --device: an expired code or a foreign verification page ends the login", async () => {
  const fake = fakeServer({ deviceScript: ["expired_token"] }); const url = await fake.start(); const box = await sandbox();
  try {
    const result = await cli(["login", "--device"], { url, config: box.config });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /expired/);
  } finally { await fake.close(); await box.dispose(); }
  const phish = fakeServer({ verificationUri: "https://attacker.example/device" }); const phishUrl = await phish.start(); const box2 = await sandbox();
  try {
    const result = await cli(["login", "--device"], { url: phishUrl, config: box2.config });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not on the DocSlurp server/);
    assert.ok(!result.stderr.includes("WDJB-MJHT"));
  } finally { await phish.close(); await box2.dispose(); }
});

test("stored credentials with insecure permissions are refused before any request", async () => {
  for (const modes of [{ fileMode: 0o644 }, { dirMode: 0o755 }]) {
    const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
    try {
      await writeStored(box.config, url, {}, modes);
      const result = await cli(["search", "renewal"], { url, config: box.config });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /too open/);
      assert.equal(fake.state.requests.length, 0);
    } finally { await fake.close(); await box.dispose(); }
  }
});

test("a symlinked credentials file is refused", async () => {
  const { symlink } = await import("node:fs/promises");
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    const file = await writeStored(box.config, url, {});
    const real = join(box.root, "elsewhere.json");
    await writeFile(real, await readFile(file, "utf8"), { mode: 0o600 });
    await rm(file);
    await symlink(real, file);
    const result = await cli(["search", "q"], { url, config: box.config });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /symbolic link/);
    assert.equal(fake.state.requests.length, 0);
  } finally { await fake.close(); await box.dispose(); }
});

test("concurrent refreshes neither lose another profile's login nor spend one refresh token twice", async () => {
  const many = fakeServer({ anyRefresh: true }); const url = await many.start(); const box = await sandbox();
  try {
    const file = await writeStored(box.config, url, { accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const data = JSON.parse(await readFile(file, "utf8"));
    data.credentials[`work@${url}`] = { ...data.credentials[`default@${url}`], profile: "work", refreshToken: "dsclir_work" };
    await writeFile(file, JSON.stringify(data));
    const results = await Promise.all([
      cli(["search", "q"], { url, config: box.config }),
      cli(["search", "q", "--profile", "work"], { url, config: box.config }),
    ]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const stored = JSON.parse(await readFile(file, "utf8")).credentials;
    assert.notEqual(stored[`default@${url}`].refreshToken, "dsclir_refresh_1");
    assert.notEqual(stored[`work@${url}`].refreshToken, "dsclir_work");
    assert.notEqual(stored[`default@${url}`].refreshToken, stored[`work@${url}`].refreshToken);
  } finally { await many.close(); await box.dispose(); }
  const strict = fakeServer(); const strictUrl = await strict.start(); const box2 = await sandbox();
  try {
    await writeStored(box2.config, strictUrl, { accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const results = await Promise.all([1, 2, 3].map(() => cli(["search", "q"], { url: strictUrl, config: box2.config })));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(strict.state.refreshCalls, 1, "only one process may spend the refresh token");
  } finally { await strict.close(); await box2.dispose(); }
});

test("precedence: --api-key > DOCSLURP_API_KEY > DOCSLURP_TOKEN > stored login", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    await writeStored(box.config, url, {});
    const bearer = async (args, env) => {
      fake.state.requests.length = 0;
      const result = await cli(["search", "q", ...args], { url, config: box.config, env });
      assert.equal(result.code, 0, result.stderr);
      return fake.state.requests.find((r) => r.path === "/v1/search").authorization;
    };
    assert.equal(await bearer([], {}), "Bearer dscli_access_1");
    assert.equal(await bearer([], { DOCSLURP_TOKEN: "env-token" }), "Bearer env-token");
    assert.equal(await bearer([], { DOCSLURP_TOKEN: "env-token", DOCSLURP_API_KEY: "key-env" }), "Bearer key-env");
    assert.equal(await bearer(["--api-key", "key-flag"], { DOCSLURP_TOKEN: "env-token", DOCSLURP_API_KEY: "key-env" }), "Bearer key-flag");
  } finally { await fake.close(); await box.dispose(); }
});

test("a stored login refreshes before expiry and persists the rotated refresh token", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    const file = await writeStored(box.config, url, { accessTokenExpiresAt: new Date(Date.now() + 10_000).toISOString() });
    const result = await cli(["search", "q"], { url, config: box.config });
    assert.equal(result.code, 0, result.stderr);
    const refresh = fake.state.requests.find((r) => r.path === "/oauth/mcp/token");
    assert.equal(new URLSearchParams(refresh.body).get("grant_type"), "refresh_token");
    assert.equal(fake.state.requests.find((r) => r.path === "/v1/search").authorization, `Bearer ${fake.state.access}`);
    const stored = JSON.parse(await readFile(file, "utf8")).credentials[`default@${url}`];
    assert.equal(stored.refreshToken, fake.state.refresh);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await fake.close(); await box.dispose(); }
});

test("a refresh failure asks for a new login", async () => {
  const fake = fakeServer({ refreshFails: true }); const url = await fake.start(); const box = await sandbox();
  try {
    await writeStored(box.config, url, { accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const result = await cli(["search", "q"], { url, config: box.config });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /expired or was revoked\. Run `docslurp login`/);
    assert.equal(fake.state.requests.filter((r) => r.path === "/v1/search").length, 0);
  } finally { await fake.close(); await box.dispose(); }
});

test("auth token prints only the access token; whoami and auth status describe the credential", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    await writeStored(box.config, url, {});
    const token = await cli(["auth", "token"], { url, config: box.config });
    assert.equal(token.code, 0, token.stderr);
    assert.equal(token.stdout, "dscli_access_1\n");
    const who = await cli(["whoami"], { url, config: box.config });
    assert.equal(who.code, 0, who.stderr);
    assert.match(who.stdout, /Signed in as owner@example\.test/);
    assert.match(who.stdout, /Scopes: search read/);
    assert.match(who.stdout, /Credential: stored login \(file .*credentials\.json\)/);
    assert.ok(!who.stdout.includes("dscli_access_1"));
    const status = await cli(["auth", "status", "--json"], { url, config: box.config, env: { DOCSLURP_TOKEN: "env-token" } });
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.credentialSource, "env DOCSLURP_TOKEN");
    assert.equal(parsed.shadowedStoredLogin, true);
    assert.ok(!status.stdout.includes("env-token"));
    const echoed = await cli(["auth", "token"], { url, config: box.config, env: { DOCSLURP_TOKEN: "env-token" } });
    assert.equal(echoed.stdout, "env-token\n");
    assert.match(echoed.stderr, /not freshly issued/);
    const refused = await cli(["auth", "token"], { url, config: box.config, env: { DOCSLURP_API_KEY: "key-env" } });
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
  } finally { await fake.close(); await box.dispose(); }
});

test("exec passes a fresh token in the child environment only, never argv, and keeps its exit code", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    await writeStored(box.config, url, {});
    const script = "console.log(JSON.stringify({ argv: process.argv, token: process.env.DOCSLURP_TOKEN, url: process.env.DOCSLURP_URL, ws: process.env.DOCSLURP_WORKSPACE, key: process.env.DOCSLURP_API_KEY ?? null })); process.exit(3)";
    const result = await cli(["exec", "--workspace", "contracts", "--", process.execPath, "-e", script, "--", "--help"], { url, config: box.config });
    assert.equal(result.code, 3, result.stderr);
    const child = JSON.parse(result.stdout);
    assert.equal(child.token, "dscli_access_1");
    assert.equal(child.url, url);
    assert.equal(child.ws, "contracts");
    assert.equal(child.key, null);
    assert.ok(!child.argv.some((arg) => arg.includes("dscli_")), "token leaked into argv");
    assert.ok(child.argv.includes("--help"), "arguments after -- reach the child untouched");
    const files = JSON.stringify(await readFile(join(box.config, "docslurp", "credentials.json"), "utf8"));
    assert.ok(!files.includes("DOCSLURP_TOKEN"));
    const refused = await cli(["exec", "--", process.execPath, "-e", "process.exit(0)"], { url, config: box.config, env: { DOCSLURP_API_KEY: "key-env" } });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /long-lived API key/);
  } finally { await fake.close(); await box.dispose(); }
});

test("logout revokes server-side, then deletes locally; a failed revocation keeps the login unless --force", async () => {
  const failing = fakeServer({ revokeFails: true }); const failingUrl = await failing.start(); const box = await sandbox();
  try {
    const file = await writeStored(box.config, failingUrl, {});
    const kept = await cli(["logout"], { url: failingUrl, config: box.config });
    assert.equal(kept.code, 1);
    assert.match(kept.stderr, /--force/);
    assert.ok(JSON.parse(await readFile(file, "utf8")).credentials[`default@${failingUrl}`]);
    const forced = await cli(["logout", "--force"], { url: failingUrl, config: box.config });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(JSON.parse(await readFile(file, "utf8")).credentials[`default@${failingUrl}`], null);
  } finally { await failing.close(); await box.dispose(); }
  const fake = fakeServer(); const url = await fake.start(); const box2 = await sandbox();
  try {
    const file = await writeStored(box2.config, url, {});
    const result = await cli(["logout"], { url, config: box2.config });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.state.revoked, ["dsclir_refresh_1"]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).credentials[`default@${url}`], null);
  } finally { await fake.close(); await box2.dispose(); }
});

test("profiles and API URLs keep separate logins", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    await writeStored(box.config, url, {});
    const other = await cli(["whoami", "--profile", "work"], { url, config: box.config });
    assert.equal(other.code, 1);
    assert.match(other.stderr, /Not signed in .*profile work/);
    const bad = await cli(["whoami", "--profile", "../etc"], { url, config: box.config });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--profile must be/);
  } finally { await fake.close(); await box.dispose(); }
});

test("mcp server mode uses the stored login without an API key", async () => {
  const fake = fakeServer(); const url = await fake.start(); const box = await sandbox();
  try {
    await writeStored(box.config, url, {});
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const result = await cli(["mcp"], { url, config: box.config, input: lines });
    assert.equal(result.code, 0, result.stderr);
    const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(responses[1].result, { tools: [] });
    assert.equal(fake.state.requests.find((r) => r.path === "/v1/mcp/tools").authorization, "Bearer dscli_access_1");
  } finally { await fake.close(); await box.dispose(); }
});

test("secret-receiving helpers come only from system directories, never PATH or the working directory", async () => {
  const { trustedUnixBinary, windowsSystemBinary } = await import("../dist/auth/credentials.js");
  const box = await sandbox();
  const previous = { PATH: process.env.PATH, cwd: process.cwd(), SystemRoot: process.env.SystemRoot };
  try {
    await mkdir(box.root, { recursive: true });
    const planted = join(box.root, "docslurp-planted-helper");
    await writeFile(planted, "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = `${box.root}:${process.env.PATH}`;
    process.chdir(box.root);
    assert.equal(trustedUnixBinary("docslurp-planted-helper"), null);
    process.env.SystemRoot = "C:\\Windows";
    assert.equal(windowsSystemBinary("WindowsPowerShell", "v1.0", "powershell.exe"), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  } finally {
    process.chdir(previous.cwd);
    process.env.PATH = previous.PATH;
    if (previous.SystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous.SystemRoot;
    await box.dispose();
  }
});

test("exec on Windows resolves PATHEXT and runs batch shims through cmd.exe with escaped arguments", async () => {
  const { resolveWindowsCommand, windowsSpawn, escapeCmdArgument } = await import("../dist/auth/windows-exec.js");
  const files = new Set(["C:\\node\\npm.cmd", "C:\\tools\\git.exe", ".\\npm.cmd"]);
  const exists = (path) => files.has(path);
  const env = { PATH: "C:\\node;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  assert.equal(resolveWindowsCommand("npm", env, exists), "C:\\node\\npm.cmd");
  assert.equal(resolveWindowsCommand("git", env, exists), "C:\\tools\\git.exe");
  assert.equal(resolveWindowsCommand("missing", env, exists), null);
  // A planted shim in the working directory is never chosen for a bare name.
  assert.equal(resolveWindowsCommand("npm", { ...env, PATH: "" }, exists), null);
  assert.deepEqual(windowsSpawn("git", ["status"], env, exists), { file: "C:\\tools\\git.exe", args: ["status"], verbatim: false });
  const shim = windowsSpawn("npm", ["run", "build & calc", 'say "hi"'], env, exists);
  assert.equal(shim.file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(shim.verbatim, true);
  assert.deepEqual(shim.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(!/[^^]&/.test(shim.args[3]), "an unescaped & would start a second command");
  assert.equal(escapeCmdArgument("a&b"), '^^^"a^^^&b^^^"');
});

const lockModule = new URL("../dist/auth/credentials.js", import.meta.url).href;
/** A separate process that takes the credentials lock, logs enter/exit times, and holds it for holdMs. */
function lockHolder(config, holdMs, log, env = {}) {
  const script = `
    import { appendFileSync } from "node:fs";
    const { withCredentialLock } = await import(${JSON.stringify(lockModule)});
    await withCredentialLock(async () => {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, at: "enter", t: Date.now() }) + "\\n");
      process.stdout.write("locked\\n");
      await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, at: "exit", t: Date.now() }) + "\\n");
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, XDG_CONFIG_HOME: config, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const locked = new Promise((resolve) => child.stdout.on("data", (data) => { if (String(data).includes("locked")) resolve(); }));
  const done = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
  return { child, locked, done };
}
const readLog = async (log) => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
function assertNoOverlap(entries) {
  const spans = new Map();
  for (const entry of entries) spans.set(entry.pid, { ...spans.get(entry.pid), [entry.at]: entry.t });
  const sorted = [...spans.values()].sort((a, b) => a.enter - b.enter);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].enter >= sorted[i - 1].exit, `lock holders overlapped: ${JSON.stringify(sorted)}`);
  return sorted.length;
}

test("lock: a holder killed with Ctrl-C (SIGINT) does not block the next process", async () => {
  const box = await sandbox();
  try {
    const log = join(box.root, "log");
    const holder = lockHolder(box.config, 60_000, log);
    await holder.locked;
    holder.child.kill("SIGINT");
    await holder.done;
    const lockFile = join(box.config, "docslurp", "credentials.lock");
    assert.ok((await stat(lockFile)).isFile(), "the crashed holder leaves its lock behind");
    const begin = Date.now();
    const next = lockHolder(box.config, 10, log);
    const result = await next.done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - begin < 5_000, "a dead holder's lock is broken at once, not after the stale timeout");
    await assert.rejects(stat(lockFile));
  } finally { await box.dispose(); }
});

test("lock: two waiters racing to break a stale lock never hold it together", async () => {
  const box = await sandbox();
  try {
    const dir = join(box.config, "docslurp");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lockFile = join(dir, "credentials.lock");
    // A lock from another host (so its pid cannot be checked) whose holder stopped refreshing it.
    await writeFile(lockFile, JSON.stringify({ pid: 1, host: "some-other-host", nonce: "old" }), { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lockFile, old, old);
    const log = join(box.root, "log");
    const env = { DOCSLURP_CREDENTIAL_LOCK_STALE_MS: "1000" };
    const racers = [lockHolder(box.config, 300, log, env), lockHolder(box.config, 300, log, env), lockHolder(box.config, 300, log, env)];
    for (const racer of racers) assert.equal((await racer.done).code, 0);
    assert.equal(assertNoOverlap(await readLog(log)), 3);
  } finally { await box.dispose(); }
});

test("lock: a holder working longer than the stale threshold keeps its lock", async () => {
  const box = await sandbox();
  try {
    const log = join(box.root, "log");
    const env = { DOCSLURP_CREDENTIAL_LOCK_STALE_MS: "600" };
    const long = lockHolder(box.config, 2_500, log, env);
    await long.locked;
    const waiter = lockHolder(box.config, 10, log, env);
    assert.equal((await long.done).code, 0);
    assert.equal((await waiter.done).code, 0);
    assert.equal(assertNoOverlap(await readLog(log)), 2);
  } finally { await box.dispose(); }
});

test("login warns when the approval grants fewer scopes than requested", async () => {
  const fake = fakeServer({ deviceScript: ["ok"] }); const url = await fake.start(); const box = await sandbox();
  try {
    const result = await cli(["login", "--device", "--scopes", "search read chat ingest"], { url, config: box.config });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /granted only search read\. Not granted: chat ingest/);
  } finally { await fake.close(); await box.dispose(); }
});

test("Windows exec treats only PATHEXT extensions as extensions and skips relative PATH entries", async () => {
  const { resolveWindowsCommand } = await import("../dist/auth/windows-exec.js");
  const files = new Set(["C:\\py\\python3.11.exe", "bin\\tool.cmd", "C:\\tools\\tool.cmd"]);
  const exists = (path) => files.has(path);
  const env = { PATH: "C:\\py;bin;.;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolveWindowsCommand("python3.11", env, exists), "C:\\py\\python3.11.exe");
  assert.equal(resolveWindowsCommand("tool", env, exists), "C:\\tools\\tool.cmd");
  assert.equal(resolveWindowsCommand("tool", { ...env, PATH: "bin;." }, exists), null);
});
