import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Third-party fixtures are not tracked in git; `pnpm fixtures:fetch` downloads them into
 * <repo>/.cache/fixtures/pdf (or $DOCSLURP_CACHE_DIR/fixtures/pdf), see
 * worker/testdata/third-party-fixtures.manifest.json.
 */
export function thirdPartyFixtureDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.DOCSLURP_CACHE_DIR ? path.resolve(env.DOCSLURP_CACHE_DIR) : path.join(repoRoot, ".cache");
  return path.join(cache, "fixtures", "pdf");
}

/** Tracked (synthetic) fixture next to the manifest first, then the fetched third-party cache. */
export function resolveFixturePath(
  manifestDir: string,
  relativePath: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const base of [manifestDir, thirdPartyFixtureDir(repoRoot, env)]) {
    const candidate = path.resolve(base, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
