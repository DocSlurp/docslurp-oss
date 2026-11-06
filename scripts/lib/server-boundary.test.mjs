import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkAppServerImports, checkEstimatorBoundary, checkServerBoundary } from "./server-boundary.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "boundary-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("accepts server-internal and package-export imports", () => {
  const root = fixture({ "server/src/a.ts": 'import "./b.js";\nimport "@docslurp/sdk/search-adapters";', "server/src/b.ts": "" });
  try { assert.deepEqual(checkServerBoundary(root), []); } finally { rmSync(root, { recursive: true }); }
});

test("rejects app imports and package src deep imports", () => {
  const root = fixture({
    "server/src/a.ts": 'import x from "../../app/src/lib/x.js";',
    "server/src/b.ts": 'import y from "../../packages/sdk/src/index.js";\nimport z from "@docslurp/shared/src/index";',
    "server/src/c.ts": 'vi.mock("@docslurp/app/lib");',
  });
  try { assert.equal(checkServerBoundary(root).length, 4); } finally { rmSync(root, { recursive: true }); }
});

test("allows only @docslurp/worker/testing, and only from tests", () => {
  const root = fixture({
    "server/src/a.test.ts": 'import "@docslurp/worker/testing";\nawait import("@docslurp/worker/testing");',
    "server/src/__tests__/helper.ts": 'import "@docslurp/worker/testing";',
    "server/src/b.test.ts": 'import "@docslurp/worker";\nimport "@docslurp/worker/dist/x.js";',
    "server/src/c.ts": 'import "@docslurp/worker/testing";',
    "server/src/d.test.ts": 'import "../../worker/src/test/migrated-postgres.js";',
  });
  try {
    const violations = checkServerBoundary(root);
    assert.equal(violations.length, 4);
    assert.ok(violations.some((v) => v.startsWith("server/src/c.ts") && v.includes("runtime")));
    assert.ok(violations.some((v) => v.startsWith("server/src/d.test.ts")));
  } finally { rmSync(root, { recursive: true }); }
});

test("server/db/ is covered by the server boundary", () => {
  const root = fixture({ "server/db/seed.ts": 'import "../src/lib/seed-users.ts";', "server/db/tests/run.mjs": 'import("@docslurp/worker/testing");', "server/db/tests/a.mjs": 'import x from "../../../app/src/x.js";', "server/db/tests/b.mjs": "const r = createRequire(new URL('../../../app/package.json', import.meta.url)); import '@docslurp/app/x';", "server/db/migrate.mjs": 'import "@docslurp/worker";' });
  try { assert.equal(checkServerBoundary(root).length, 4); } finally { rmSync(root, { recursive: true }); }
});

test("app code may import only the server mount and the auth entry", () => {
  const root = fixture({
    "app/src/lib/api-proxy.ts": "import { apiApp } from '@docslurp/server/server';",
    "app/src/lib/auth.ts": "import { auth } from '@docslurp/server/lib/better-auth';",
    "app/src/middleware.ts": "const m = await import('@docslurp/server/server');",
    "app/src/lib/a.test.ts": "import '@docslurp/server/services/ingest-report';",
    "app/src/lib/b.ts": "import { x } from '@docslurp/server/services/workspaces';",
    "app/src/pages/c.astro": "---\nimport { y } from \"@docslurp/server/lib/mcp-origin\";\n---",
  });
  try {
    const violations = checkAppServerImports(root);
    assert.equal(violations.length, 3);
    assert.match(violations.join("\n"), /lib\/b\.ts[\s\S]*c\.astro|c\.astro[\s\S]*lib\/b\.ts/);
  } finally { rmSync(root, { recursive: true }); }
});

test("keeps the offline estimator's file probes out of the API, worker, shared contracts and SDK", () => {
  const root = fixture({
    "server/src/a.ts": 'import { createEstimator } from "@docslurp/estimate";',
    "worker/src/b.ts": 'const probe = await import("@docslurp/estimate/node");',
    "packages/shared/src/c.ts": 'import rules from "../../estimate/profiler-rules.json";',
    "packages/shared/src/d.ts": 'import { quoteUpload } from "./upload-quote.js";',
    "packages/sdk/src/e.ts": 'export { createEstimator } from "@docslurp/estimate";',
    "packages/cli/src/f.ts": 'import { createEstimator } from "@docslurp/estimate";',
  });
  try { assert.equal(checkEstimatorBoundary(root).length, 4); } finally { rmSync(root, { recursive: true }); }
});

test("a test may read the neutral profiler rules file to check it against its generator; nothing else in the estimator", () => {
  const root = fixture({
    "packages/shared/src/rules.test.ts": 'const RULES = new URL("../../estimate/profiler-rules.json", import.meta.url);',
    "packages/shared/src/rules.ts": 'import rules from "../../estimate/profiler-rules.json";',
    "packages/shared/src/other.test.ts": 'const probe = new URL("../../estimate/src/probe/pdf.rs", import.meta.url);',
  });
  try {
    const violations = checkEstimatorBoundary(root);
    assert.equal(violations.length, 2);
    assert.ok(!violations.some((v) => v.startsWith("packages/shared/src/rules.test.ts")));
  } finally { rmSync(root, { recursive: true }); }
});
