import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BindingNativePdfEngine, isNativePdfBindingModule } from "./binding-engine.js";
import type { NativePdfEngine } from "./types.js";

/**
 * Pin for the private engine tarball (vendor-artifacts/native-pdf/manifest.json).
 * The tarball itself is gitignored; scripts/install-native-pdf.mjs verifies the
 * sha256 and installs it into vendor-artifacts/native-pdf/node_modules.
 */
export interface NativePdfManifest {
  package: string;
  version: string;
  tarball: string;
  sha256: string;
}

/**
 * Neutral DocSlurp settings and the engine variables they feed. The engine reads them from the process
 * environment (fonts and OCR concurrency once per process), so they are applied before the module loads.
 * An engine variable that is already set wins.
 */
export const NATIVE_PDF_ENGINE_ENV: Readonly<Record<string, string>> = {
  /** Directory with the OCR detector/recognizer models and dictionary; without it OCR reports unsupported. */
  NATIVE_PDF_OCR_MODEL_DIR: "PDFUST_OCR_MODEL_DIR",
  /** Concurrent OCR recognitions per process (default 1; see applyNativePdfEngineEnv). */
  NATIVE_PDF_OCR_MAX_CONCURRENT: "PDFUST_OCR_MAX_CONCURRENT",
  /** CJK fallback fonts for rendering pages whose CJK fonts are not embedded. */
  NATIVE_PDF_FONTS_DIR: "PDFUST_FONTS_DIR",
};

export function applyNativePdfEngineEnv(source: NodeJS.ProcessEnv = process.env, target: NodeJS.ProcessEnv = process.env): void {
  for (const [neutral, engine] of Object.entries(NATIVE_PDF_ENGINE_ENV)) {
    const value = source[neutral]?.trim();
    if (value && !target[engine]?.trim()) target[engine] = value;
  }
  // Bound engine OCR to one recognition per process unless configured: each holds ~400-500 MB in-process.
  if (!target.PDFUST_OCR_MAX_CONCURRENT?.trim()) target.PDFUST_OCR_MAX_CONCURRENT = "1";
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** worker/{src,dist}/native-pdf → <repo>/vendor-artifacts/native-pdf */
export function nativePdfVendorDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCSLURP_NATIVE_PDF_DIR?.trim() || path.resolve(here, "../../../vendor-artifacts/native-pdf");
}

export function readNativePdfManifest(dir = nativePdfVendorDir()): NativePdfManifest | null {
  const file = path.join(dir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<NativePdfManifest>;
    return typeof parsed.package === "string" && parsed.package
      ? { package: parsed.package, version: parsed.version ?? "", tarball: parsed.tarball ?? "", sha256: parsed.sha256 ?? "" }
      : null;
  } catch {
    return null;
  }
}

/** Candidate module locations, most explicit first. */
function candidates(env: NodeJS.ProcessEnv): Array<{ specifier: string; from: string; source: string }> {
  const out: Array<{ specifier: string; from: string; source: string }> = [];
  const explicit = env.DOCSLURP_NATIVE_PDF_MODULE?.trim();
  if (explicit) {
    const absolute = path.isAbsolute(explicit) || explicit.startsWith(".");
    out.push({
      specifier: absolute ? path.resolve(explicit) : explicit,
      from: path.join(process.cwd(), "noop.js"),
      source: "DOCSLURP_NATIVE_PDF_MODULE",
    });
  }
  const dir = nativePdfVendorDir(env);
  const manifest = readNativePdfManifest(dir);
  if (manifest) {
    out.push({ specifier: manifest.package, from: path.join(dir, "noop.js"), source: `vendor:${manifest.package}@${manifest.version}` });
    out.push({ specifier: manifest.package, from: fileURLToPath(import.meta.url), source: `worker:${manifest.package}` });
  }
  return out;
}

export type NativePdfModuleLoad = { ok: true; module: unknown; source: string } | { ok: false; reason: string };

let moduleCache: NativePdfModuleLoad | null = null;

/**
 * Load the raw binding module once per process (shared by the engine adapter and the page probe). Absence is a
 * normal, reported state. `env` is only read on the first call.
 */
export function loadNativePdfModule(env: NodeJS.ProcessEnv = process.env): NativePdfModuleLoad {
  if (moduleCache) return moduleCache;
  applyNativePdfEngineEnv(env);
  const tried: string[] = [];
  for (const candidate of candidates(env)) {
    try {
      const require = createRequire(candidate.from);
      const module: unknown = require(require.resolve(candidate.specifier));
      if (isNativePdfBindingModule(module)) return (moduleCache = { ok: true, module, source: candidate.source });
      tried.push(`${candidate.source}: not a native-pdf binding`);
    } catch (error) {
      tried.push(`${candidate.source}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  const reason = tried.length > 0 ? tried.join("; ") : "no engine module configured (vendor-artifacts/native-pdf/manifest.json missing)";
  console.error(`[native-pdf] engine unavailable reason=${reason}`);
  return (moduleCache = { ok: false, reason });
}

export type NativePdfEngineLoad =
  | { ok: true; engine: NativePdfEngine; source: string }
  | { ok: false; reason: string };

let engineCache: NativePdfEngineLoad | null = null;
let override: NativePdfEngineLoad | null = null;

/** The engine adapter over the binding, once per process. */
export async function loadNativePdfEngine(env: NodeJS.ProcessEnv = process.env): Promise<NativePdfEngineLoad> {
  if (override) return override;
  if (engineCache) return engineCache;
  const loaded = loadNativePdfModule(env);
  if (!loaded.ok) return (engineCache = loaded);
  const engine = new BindingNativePdfEngine(loaded.module as ConstructorParameters<typeof BindingNativePdfEngine>[0]);
  const info = engine.version();
  console.error(
    `[native-pdf] engine loaded source=${loaded.source} version=${info.version}+${info.gitSha.slice(0, 12)} ` +
      `features=${info.features.join(",")}`,
  );
  return (engineCache = { ok: true, engine, source: loaded.source });
}

/**
 * Tests and benches inject an engine, or a string to simulate absence;
 * `null` restores discovery.
 */
export function setNativePdfEngineForTesting(engine: NativePdfEngine | string | null): void {
  engineCache = null;
  if (engine === null) override = null;
  else if (typeof engine === "string") override = { ok: false, reason: engine };
  else override = { ok: true, engine, source: "test" };
}

/** `native-pdf-adapter@<version>+<sha>` for ledgers and telemetry. */
export function nativePdfAdapterVersion(engine: NativePdfEngine): string {
  const info = engine.version();
  return `native-pdf-adapter@${info.version}${info.gitSha ? `+${info.gitSha.slice(0, 12)}` : ""}`;
}
