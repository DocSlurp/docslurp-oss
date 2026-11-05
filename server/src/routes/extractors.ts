import { existsSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { configureExtractorIdAliases, publicDocumentExtractorDescriptors } from "@docslurp/shared";

/** The optional native PDF engine is listed only where it is installed. */
export function nativePdfInstalled(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): boolean {
  if (env.DOCSLURP_NATIVE_PDF_INSTALLED === "1" || env.DOCSLURP_NATIVE_PDF_INSTALLED === "true") return true;
  if (env.DOCSLURP_NATIVE_PDF_MODULE?.trim()) return true;
  const dir = env.DOCSLURP_NATIVE_PDF_DIR?.trim() || path.join(cwd, "vendor-artifacts/native-pdf");
  return existsSync(path.join(dir, "node_modules"));
}

/** The extractor ids this API lists: the public catalog, with optional engines only where installed. */
export function apiExtractorIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return publicDocumentExtractorDescriptors({ nativePdfInstalled: nativePdfInstalled(env), vmPdfInstalled: env.DOCSLURP_VM_PDF_INSTALLED === "1" }).map((entry) => entry.id);
}

/**
 * Install DOCSLURP_EXTRACTOR_ID_ALIASES against the ids this API lists, at startup and before any config is parsed.
 * An alias to an id the API does not list (`vm-pdf` without DOCSLURP_VM_PDF_INSTALLED=1) or over a built-in id throws.
 */
export function configureApiExtractorIdAliases(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, string> {
  return configureExtractorIdAliases(apiExtractorIds(env), env);
}

/** Catalog metadata is shared with the worker. Availability is worker-local. */
export const extractorRoutes = new Hono().get("/", (c) =>
  c.json({ extractors: publicDocumentExtractorDescriptors({ nativePdfInstalled: nativePdfInstalled(), vmPdfInstalled: process.env.DOCSLURP_VM_PDF_INSTALLED === "1" }) }),
);
