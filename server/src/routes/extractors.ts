import { existsSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { publicDocumentExtractorDescriptors } from "@docslurp/shared";

/** The optional native PDF engine is listed only where it is installed. */
export function nativePdfInstalled(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): boolean {
  if (env.DOCSLURP_NATIVE_PDF_INSTALLED === "1" || env.DOCSLURP_NATIVE_PDF_INSTALLED === "true") return true;
  if (env.DOCSLURP_NATIVE_PDF_MODULE?.trim()) return true;
  const dir = env.DOCSLURP_NATIVE_PDF_DIR?.trim() || path.join(cwd, "vendor-artifacts/native-pdf");
  return existsSync(path.join(dir, "node_modules"));
}

/** Catalog metadata is shared with the worker. Availability is worker-local. */
export const extractorRoutes = new Hono().get("/", (c) =>
  c.json({ extractors: publicDocumentExtractorDescriptors({ nativePdfInstalled: nativePdfInstalled(), dopplerInstalled: process.env.DOCSLURP_DOPPLER_INSTALLED === "1" }) }),
);
