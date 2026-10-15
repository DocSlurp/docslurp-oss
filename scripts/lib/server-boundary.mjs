// Static import-boundary rules for server/ (@docslurp/server), which must be
// extractable into its own public package without the private dashboard:
//   1. server/ never imports from app/ (relative path or @docslurp/app).
//   2. server/ never reaches into another package's src/ by relative path or
//      by a "@docslurp/<pkg>/src/..." deep specifier; use the package exports.
//   (server/db/ — migrations, schema, seed, db tests — is part of server/ and covered by these rules.)
//   3. server/ never imports @docslurp/worker from non-test code (the worker is
//      only a devDependency); test files (*.test.*, __tests__/) may import
//      exactly "@docslurp/worker/testing" and nothing else from the worker.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:do)?mock\(\s*|\brequire\(\s*|new URL\(\s*)(['"])([^'"]+)\1/g;
const SKIP_DIRS = new Set(["node_modules", "dist", ".astro", ".scratch"]);

const TEST_FILE = /(?:\.test\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|^server\/db\/tests\/)/;
const WORKER_TESTING = "@docslurp/worker/testing";

// A missing directory (e.g. app/ in the open-source export) has nothing to check.
function* sourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) yield path;
  }
}

export function checkServerBoundary(root, serverDir = "server") {
  const violations = [];
  const base = resolve(root, serverDir);
  for (const file of sourceFiles(base)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[2];
      const where = `${relative(root, file)}: ${specifier}`;
      if (specifier === "@docslurp/app" || specifier.startsWith("@docslurp/app/")) {
        violations.push(`${where} (server must not depend on the app)`);
        continue;
      }
      if (specifier === "@docslurp/worker" || specifier.startsWith("@docslurp/worker/")) {
        const isTest = TEST_FILE.test(relative(root, file).split(sep).join("/"));
        if (!isTest) violations.push(`${where} (server runtime code must not depend on the worker)`);
        else if (specifier !== WORKER_TESTING) violations.push(`${where} (server tests may import only ${WORKER_TESTING})`);
        continue;
      }
      const deep = specifier.match(/^@docslurp\/[^/]+\/src(?:\/|$)/);
      if (deep) {
        violations.push(`${where} (deep import into a package's src/; use its exports)`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (target === base || target.startsWith(base + sep)) continue;
      const fromRoot = relative(root, target).split(sep).join("/");
      if (/^app(\/|$)/.test(fromRoot)) {
        violations.push(`${where} (server must not import from app/)`);
      } else if (/^(packages\/[^/]+|worker)\/src(\/|$)/.test(fromRoot) || /^(worker)\//.test(fromRoot)) {
        violations.push(`${where} (deep import into another package's source; use its package exports)`);
      }
    }
  }
  return violations;
}

/**
 * Frontend rule: app/ talks to the server over HTTP (app/src/lib/server-client.ts)
 * and never imports its services or auth internals. Non-test app code may import
 * only `@docslurp/server/server`, the in-process mount (lib/api-proxy.ts and the
 * startup import in middleware.ts). That import disappears in hosting mode b.
 * Tests are exempt, but the package exports only `./server`.
 */
export const APP_ALLOWED_SERVER_IMPORTS = new Set([
  "@docslurp/server/server",
]);

const isTestFile = (path) => /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(path) || /[\\/](test|__tests__)[\\/]/.test(path);

export function checkAppServerImports(root, appDir = "app") {
  const violations = [];
  for (const file of sourceFiles(resolve(root, appDir))) {
    if (isTestFile(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[2];
      if ((specifier === "@docslurp/server" || specifier.startsWith("@docslurp/server/")) && !APP_ALLOWED_SERVER_IMPORTS.has(specifier)) {
        violations.push(`${relative(root, file)}: ${specifier} (app reads the server over HTTP via lib/server-client.ts)`);
      }
    }
  }
  // .astro pages are not in sourceFiles' extension list.
  return violations.concat(checkAstroServerImports(root, appDir));
}

function* astroFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* astroFiles(path);
    else if (entry.name.endsWith(".astro")) yield path;
  }
}

function checkAstroServerImports(root, appDir) {
  const violations = [];
  for (const file of astroFiles(resolve(root, appDir))) {
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[2];
      if ((specifier === "@docslurp/server" || specifier.startsWith("@docslurp/server/")) && !APP_ALLOWED_SERVER_IMPORTS.has(specifier)) {
        violations.push(`${relative(root, file)}: ${specifier} (app reads the server over HTTP via lib/server-client.ts)`);
      }
    }
  }
  return violations;
}
