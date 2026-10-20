import { describe, expect, it } from "vitest";

import { readSandboxConfig, redactSandboxConfig } from "../config-schema.js";
import { SandboxConfigError, type SandboxConfigSchema } from "../types.js";

const schema: SandboxConfigSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "n", default: "dflt", env: "T_NAME" },
    cpus: { type: "number", description: "c", env: "T_CPUS" },
    flag: { type: "boolean", description: "f", default: false, env: "T_FLAG" },
    tokenId: { type: "string", description: "id", env: "T_TOKEN_ID" },
    tokenSecret: { type: "string", description: "s", secret: true, env: "T_TOKEN_SECRET" },
  },
  required: ["tokenId", "tokenSecret"],
};

describe("readSandboxConfig", () => {
  it("applies defaults and coerces numbers and booleans", () => {
    const config = readSandboxConfig<Record<string, unknown>>(schema, {
      T_CPUS: "8",
      T_FLAG: "true",
      T_TOKEN_ID: "id",
      T_TOKEN_SECRET: "shh",
    });
    expect(config).toMatchObject({ name: "dflt", cpus: 8, flag: true, tokenId: "id", tokenSecret: "shh" });
  });

  it("coerces false", () => {
    const config = readSandboxConfig<Record<string, unknown>>(schema, {
      T_FLAG: "false",
      T_TOKEN_ID: "id",
      T_TOKEN_SECRET: "shh",
    });
    expect(config.flag).toBe(false);
  });

  it("reports every missing required property in one error", () => {
    let message = "";
    try {
      readSandboxConfig(schema, {});
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain("T_TOKEN_ID");
    expect(message).toContain("T_TOKEN_SECRET");
  });

  it("reports wrongly typed values by env name without echoing values", () => {
    const env = { T_CPUS: "lots-of-secret", T_FLAG: "maybe-secret", T_TOKEN_ID: "id", T_TOKEN_SECRET: "topsecret" };
    let message = "";
    try {
      readSandboxConfig(schema, env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("T_CPUS");
    expect(message).toContain("T_FLAG");
    expect(message).not.toContain("lots-of-secret");
    expect(message).not.toContain("maybe-secret");
    expect(message).not.toContain("topsecret");
  });

  it("never includes secret values in errors", () => {
    let message = "";
    try {
      readSandboxConfig(schema, { T_TOKEN_SECRET: "topsecret" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("T_TOKEN_ID");
    expect(message).not.toContain("topsecret");
  });
});

describe("redactSandboxConfig", () => {
  it("redacts secret values only", () => {
    const redacted = redactSandboxConfig(schema, { name: "x", tokenId: "id", tokenSecret: "topsecret" });
    expect(redacted).toEqual({ name: "x", tokenId: "id", tokenSecret: "[redacted]" });
    expect(JSON.stringify(redacted)).not.toContain("topsecret");
  });
});
