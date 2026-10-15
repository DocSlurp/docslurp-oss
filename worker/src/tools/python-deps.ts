// Lazy Python dependency provisioning.
//
// Worker images install their Python stack up front, but lean images, local
// checkouts and test runs often lack an optional extractor package. Instead of
// failing the extraction, a command that dies with "No module named X" (or the
// scripts' own "missing dependency: pip install X") installs X into the worker
// venv and is retried once. Only distributions declared in
// worker/requirements*.txt can be installed, pinned to worker/requirements.lock.txt.
// Binaries that ship as wheels (pandoc) are provisioned the same way.
//
// Disable with DOCSLURP_PYTHON_LAZY_INSTALL=false (e.g. air-gapped hosts).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Import names that differ from their PyPI distribution names. */
const IMPORT_TO_DISTRIBUTION: Record<string, string> = {
  docx: "python-docx",
  pptx: "python-pptx",
  PIL: "pillow",
  bs4: "beautifulsoup4",
  yaml: "pyyaml",
  cv2: "opencv-python-headless",
  sklearn: "scikit-learn",
  sentence_transformers: "sentence-transformers",
  huggingface_hub: "huggingface-hub",
  ebooklib: "ebooklib",
};

/** Binaries provided by a wheel: [distribution, path of the binary inside site-packages]. */
const BINARY_PROVIDERS: Record<string, { distribution: string; relativePath: string[] }> = {
  pandoc: { distribution: "pypandoc-binary", relativePath: ["pypandoc", "files", "pandoc"] },
};

export function lazyPythonInstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DOCSLURP_PYTHON_LAZY_INSTALL ?? "true").trim().toLowerCase() !== "false";
}

