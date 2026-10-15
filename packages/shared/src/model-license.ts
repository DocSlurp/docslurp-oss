import { z } from "zod";

// Licence classes for models and engines the router can select or call.
//
//   free               OSI/permissive licence (MIT, Apache-2.0, BSD, OFL, AGPL...) and our own code.
//   non-free           custom addenda, non-commercial, research-only, LFM/Gemma-style terms, or no declared licence.
//   proprietary-hosted closed models reached only through a vendor API (Gemini, Claude, GPT, Jev, Clef, pplx-decider).
//
// DISABLE_NON_FREE_SOFTWARE removes "non-free" only. Proprietary hosted APIs stay governed by the privacy
// modes (standard / local-only / strict-privacy, packages/shared/src/privacy.ts), not by this flag.

export const licenseClassSchema = z.enum(["free", "non-free", "proprietary-hosted"]);
export type LicenseClass = z.infer<typeof licenseClassSchema>;

export const modelLicenseSchema = z.object({
  /** SPDX id or Hub licence tag as declared, e.g. "apache-2.0", "mit", "cc-by-nc-4.0", "lfm1.0", "none-declared". */
  id: z.string().min(1),
  /** Where the licence was read (Hub model card API, repository, vendor terms) and when it was verified. */
  source: z.string().min(1),
  /** Short note for non-free and borderline entries. */
  note: z.string().optional(),
});
export type ModelLicense = z.infer<typeof modelLicenseSchema>;

export interface ModelLicenseEntry extends ModelLicense {
  licenseClass: LicenseClass;
}

const VERIFIED = "verified 2026-10-13";
const hub = (repo: string) => `huggingface.co/${repo} model card, ${VERIFIED}`;

/**
 * Known licences keyed by lower-case target id, model id or private model name. Entries cover every model the
 * router catalogs reference plus the models the research docs evaluated (internal research notes).
 */
