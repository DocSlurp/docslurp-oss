import { SandboxConfigError, type SandboxConfigSchema } from "./types.js";

/**
 * Read provider config from the environment according to a schema. Errors name
 * environment variables only, never their values.
 */
export function readSandboxConfig<C = Record<string, unknown>>(schema: SandboxConfigSchema, env: NodeJS.ProcessEnv): C {
  const config: Record<string, unknown> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  const required = new Set(schema.required ?? []);

  for (const [key, property] of Object.entries(schema.properties)) {
    const raw = env[property.env]?.trim();
    if (raw === undefined || raw === "") {
      if (property.default !== undefined) config[key] = property.default;
      else if (required.has(key)) missing.push(property.env);
      continue;
    }
    if (property.type === "string") {
      config[key] = raw;
    } else if (property.type === "number") {
      const value = Number(raw);
      if (Number.isFinite(value)) config[key] = value;
      else invalid.push(`${property.env} (expected number)`);
    } else if (raw.toLowerCase() === "true" || raw.toLowerCase() === "false") {
      config[key] = raw.toLowerCase() === "true";
    } else {
      invalid.push(`${property.env} (expected boolean)`);
    }
  }

  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing required: ${missing.join(", ")}`);
  if (invalid.length > 0) problems.push(`invalid: ${invalid.join(", ")}`);
  if (problems.length > 0) throw new SandboxConfigError(`Invalid sandbox configuration; ${problems.join("; ")}`);
  return config as C;
}

/** Copy of a config that is safe to log: secret properties become "[redacted]". */
export function redactSandboxConfig(schema: SandboxConfigSchema, config: object): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...config };
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property.secret && redacted[key] !== undefined) redacted[key] = "[redacted]";
  }
  return redacted;
}
