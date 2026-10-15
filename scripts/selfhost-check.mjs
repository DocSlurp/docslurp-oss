#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFlag = process.argv.indexOf("--env-file");
const projectFlag = process.argv.indexOf("--project-name");
const envPath = envFlag === -1
  ? join(root, ".env.selfhost")
  : resolve(root, process.argv[envFlag + 1] ?? "");

if (envFlag !== -1 && !process.argv[envFlag + 1]) {
  console.error("--env-file requires a path");
  process.exit(1);
}
if (projectFlag !== -1 && !process.argv[projectFlag + 1]) {
  console.error("--project-name requires a value");
  process.exit(1);
}

if (!existsSync(envPath)) {
  console.error("Missing .env.selfhost. Run: node scripts/selfhost-init.mjs");
  process.exit(1);
}

const entries = new Map();
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) entries.set(match[1], match[2]);
}

const required = [
  "SELFHOST_URL", "POSTGRES_PASSWORD", "DATABASE_URL", "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY", "BETTER_AUTH_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY",
  "CREDENTIALS_ENCRYPTION_KEY", "SECRETS_ENCRYPTION_KEY", "METRICS_SECRET",
];
const missing = required.filter((key) => !entries.get(key) || entries.get(key) === "REPLACE_ME");
if (missing.length) {
  console.error(`Missing self-host values: ${missing.join(", ")}`);
  process.exit(1);
}

let url;
try {
  url = new URL(entries.get("SELFHOST_URL"));
} catch {
  console.error("SELFHOST_URL must be a valid HTTP(S) origin.");
  process.exit(1);
}
if (url.pathname !== "/" || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
  console.error("SELFHOST_URL must be an HTTP(S) origin without a path, query, or fragment.");
  process.exit(1);
}
if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
  console.error("Use HTTPS for a non-local SELFHOST_URL.");
  process.exit(1);
}

const composeArgs = ["compose", "--env-file", envPath, "-f", "compose.selfhost.yml"];
if (projectFlag !== -1) composeArgs.push("--project-name", process.argv[projectFlag + 1]);
const dockerOptions = { cwd: root, stdio: "inherit", env: { ...process.env, SELFHOST_ENV_FILE: envPath } };
const config = spawnSync("docker", [...composeArgs, "config", "--quiet"], dockerOptions);
if (config.status !== 0) process.exit(config.status ?? 1);

console.log("Self-host configuration: OK");
if (process.argv.includes("--running")) {
  const status = spawnSync("docker", [...composeArgs, "ps", "--all"], dockerOptions);
  if (status.status !== 0) process.exit(status.status ?? 1);
  const running = spawnSync("docker", [...composeArgs, "ps", "--status", "running", "--services"], {
    cwd: root,
    env: dockerOptions.env,
    encoding: "utf8",
  });
  if (running.status !== 0) process.exit(running.status ?? 1);
  const services = new Set(running.stdout.trim().split(/\s+/));
  const requiredServices = ["server", "postgres", "redis", "minio", "temporal"];
  const stopped = requiredServices.filter((service) => !services.has(service));
  if (!services.has("worker") && !services.has("worker-full")) stopped.push("worker or worker-full");
  if (stopped.length) {
    console.error(`Required services are not running: ${stopped.join(", ")}`);
    process.exitCode = 1;
  }
  const port = entries.get("SERVER_PORT") || "8787";
  const host = entries.get("SERVER_BIND_ADDRESS") || "127.0.0.1";
  if (!["127.0.0.1", "localhost"].includes(host)) {
    console.log("Server is bound externally; check its health at SELFHOST_URL through your ingress.");
  } else {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      console.log(`Server health: OK (http://127.0.0.1:${port}/health)`);
    } catch (error) {
      console.error(`Server health check failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