export const MODEL_LICENSES: Readonly<Record<string, ModelLicenseEntry>> = {
  // ---- self-hosted OCR / VLM, free
  "lightonocr-3": { licenseClass: "free", id: "apache-2.0", source: hub("lightonai/LightOnOCR-3-0.8B") },
  "mineru2.5": { licenseClass: "free", id: "apache-2.0", source: hub("opendatalab/MinerU2.5-Pro-2605-1.2B") },
  "infinity-parser2": { licenseClass: "free", id: "apache-2.0", source: hub("infly/Infinity-Parser2-Flash") },
  "olmocr-2": { licenseClass: "free", id: "apache-2.0", source: hub("allenai/olmOCR-2-7B-1025") },
  "deepseek-ocr-2": { licenseClass: "free", id: "apache-2.0", source: hub("deepseek-ai/DeepSeek-OCR-2") },
  "paddleocr-vl": { licenseClass: "free", id: "apache-2.0", source: hub("PaddlePaddle/PaddleOCR-VL-1.6") },
  "qwen/qwen3-vl-8b-instruct": { licenseClass: "free", id: "apache-2.0", source: hub("Qwen/Qwen3-VL-8B-Instruct") },
  "qwen/qwen2-vl-2b-instruct": { licenseClass: "free", id: "apache-2.0", source: hub("Qwen/Qwen2-VL-2B-Instruct") },
  "microsoft/florence-2-small-ft": { licenseClass: "free", id: "mit", source: `microsoft/Florence-2 model card (MIT), ${VERIFIED}` },
  "microsoft/florence-2-base-ft": { licenseClass: "free", id: "mit", source: `microsoft/Florence-2 model card (MIT), ${VERIFIED}` },
  "florence-2-small": { licenseClass: "free", id: "mit", source: `microsoft/Florence-2 model card (MIT), ${VERIFIED}` },
  // ---- self-hosted, non-free
  "dots-ocr": {
    licenseClass: "non-free",
    id: "mit+addendum",
    source: hub("dots-studio/dots.ocr"),
    note: "MIT plus a data-governance licence addendum; no legal review yet",
  },
  "nanonets-ocr2": {
    licenseClass: "non-free",
    id: "none-declared",
    source: hub("nanonets/Nanonets-OCR2-3B"),
    note: "No licence declared; base Qwen2.5-VL-3B is qwen-research",
  },
  "qwen/qwen2.5-vl-3b-instruct": {
    licenseClass: "non-free",
    id: "qwen-research",
    source: hub("Qwen/Qwen2.5-VL-3B-Instruct"),
    note: "Qwen research licence (non-commercial)",
  },
  "jinaai/jina-embeddings-v5-omni-small": {
    licenseClass: "non-free",
    id: "cc-by-nc-4.0",
    source: hub("jinaai/jina-embeddings-v5-omni-small"),
    note: "Non-commercial",
  },
  "onnx-community/embeddinggemma-300m-onnx": {
    licenseClass: "non-free",
    id: "gemma-terms",
    source: "ai.google.dev/gemma/terms",
    note: "Gemma terms of use (custom, use restrictions)",
  },
  // ---- Liquid decision models: LFM licence, also when reached through a hosted API
  "liquid/d1": { licenseClass: "proprietary-hosted", id: "proprietary", source: "OpenRouter /systemone route; vendor terms", note: "Hosted API; we never run the LFM-licensed weights on this route" },
  "liquid/d1:direct": { licenseClass: "non-free", id: "lfm1.0", source: hub("LiquidAI/d1-3B"), note: "LFM licence (revenue threshold)" },
  "local/liquidai/d1-omni-600m": { licenseClass: "non-free", id: "lfm1.0", source: hub("LiquidAI/d1-omni-600M"), note: "LFM licence" },
  // ---- open-weight models we call only through a hosted API (weights licence verified)
  "inclusionai/ling-3.0-flash-vl": { licenseClass: "free", id: "mit", source: hub("inclusionAI/Ling-3.0-Flash-VL") },
  "deepseek/deepseek-v4.1-flash": { licenseClass: "free", id: "mit", source: hub("deepseek-ai/DeepSeek-V4.1-Flash") },
  "z-ai/glm-5.3-flash": { licenseClass: "free", id: "mit", source: hub("zai-org/GLM-5.3-Flash") },
  // ---- native engines
  "native:accept-text-layer": { licenseClass: "free", id: "internal", source: "DocSlurp code" },
  "native:pdf-markdown": { licenseClass: "free", id: "internal", source: "DocSlurp native-pdf engine" },
  "native:pdf-text": { licenseClass: "free", id: "internal", source: "DocSlurp native-pdf engine" },
  "ocr:pdf-ocr-fill": { licenseClass: "free", id: "internal", source: "DocSlurp native-pdf engine" },
  "ocr:pdf-ocr": { licenseClass: "free", id: "internal", source: "DocSlurp native-pdf engine" },
  "native:kreuzberg": { licenseClass: "free", id: "mit", source: `pypi.org/project/kreuzberg, ${VERIFIED}` },
  "native:pymupdf": { licenseClass: "free", id: "agpl-3.0", source: "pymupdf.readthedocs.io licence (AGPL-3.0, OSI-approved)", note: "Copyleft; commercial licence exists" },
  "ocr:tesseract": { licenseClass: "free", id: "apache-2.0", source: "github.com/tesseract-ocr/tesseract" },
  skip: { licenseClass: "free", id: "internal", source: "no model" },
  // ---- closed hosted decision APIs
  "perplexity/pplx-decider-v1.1-27b": { licenseClass: "proprietary-hosted", id: "proprietary", source: "Perplexity API terms" },
  "typesafe/jev-1.13": { licenseClass: "proprietary-hosted", id: "proprietary", source: "OpenRouter /systemone route; vendor terms" },
  "cloudflare/clef-flash": { licenseClass: "proprietary-hosted", id: "proprietary", source: "OpenRouter /systemone route; vendor terms" },
  "cloudflare/clef-omni": { licenseClass: "proprietary-hosted", id: "proprietary", source: "OpenRouter /systemone route; vendor terms" },
  "openai/gpt-6-luna-decisions": { licenseClass: "proprietary-hosted", id: "proprietary", source: "OpenAI API terms" },
};

/** Kinds whose licence is unknown unless listed: open weights and local checkpoints fail closed to non-free. */
const KIND_DEFAULT: Readonly<Record<string, LicenseClass>> = {
  native: "free",
  skip: "free",
  "local-ocr": "free",
  "hosted-vlm": "proprietary-hosted",
  "private-vlm": "non-free",
  "local-labeler": "non-free",
};

export function lookupModelLicense(...keys: Array<string | null | undefined>): ModelLicenseEntry | undefined {
  for (const key of keys) {
    if (!key) continue;
    const hit = MODEL_LICENSES[key.toLowerCase()];
    if (hit) return hit;
  }
  return undefined;
}

