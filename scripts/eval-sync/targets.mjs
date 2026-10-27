// Named Langfuse targets from a non-secret JSON config. Credentials come only from each target's env file,
// are held in memory and never printed. A target may declare an SSH tunnel that this module opens and closes.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { createClient, loadEnv } from "./langfuse.mjs";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export async function loadTargets(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const base = dirname(resolve(configPath));
  const targets = {};
  for (const [name, target] of Object.entries(config.targets ?? {})) {
    if (!NAME.test(name)) throw new Error(`Invalid target name ${JSON.stringify(name)}`);
    for (const key of Object.keys(target)) if (/secret|password|token|key$/i.test(key) && key !== "envFile") throw new Error(`Target ${name}: credentials belong in envFile, not the target config (${key})`);
    if (!target.envFile) throw new Error(`Target ${name}: envFile is required`);
    targets[name] = { ...target, name, envFile: isAbsolute(target.envFile) ? target.envFile : resolve(base, target.envFile) };
  }
  if (!Object.keys(targets).length) throw new Error(`${configPath}: no targets configured`);
  return { targets, defaults: config.defaults ?? {}, base };
}

export function selectTargets(all, list) {
  const names = (list ?? Object.keys(all).join(",")).split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) if (!all[name]) throw new Error(`Unknown target ${name}; configured: ${Object.keys(all).join(", ")}`);
  if (new Set(names).size !== names.length) throw new Error("A target is listed twice");
  return names.map((name) => all[name]);
}

export function parseAllowHeldout(value, configured) {
  if (value === undefined) return new Set();
  const names = String(value).split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new Error("--allow-heldout must name at least one target");
  for (const name of names) if (!configured[name]) throw new Error(`--allow-heldout names unknown target ${name}`);
  return new Set(names);
}

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
});

/**
 * Open `ssh -N -L 127.0.0.1:<port>:<remoteHost>:<remotePort> <host>` and wait for Langfuse health.
 * Returns `{ baseUrl, pid, close }`. close() signals exactly this child process, never a pattern.
 */
export async function openTunnel(tunnel, { spawnImpl = spawn, fetchImpl = fetch, waitMs = 20_000 } = {}) {
  if (!tunnel?.sshHost || !tunnel.remotePort) throw new Error("Tunnel requires sshHost and remotePort");
  const port = tunnel.localPort ?? await freePort();
  const args = ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", ...(tunnel.sshOptions ?? []), "-N", "-L", `127.0.0.1:${port}:${tunnel.remoteHost ?? "127.0.0.1"}:${tunnel.remotePort}`, tunnel.sshHost];
  const child = spawnImpl("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  let exited = null;
  const exit = new Promise((resolveExit) => child.once("exit", (code, signal) => { exited = { code, signal }; resolveExit(exited); }));
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const close = async () => {
    if (exited) return exited;
    child.kill("SIGTERM");
    const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
    const result = await exit; clearTimeout(timer); return result;
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`SSH tunnel exited (${exited.code ?? exited.signal}): ${stderr.trim().split("\n").at(-1) ?? ""}`);
    try {
      const response = await fetchImpl(`${baseUrl}/api/public/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) { const health = await response.json().catch(() => ({})); return { baseUrl, pid: child.pid, version: health.version ?? null, close }; }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  await close();
  throw new Error("SSH tunnel did not become healthy in time");
}

/** Connect to a target: resolve its base URL (tunnel, explicit baseUrl, or env file) and load credentials. */
export async function connectTarget(target, { baseUrlOverride, tunnelImpl = openTunnel, fetchImpl = fetch } = {}) {
  const env = await loadEnv(target.envFile);
  for (const key of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) if (!env[key]) throw new Error(`${target.name}: ${key} missing from its env file`);
  let tunnel = null, baseUrl = baseUrlOverride ?? target.baseUrl ?? null, via = baseUrlOverride ? "override" : target.baseUrl ? "configured-base-url" : "env-base-url";
  if (!baseUrlOverride && target.tunnel) {
    try { tunnel = await tunnelImpl(target.tunnel, { fetchImpl }); baseUrl = tunnel.baseUrl; via = "ssh-tunnel"; }
    catch (error) {
      if (!target.tunnel.fallbackToEnvBaseUrl) throw error;
      via = `env-base-url (tunnel failed: ${error.message})`; baseUrl = null;
    }
  }
  baseUrl ??= env.LANGFUSE_BASE_URL;
  if (!baseUrl) throw new Error(`${target.name}: no base URL`);
  const api = createClient({ baseUrl, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, fetchImpl });
  const close = async () => { if (tunnel) await tunnel.close(); };
  return { api, baseUrl, via, tunnelPid: tunnel?.pid ?? null, close };
}
