import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandPlan } from "../tools/runner.js";

/**
 * Work out which host paths a parser command may read and write. Provider-neutral:
 * the result is declared on the sandbox command and each provider enforces it.
 * `scratchRoot` is provider scratch space and is not itself exposed to the command.
 */
export function resolveCommandPaths(args: {
  plan: CommandPlan;
  venvBin: string;
  scratchRoot: string;
  configuredWritablePaths: string[];
  scriptsDir: string;
}): { readablePaths: string[]; inputPaths: string[]; writablePaths: string[] } {
  const runtimeProjectDir = path.dirname(path.dirname(args.scriptsDir));
  return {
    readablePaths: resolveSandboxReadablePaths(args),
    inputPaths: resolveSandboxInputPaths({ commandArgs: args.plan.args, runtimeProjectDir }),
    writablePaths: resolveSandboxWritablePaths({
      configuredPaths: args.configuredWritablePaths,
      commandArgs: args.plan.args,
      runtimeProjectDir,
    }),
  };
}

/**
 * The command's file inputs: absolute file arguments inside a DocSlurp temp workspace.
 * Remote providers upload exactly these; the parser runtime (scripts, node_modules,
 * venv, interpreters) comes from the provider's image, never from the host.
 */
export function resolveSandboxInputPaths(args: { commandArgs: string[]; runtimeProjectDir: string }): string[] {
  const inputs = new Set<string>();
  for (const arg of args.commandArgs) {
    if (!path.isAbsolute(arg)) continue;
    const resolved = path.resolve(arg);
    if (resolved === args.runtimeProjectDir || resolved.startsWith(`${args.runtimeProjectDir}${path.sep}`)) continue;
    if (!inferDocslurpTempAncestor(path.dirname(resolved))) continue;
    try {
      if (statSync(resolved).isFile()) inputs.add(resolved);
    } catch {
      /* not created yet: an output path, not an input */
    }
  }
  return [...inputs];
}

export function resolveSandboxWritablePaths(args: {
  configuredPaths: string[];
  commandArgs: string[];
  runtimeProjectDir: string;
}): string[] {
  const writable = new Set<string>();
  for (const configured of args.configuredPaths) {
    const resolved = path.resolve(configured);
    if (inferDocslurpTempAncestor(resolved) !== resolved || args.runtimeProjectDir === resolved || args.runtimeProjectDir.startsWith(`${resolved}${path.sep}`)) {
      throw new Error("Parser writable paths must be private DocSlurp temporary workspaces");
    }
    writable.add(resolved);
  }
  for (const arg of args.commandArgs) {
    const resolvedArg = path.resolve(arg);
    if (resolvedArg === args.runtimeProjectDir || resolvedArg.startsWith(`${args.runtimeProjectDir}${path.sep}`)) continue;
    const tempWorkspace = inferDocslurpTempWorkspace(arg);
    if (tempWorkspace) {
      writable.add(tempWorkspace);
    }
  }
  return Array.from(writable);
}

export function inferDocslurpTempWorkspace(arg: string): string | null {
  if (!path.isAbsolute(arg)) {
    return null;
  }

  return inferDocslurpTempAncestor(path.dirname(arg));
}

export function inferDocslurpTempAncestor(candidate: string): string | null {
  const tempRoot = path.resolve(tmpdir());
  let current = path.resolve(candidate);
  while (current !== tempRoot && current.startsWith(`${tempRoot}${path.sep}`)) {
    if (path.basename(current).startsWith("docslurp-")) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

export function resolveSandboxReadablePaths(args: {
  plan: CommandPlan;
  venvBin: string;
  scriptsDir: string;
}): string[] {
  const scriptsDir = args.scriptsDir;
  const workerDir = path.dirname(scriptsDir);
  const projectDir = path.dirname(workerDir);
  const candidates = [scriptsDir, path.join(workerDir, "node_modules"),
    path.join(projectDir, "node_modules"), path.join(projectDir, "packages", "shared"),
    path.dirname(args.venvBin), process.execPath,
    ...(path.isAbsolute(args.plan.binary) ? [args.plan.binary] : []),
    ...args.plan.args.filter((arg) => path.isAbsolute(arg) && existsSync(arg) && statSync(arg).isFile()),
    ...(args.plan.bundleRoots ?? [])];
  const python = path.join(args.venvBin, "python3");
  if (existsSync(python)) {
    let interpreter = python;
    while (lstatSync(interpreter).isSymbolicLink()) {
      interpreter = path.resolve(path.dirname(interpreter), readlinkSync(interpreter));
    }
    candidates.push(path.dirname(path.dirname(interpreter)), path.dirname(path.dirname(realpathSync(python))));
  }
  // Isolated worktrees can link packages through a different checkout's
  // node_modules. Include code-only link targets, never that checkout itself.
  for (const modules of [path.join(workerDir, "node_modules"), path.join(projectDir, "node_modules")]) {
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      if (name.startsWith(".")) continue;
      const entry = path.join(modules, name);
      if (lstatSync(entry).isSymbolicLink()) candidates.push(path.resolve(path.dirname(entry), readlinkSync(entry)));
      const packages = name.startsWith("@") && statSync(entry).isDirectory()
        ? readdirSync(entry).map((pkg) => path.join(entry, pkg)) : [entry];
      for (const pkg of packages) {
        if (lstatSync(pkg).isSymbolicLink()) candidates.push(path.resolve(path.dirname(pkg), readlinkSync(pkg)));
      }
    }
  }
  if (["clamdscan", "clamscan"].includes(path.basename(args.plan.binary))) {
    if (path.basename(args.plan.binary) === "clamscan") {
      candidates.push(process.env.DOCSLURP_CLAMAV_DB_DIR?.trim() || "/var/lib/clamav");
    } else {
      const configArg = args.plan.args.find((arg) => arg.startsWith("--config-file="));
      const configFile = configArg?.slice("--config-file=".length) || "/etc/clamav/clamd.conf";
      candidates.push(configFile);
      if (existsSync(configFile)) {
        const socketPath = readFileSync(configFile, "utf8").match(/^\s*LocalSocket\s+(.+?)\s*$/m)?.[1];
        if (socketPath && path.isAbsolute(socketPath)) candidates.push(socketPath);
      }
    }
  }
  const readable = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    readable.add(path.resolve(candidate));
    readable.add(realpathSync(candidate));
  }
  return withoutCoveredPaths([...readable]);
}

/**
 * Drop paths already visible through a bound ancestor directory. Besides
 * avoiding redundant mounts, this matters for symlinks: a venv's
 * bin/python3 is a symlink, and bwrap refuses to bind onto a symlink that the
 * parent bind already created ("Can't mount on symlink destination"), which
 * failed every sandboxed venv Python command. Realpaths are kept separately.
 */
export function withoutCoveredPaths(paths: string[]): string[] {
  const directories = new Set(paths.filter((candidate) => {
    try { return statSync(candidate).isDirectory() && !lstatSync(candidate).isSymbolicLink(); } catch { return false; }
  }));
  return paths.filter((candidate) => {
    for (let parent = path.dirname(candidate); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      if (directories.has(parent)) return false;
    }
    return true;
  });
}
