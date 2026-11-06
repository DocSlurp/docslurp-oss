import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The chat executor charges chat answers, so it loads the deployment's pricing provider before it claims any operation
 * (council E #2). Under its deployed env (fly.chat-executor.toml: DOCSLURP_PRICING_REQUIRED=1 and the plugin path) it
 * either loads the provider or refuses to start; it never falls back to the open default or prices at 0. Runs the real
 * entrypoint; development NODE_ENV so the production secret checks do not stop it first, and an unreachable database.
 */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const executor = path.join(serverDir, "scripts/chat-operation-executor.ts");

function runExecutor(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", executor], {
    cwd: serverDir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(), NODE_ENV: "development",
      DOCSLURP_DURABLE_CHAT: "1", DOCSLURP_PRICING_REQUIRED: "1", DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", ...env },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("chat executor pricing startup (council E #2)", () => {
  // The executor runs against the built packages, as in the app image: build @docslurp/shared once when it is not built
  // (the vitest suites read its sources and never need the build).
  beforeAll(() => {
    if (existsSync(path.resolve(serverDir, "../packages/shared/dist/pricing-loader.js"))) return;
    const built = spawnSync("pnpm", ["--filter", "@docslurp/shared", "build"], { cwd: path.resolve(serverDir, ".."), encoding: "utf8", timeout: 240_000 });
    if (built.status !== 0) throw new Error(`@docslurp/shared build failed: ${built.stderr.slice(-2000)}`);
  }, 300_000);

  it("refuses to start with DOCSLURP_PRICING_REQUIRED=1 and no provider", () => {
    const run = runExecutor({});
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/startup_refused pricing: .*needs a pricing provider/);
  }, 120_000);

  it("refuses to start when the named plugin cannot load", () => {
    const run = runExecutor({ DOCSLURP_PRICING_PLUGIN: "/nonexistent/pricing-plugin.mjs" });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/startup_refused pricing: Pricing plugin failed to load/);
  }, 120_000);

  it("loads a provider (with its read-only durable state) before running the chat worker", () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "executor-pricing-"));
    try {
      const plugin = path.join(dir, "pricing-plugin.mjs");
      writeFileSync(plugin, `export function register(host) {
  // Read-only (council J): the host's durable state reads; only the operator's tool raises.
  console.log("[fixture] durableState=" + (typeof host.durableState?.read === "function" && host.durableState?.raise === undefined));
  return { ...host.shared.OPEN_PRICING, id: "fixture", version: "fixture-1" };
}\n`);
      const run = runExecutor({ DOCSLURP_PRICING_PLUGIN: plugin });
      expect(run.output).toContain("[fixture] durableState=true");
      expect(run.output).toMatch(/\[pricing\] provider=fixture version=fixture-1/);
      expect(run.output).not.toMatch(/startup_refused/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("every entrypoint that loads the provider hands it the durable state", () => {
    const core = path.resolve(serverDir, "..");
    for (const file of ["server/src/server.ts", "worker/src/temporal/worker.ts", "server/scripts/chat-operation-executor.ts"]) {
      const source = readFileSync(path.join(core, file), "utf8");
      const calls = [...source.matchAll(/loadPricingProvider\(([^;]*)\)/g)].map((match) => match[1]!);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call, file).toMatch(/durableState: pricingDurableStateFromSql\(/);
    }
  });
});
