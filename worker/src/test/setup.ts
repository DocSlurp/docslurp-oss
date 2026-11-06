// Usage pricing in tests uses the hardcoded tables; the live OpenRouter catalog is never fetched.
if (process.env.LIVE_MODEL_PRICES === undefined) process.env.LIVE_MODEL_PRICES = "off";
if (process.env.DOCSLURP_PARSER_SANDBOX === undefined) {
  process.env.DOCSLURP_PARSER_SANDBOX = "none";
}
// "none" cannot filter UNIX sockets; the development opt-in lets tests run commands under it. Tests
// of the refusal unset it.
if (process.env.DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS === undefined) {
  process.env.DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS = "1";
}
// Tests mock @huggingface/transformers in-process; a worker thread would load the real package.
if (process.env.DOCSLURP_LOCAL_EMBED_THREAD === undefined) {
  process.env.DOCSLURP_LOCAL_EMBED_THREAD = "off";
}

// Extraction suites exercise host PDF extractors, which run only in customer-owned local PDF mode; the PDF-mode boundary
// tests stub DOCSLURP_PDF_MODE (and the profile) themselves.
if (process.env.DOCSLURP_PDF_MODE === undefined) process.env.DOCSLURP_PDF_MODE = "local";

// Unit suites do not launch paid VM preprocessing; orientation suites explicitly enable/mock it.
process.env.DOCSLURP_IMAGE_ORIENTATION = "false";

// Billing suites price through an installed provider with arbitrary, distinct test prices (a Rich page costs more than a
// Fast one, a long output adds Rich pages, video frames add media pages), never a deployment's real prices. Suites that
// need other numbers install their own (`installTestPricing`).
import { DISTINCT_TEST_PRICING, installTestPricing } from "@docslurp/shared";
installTestPricing(DISTINCT_TEST_PRICING);
