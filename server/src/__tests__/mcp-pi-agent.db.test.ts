import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The Pi coding agent (@earendil-works/pi-coding-agent) using DocSlurp as a remote MCP
 * server the way a user configures it: an `mcp.json` entry with only the URL. Pi's own
 * MCP client discovers the OAuth metadata, registers, signs in through its loopback
 * callback, lists the tools and calls them in an agent turn, then refreshes when the
 * access token expires. The DocSlurp side is the real OAuth routes, MCP endpoint and
 * a migrated Postgres. Only the signed-in browser, the document backend behind the
 * tools and the model (Pi's faux provider) are stand-ins, so nothing is billed.
 */

const SESSION_COOKIE = "docslurp-test-session=owner";
const dispatched = vi.hoisted(() => [] as Array<{ path: string; body: unknown; keyId: string }>);
const pool = vi.hoisted(() => ({ current: null as Pool | null }));

vi.mock("../lib/auth.js", () => ({
  auth: { api: { getSession: async () => null } },
  get appDbPool() { return pool.current; },
}));
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/request-actor.js")>(),
  resolveBetterAuthSessionActor: async (headers: Headers) => headers.get("cookie")?.includes(SESSION_COOKIE)
    ? { type: "session", userId: "owner", sessionId: "sess", user: { id: "owner" } }
    : null,
}));
vi.mock("../middleware/rate-limit.js", () => ({ enforceAuthenticatedApiRateLimit: async () => null }));
vi.mock("../services/mcp-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/mcp-tools.js")>(),
  createMcpDispatcher: (actor: { apiKey: { keyId: string } }) => async (path: string, init?: RequestInit) => {
    dispatched.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, keyId: actor.apiKey.keyId });
    if (path === "/tools/search") return Response.json({ results: [{ text: "Renewal is annual.", citation: { filename: "contract.pdf", pageNumber: 2 } }] });
    return Response.json({ error: "Not found" }, { status: 404 });
  },
}));

let stopDb: () => Promise<void>;
let server: ReturnType<typeof serve>;
let origin = "";
let dir = "";

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stopDb = pg.stop;
  const { Pool } = await import("pg");
  pool.current = new Pool({ connectionString: pg.url, max: 1 });
  await pool.current.query(`insert into "user"(id, name, email) values ('owner', 'Owner', 'owner@example.test')`);
  await pool.current.query(`insert into "session"(id, "expiresAt", token, "userId") values ('sess', now() + interval '1 day', 'session-token', 'owner')`);
  await pool.current.query(`insert into organizations(id, name, slug, created_by_user_id) values ('org', 'Org', 'org', 'owner')`);
  await pool.current.query(`insert into org_memberships(org_id, user_id, role) values ('org', 'owner', 'owner')`);

  const { mcpOAuthMetadataRoutes, mcpOAuthRoutes } = await import("../routes/mcp-oauth.js");
  const { mcpRoutes } = await import("../routes/mcp.js");
  const app = new Hono().route("/", mcpOAuthMetadataRoutes).route("/oauth/mcp", mcpOAuthRoutes).route("/v1/mcp", mcpRoutes);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MCP_PUBLIC_URL", origin);
  dir = await mkdtemp(join(tmpdir(), "docslurp-pi-mcp-"));
}, 120_000);