/** `llm://private/dots-ocr` -> `dots-ocr`; `llm://openrouter/z-ai/glm-5.3-flash` -> `z-ai/glm-5.3-flash`. */
export function modelNameFromUri(uri: string | undefined): string | null {
  return uri ? uri.replace(/^llm:\/\/[^/]+\//, "") : null;
}

export interface ResolvedLicense {
  licenseClass: LicenseClass;
  license: ModelLicense;
}

function resolve(entry: ModelLicenseEntry | undefined, fallback: LicenseClass, what: string): ResolvedLicense {
  if (entry) {
    const { licenseClass, ...license } = entry;
    return { licenseClass, license };
  }
  return {
    licenseClass: fallback,
    license: {
      id: fallback === "non-free" ? "none-declared" : fallback === "proprietary-hosted" ? "proprietary" : "unspecified",
      source: `default for ${what}`,
    },
  };
}

/** Licence of a routing target: the known entry, else the default for its kind (open weights fail closed to non-free). */
export function resolveTargetLicense(target: {
  id: string;
  kind: string;
  ref?: { modelUri?: string | undefined; extractorId?: string | undefined };
  licenseClass?: LicenseClass | undefined;
  license?: ModelLicense | undefined;
}): ResolvedLicense {
  if (target.licenseClass) {
    return { licenseClass: target.licenseClass, license: target.license ?? { id: "declared", source: "target definition" } };
  }
  const model = modelNameFromUri(target.ref?.modelUri);
  return resolve(lookupModelLicense(target.id, model), KIND_DEFAULT[target.kind] ?? "non-free", `${target.kind} targets`);
}

/** Licence of a decision model: the known entry, else hosted -> proprietary-hosted, local -> non-free. */
export function resolveDecisionModelLicense(model: {
  id: string;
  availability: { privacyClass: string };
  licenseClass?: LicenseClass | undefined;
  license?: ModelLicense | undefined;
}): ResolvedLicense {
  if (model.licenseClass) {
    return { licenseClass: model.licenseClass, license: model.license ?? { id: "declared", source: "model definition" } };
  }
  return resolve(
    lookupModelLicense(model.id),
    model.availability.privacyClass === "hosted" ? "proprietary-hosted" : "non-free",
    "decision models",
  );
}

/** Licence class of a model by id or `llm://` URI (embedding and vision catalogs); unknown local weights are non-free. */
export function licenseClassOfModel(idOrUri: string, fallback: LicenseClass = "non-free"): LicenseClass {
  const isHostedUri = /^llm:\/\/(openrouter|openai|anthropic|google)\//.test(idOrUri);
  const entry = lookupModelLicense(idOrUri, modelNameFromUri(idOrUri));
  if (entry) return entry.licenseClass;
  return isHostedUri ? "proprietary-hosted" : fallback;
}

export function isNonFreeLicenseClass(value: LicenseClass | undefined): boolean {
  return value === "non-free";
}

// ---- DISABLE_NON_FREE_SOFTWARE ---------------------------------------------

export const DISABLE_NON_FREE_SOFTWARE_ENV = "DISABLE_NON_FREE_SOFTWARE";

const warnedFlags = new Set<string>();

/**
 * Reads DISABLE_NON_FREE_SOFTWARE. Default false (non-free allowed). `1`/`true` (any case) enable it, `0`/`false`
 * or unset disable it; anything else is a typo: default false with one warning per process.
 */
export function readDisableNonFreeSoftware(
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): boolean {
  const raw = env[DISABLE_NON_FREE_SOFTWARE_ENV]?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  if (!warnedFlags.has(raw)) {
    warnedFlags.add(raw);
    warn(`[licenses] ignoring unknown ${DISABLE_NON_FREE_SOFTWARE_ENV}=${raw}; using false (allowed: true, false, 1, 0)`);
  }
  return false;
}

/** Test hook. */
export function resetDisableNonFreeSoftwareWarnings(): void {
  warnedFlags.clear();
}

/** Drops entries whose class is non-free when the flag is on. */
export function filterNonFree<T>(items: readonly T[], classOf: (item: T) => LicenseClass | undefined, disableNonFree: boolean): T[] {
  return disableNonFree ? items.filter((item) => classOf(item) !== "non-free") : [...items];
}