export function normalizeDistribution(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/** Find the missing distribution in a failed command's output, if any. */
export function parseMissingPythonDependency(output: string): string | null {
  const pip = /missing dependency: pip install ([A-Za-z0-9_.-]+)/.exec(output);
  if (pip) return normalizeDistribution(pip[1]!);
  const module = /No module named '([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_.]+)?'/.exec(output);
  if (module) {
    const root = module[1]!;
    return normalizeDistribution(IMPORT_TO_DISTRIBUTION[root] ?? root);
  }
  return null;
}

/** The missing top-level import name (or "pip install X" hint) in a failed command's output. */
export function parseMissingPythonModule(output: string): string | null {
  const module = /No module named '([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_.]+)?'/.exec(output);
  if (module) return module[1]!;
  const pip = /missing dependency: pip install ([A-Za-z0-9_.-]+)/.exec(output);
  return pip ? pip[1]! : null;
}

function workerRoot(): string {
  // src/tools or dist/tools -> worker/
  return path.resolve(here, "..", "..");
}

let declared: Set<string> | null = null;
let pins: Map<string, string> | null = null;

function readRequirementNames(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    // Direct-URL requirements ("name @ https://...") are never index-installable:
    // allowing their bare name would let a lazy install fetch a squatted PyPI package.
    .filter((line) => line && !line.startsWith("-") && !/\s@\s/.test(line))
    .map((line) => normalizeDistribution(line.split(/[<>=!~;\[\s]/)[0]!));
}

/** Distributions the worker declares in its requirement files (the install allowlist). */
export function declaredPythonDistributions(root = workerRoot()): Set<string> {
  if (declared && root === workerRoot()) return declared;
  const files = readdirSync(root).filter((file) => /^requirements.*\.txt$/.test(file) && !file.includes(".lock."));
  const names = new Set(files.flatMap((file) => readRequirementNames(path.join(root, file))));
  for (const provider of Object.values(BINARY_PROVIDERS)) names.add(normalizeDistribution(provider.distribution));
  if (root === workerRoot()) declared = names;
  return names;
}

/** Exact versions from the lock file, used to pin lazy installs. */
export function lockedPythonPins(root = workerRoot()): Map<string, string> {
  if (pins && root === workerRoot()) return pins;
  const result = new Map<string, string>();
  const lock = path.join(root, "requirements.lock.txt");
  if (existsSync(lock)) {
    for (const line of readFileSync(lock, "utf8").split("\n")) {
      const match = /^([A-Za-z0-9_.-]+)==([^\s;]+)/.exec(line.trim());
      if (match) result.set(normalizeDistribution(match[1]!), match[2]!);
    }
  }
  // pypandoc-binary ships the same version as the locked pypandoc wrapper.
  const pypandoc = result.get("pypandoc");
  if (pypandoc && !result.has("pypandoc-binary")) result.set("pypandoc-binary", pypandoc);
  if (root === workerRoot()) pins = result;
  return result;
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, output: String(error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/** Upper bound on waiting for another process's install (the install itself is bounded separately). */
const INSTALL_LOCK_WAIT_MS = 15 * 60_000;

async function withInstallLock<T>(venvDir: string, task: () => Promise<T>, waitMs = INSTALL_LOCK_WAIT_MS): Promise<T> {
  // mkdir is atomic: one worker process installs, others wait for it.
  const lockDir = `${venvDir}.install-lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      // Only EEXIST means another process holds the lock. Anything else
      // (EACCES on a read-only image directory, EROFS, ENOENT) can never
      // succeed by waiting, so fail now instead of polling until the deadline.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockDir).catch(() => null);
      if (info && Date.now() - info.mtimeMs > INSTALL_LOCK_WAIT_MS) await rm(lockDir, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await task();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/** Resolve `fallback` as soon as `signal` aborts; the underlying work keeps running. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(fallback);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function ensureVenv(venvBin: string): Promise<string> {
  const python = path.join(venvBin, "python3");
  if (existsSync(python)) return python;
  const venvDir = path.dirname(venvBin);
  // System site-packages stay visible so system-installed modules keep working.
  const created = await run("python3", ["-m", "venv", "--system-site-packages", venvDir], 120_000);
  if (created.code !== 0 || !existsSync(python)) {
    throw new Error(`could not create Python venv at ${venvDir}: ${created.output.trim()}`);
  }
  console.log(`[python-deps] created venv=${venvDir}`);
  return python;
}

const attempted = new Map<string, Promise<boolean>>();

/**
 * Install declared distributions into the venv. Resolves true when they are
 * installed (now or already), false when lazy install is disabled, a
 * distribution is not declared, the venv location is not writable, or
 * `signal` aborts first. Each distribution is attempted once per process; an
 * aborted caller stops waiting but the shared attempt continues for later callers.
 */
export async function ensurePythonDistributions(
  distributions: string[],
  options: { venvBin: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<boolean> {
  if (!lazyPythonInstallEnabled(options.env)) return false;
  const wanted = [...new Set(distributions.map(normalizeDistribution))];
  const allowed = declaredPythonDistributions();
  const undeclared = wanted.filter((name) => !allowed.has(name));
  if (undeclared.length > 0) {
    console.warn(`[python-deps] refusing undeclared distribution(s)=${undeclared.join(",")}`);
    return false;
  }
  const key = `${options.venvBin}|${wanted.sort().join(",")}`;
  let pending = attempted.get(key);
  if (!pending) {
    // Never let provisioning failures mask the command's original error.
    pending = installDistributions(wanted, options.venvBin).catch((error: unknown) => {
      console.warn(`[python-deps] cannot install ${wanted.join(",")}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    attempted.set(key, pending);
  }
  return await untilAborted(pending, options.signal, false);
}

async function installDistributions(distributions: string[], venvBin: string): Promise<boolean> {
  const venvDir = path.dirname(venvBin);
  await mkdir(path.dirname(venvDir), { recursive: true });
  return await withInstallLock(venvDir, async () => {
    const python = await ensureVenv(venvBin);
    const locked = lockedPythonPins();
    const specs = distributions.map((name) => (locked.has(name) ? `${name}==${locked.get(name)}` : name));
    const started = Date.now();
    const pip = ["-m", "pip", "install", "--disable-pip-version-check", "--quiet"];
    // CPU wheel pins use the same index as the image/startup installer.
    if (locked.get("torch")?.includes("+cpu")) {
      pip.push("--extra-index-url", "https://download.pytorch.org/whl/cpu");
    }
    // Keep the supported base versions on both attempts. Portability fallback
    // may relax exact transitive pins, but must never relax security floors.
    const baseFile = path.join(workerRoot(), "requirements-base.txt");
    pip.push("-c", baseFile);
    // The full lock targets the image's Python; other interpreters may lack
    // compatible wheels for an optional transitive pin.
    const lockFile = path.join(workerRoot(), "requirements.lock.txt");
    let result = existsSync(lockFile)
      ? await run(python, [...pip, "-c", lockFile, ...specs], 15 * 60_000)
      : { code: 1, output: "no lock file" };
    if (result.code !== 0) {
      console.warn(`[python-deps] locked install failed, retrying without lock constraints specs=${specs.join(",")}`);
      result = await run(python, [...pip, ...specs], 15 * 60_000);
    }
    if (result.code !== 0) {
      console.warn(`[python-deps] install failed specs=${specs.join(",")} output=${result.output.trim().slice(-2000)}`);
      return false;
    }
    console.log(`[python-deps] installed specs=${specs.join(",")} seconds=${((Date.now() - started) / 1000).toFixed(1)} venv=${venvDir}`);
    return true;
  });
}

/** Resolve a binary from the venv, provisioning it from a wheel when one provides it. */
export async function ensureBinary(binary: string, options: { venvBin: string; env?: NodeJS.ProcessEnv }): Promise<boolean> {
  const target = path.join(options.venvBin, binary);
  if (existsSync(target)) return true;
  const provider = BINARY_PROVIDERS[binary];
  if (!provider) return false;
  if (!(await ensurePythonDistributions([provider.distribution], options))) return false;
  const python = path.join(options.venvBin, "python3");
  const located = await run(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], 30_000);
  const source = path.join(located.output.trim(), ...provider.relativePath);
  if (located.code !== 0 || !existsSync(source)) {
    console.warn(`[python-deps] ${provider.distribution} installed but ${binary} not found at ${source}`);
    return false;
  }
  await symlink(source, target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  console.log(`[python-deps] linked binary=${binary} from=${provider.distribution}`);
  return true;
}
