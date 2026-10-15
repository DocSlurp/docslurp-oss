import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  buildAllowlistedEnv,
  defaultParserEnvAllowlist,
  defaultPythonPoolEnvAllowlist,
} from "../tools/process-env.js";
import { buildSpawnCommandSpec } from "../tools/runner.js";

describe("buildAllowlistedEnv", () => {
  it("drops non-allowlisted secrets from parser envs", () => {
    const env = buildAllowlistedEnv({
      defaultAllowlist: defaultParserEnvAllowlist,
      sourceEnv: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "secret-key",
        DATABASE_URL: "postgres://sensitive",
        TMPDIR: "/tmp/docslurp",
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TMPDIR).toBe("/tmp/docslurp");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("allows explicit pool overrides without inheriting the full process env", () => {
    const env = buildAllowlistedEnv({
      defaultAllowlist: defaultPythonPoolEnvAllowlist,
      allowlistEnvVar: "DOCSLURP_PYTHON_POOL_ENV_ALLOWLIST",
      sourceEnv: {
        PATH: "/usr/bin",
        DOCSLURP_EMBED_TEXT_STUB: "1",
        TRANSFORMERS_CACHE: "/tmp/cache",
        CUSTOM_CACHE_DIR: "/tmp/custom",
        DOCSLURP_PYTHON_POOL_ENV_ALLOWLIST: "CUSTOM_CACHE_DIR",
        ANTHROPIC_API_KEY: "secret",
      },
    });

    expect(env.CUSTOM_CACHE_DIR).toBe("/tmp/custom");
    expect(env.DOCSLURP_EMBED_TEXT_STUB).toBe("1");
    expect(env.TRANSFORMERS_CACHE).toBe("/tmp/cache");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("buildSpawnCommandSpec", () => {
  it("passes deny-by-default parser sandbox mode through the launcher env", () => {
    const spec = buildSpawnCommandSpec({
      plan: { binary: "pdftotext", args: ["sample.pdf", "-"], available: true },
      venvBin: "/tmp/fake-venv/bin",
      sandbox: {
        enabled: true,
        launcherPath: "/repo/worker/scripts/parser-sandbox.sh",
        scratchRoot: "/tmp/docslurp-parser-sandbox",
        mode: "isolated",
        writablePaths: [path.join(tmpdir(), "docslurp-test")],
      },
      env: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "secret",
      },
    });

    expect(spec.binary).toBe("/repo/worker/scripts/parser-sandbox.sh");
    expect(spec.env.PATH).toBe("/tmp/fake-venv/bin:/usr/bin");
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_MODE).toBe("isolated");
    expect(spec.env.DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS).toBe(
      path.join(tmpdir(), "docslurp-test"),
    );
    expect(spec.env.OPENAI_API_KEY).toBeUndefined();
  });
});
