/**
 * Times the workspace read paths the dashboard hits (bootstrap's listWorkspaces,
 * GET /v1/workspaces/:id's getWorkspace) against DATABASE_URL.
 * Usage: DATABASE_URL=... tsx server/scripts/perf-workspace-reads.ts <label> [iterations]
 */
import { sql } from "../src/db.js";
import { getWorkspace, listWorkspaces } from "../src/services/workspaces.js";

const label = process.argv[2] ?? "run";
const iterations = Number(process.argv[3] ?? 15);
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!;

async function time(name: string, run: () => Promise<unknown>) {
  await run(); // warm
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const result = await run();
    samples.push(performance.now() - started);
    rows = Array.isArray(result) ? result.length : result ? 1 : 0;
  }
  console.log(JSON.stringify({ label, name, iterations, rows, p50_ms: +quantile(samples, 0.5).toFixed(1), p95_ms: +quantile(samples, 0.95).toFixed(1), samples: samples.map(s => +s.toFixed(1)) }));
}

await time("listWorkspaces(bootstrap)", () => listWorkspaces("u", { refineNames: false }));
await time("getWorkspace", () => getWorkspace("ws-7", "u"));
await sql.end({ timeout: 1 });