afterAll(async () => {
  if (server) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool.current?.end();
  await stopDb?.();
  if (dir) await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** The signed-in user's browser: open Pi's authorization URL, allow, follow back to Pi's loopback callback. */
async function approveInBrowser(authorizationUrl: string) {
  const start = await fetch(authorizationUrl, { redirect: "manual", headers: { cookie: SESSION_COOKIE } });
  const requestId = new URL(start.headers.get("location")!, origin).searchParams.get("request");
  const decision = await fetch(new URL("/oauth/mcp/authorize", origin), {
    method: "POST", redirect: "manual",
    headers: { cookie: SESSION_COOKIE, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: requestId!, decision: "allow", orgId: "org" }),
  });
  const callback = decision.headers.get("location")!;
  expect(new URL(callback).hostname).toBe("127.0.0.1");
  await fetch(callback);
}

describe("Pi coding agent with DocSlurp as a remote MCP server", () => {
  it("signs in with OAuth, calls DocSlurp search in an agent turn and refreshes expired tokens", async () => {
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    await import("node:fs/promises").then((fs) => Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(cwd, { recursive: true })]));
    // What a user writes: the endpoint only. "direct" declares the tools to the model.
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { docslurp: { url: `${origin}/v1/mcp`, exposure: "direct" } } }));

    // Pi reads mcp.json and keeps mcp-auth.json in its agent directory; never touch the developer's ~/.pi.
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const opened: string[] = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir,
      extensionFactories: [createMcpExtension({ openUrl: (url) => { opened.push(url); void approveInBrowser(url); }, startupWaitMs: 5_000 })],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider();
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
    });
    try {
      // A headless UI, as in Pi's RPC mode: notifications are collected, and the
      // "paste the redirect URL" fallback stays open until the loopback callback lands.
      const notices: string[] = [];
      const ui: Record<string, unknown> = {
        notify: (message: string) => { notices.push(message); },
        input: (_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => new Promise<undefined>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
        select: async () => undefined,
        confirm: async () => false,
      };
      const uiContext = new Proxy(ui, { get: (target, key) => key in target ? target[key as string] : () => undefined });
      await session.bindExtensions({ uiContext: uiContext as never, mode: "rpc" });
      // Pi's sign-in command: discovery, dynamic registration, PKCE and the loopback callback.
      await session.prompt("/mcp login docslurp");
      expect(opened, notices.join("\n")).toHaveLength(1);
      expect(notices.join("\n")).toContain('Signed in to MCP server "docslurp"');
      const authorizeUrl = new URL(opened[0]!);
      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${origin}/oauth/mcp/authorize`);
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl.searchParams.get("resource")).toBe(`${origin}/v1/mcp`);
      const stored = JSON.parse(await readFile(join(agentDir, "mcp-auth.json"), "utf8"));
      expect(JSON.stringify(stored)).toContain("dsmcp_");

      await session.prompt("/mcp reconnect docslurp");
      expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["mcp__docslurp__search", "mcp__docslurp__chat"]));

      const answer = vi.fn((context: TranscriptContext) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        expect(result).toMatchObject({ toolName: "mcp__docslurp__search", isError: false });
        expect(JSON.stringify(result)).toContain("contract.pdf");
        return fauxAssistantMessage("The contract renews annually (contract.pdf, page 2).");
      });
      faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__docslurp__search", { q: "renewal term" }, { id: "search-1" }), { stopReason: "toolUse" }), answer]);
      await session.prompt("When does the contract renew?");
      expect(answer).toHaveBeenCalledOnce();
      const grant = (await pool.current!.query<{ api_key_id: string }>("select api_key_id from mcp_oauth_grants")).rows[0]!;
      expect(dispatched).toEqual([{ path: "/tools/search", body: { q: "renewal term" }, keyId: grant.api_key_id }]);

      // The access token expires mid-session: Pi refreshes once and the call still succeeds.
      await pool.current!.query("update mcp_oauth_tokens set expires_at = now() - interval '1 second' where kind = 'access'");
      faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__docslurp__search", { q: "notice period" }, { id: "search-2" }), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
      await session.prompt("And the notice period?");
      expect(dispatched.map((call) => call.body)).toEqual([{ q: "renewal term" }, { q: "notice period" }]);
      const refreshes = (await pool.current!.query<{ consumed: number; revoked: number }>("select count(*) filter (where t.kind = 'refresh' and t.consumed_at is not null)::int as consumed, count(*) filter (where g.revoked_at is not null)::int as revoked from mcp_oauth_tokens t join mcp_oauth_grants g on g.id = t.grant_id")).rows[0]!;
      expect(refreshes).toEqual({ consumed: 1, revoked: 0 });
    } finally {
      session.dispose();
    }
  }, 60_000);
});
