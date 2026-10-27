import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadWorkspaceEnvFiles } from "../src/env-files.js";

import { buildCatalogFeedRows, catalogFeedCsv, DEFAULT_CATALOG_IMAGES, fetchStripeCatalogPrices, uploadCatalogFeed } from "../src/services/billing/catalog-feed.js";

/**
 * Write the Stripe Agentic Commerce product feed and optionally upload it.
 *
 *   pnpm --filter @docslurp/server catalog:feed --out feed.csv
 *   pnpm --filter @docslurp/server catalog:feed --env production --upload --live
 *
 * --env production overlays root .env.production on .env. Shell/CI values win.
 * The default local environment loads only .env.
 *
 * Uses STRIPE_SECRET_KEY (or a restricted key with Product Catalog Imports
 * write, plus Products read for --stripe-product). Live keys also need --live,
 * so a sandbox validates first. The feed lists credit packs only; upload once
 * with --mode replace to drop the retired plan rows from the Stripe catalog.
 */
const { values } = parseArgs({
  options: {
    env: { type: "string", default: "local" },
    link: { type: "string" },
    "credits-image": { type: "string", default: DEFAULT_CATALOG_IMAGES.credits },
    "stripe-product": { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    upload: { type: "boolean", default: false },
    mode: { type: "string", default: "upsert" },
    live: { type: "boolean", default: false },
  },
});

if (values.env !== "local" && values.env !== "production") throw new Error("--env must be local or production");
loadWorkspaceEnvFiles(import.meta.url, values.env === "production");
const link = values.link ?? process.env.STRIPE_CATALOG_LINK;
const productIds = values["stripe-product"].length ? values["stripe-product"]
  : process.env.STRIPE_CATALOG_PRODUCTS?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];

if (values.mode !== "upsert" && values.mode !== "replace") throw new Error("--mode must be upsert or replace");
const live = /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY?.trim() ?? "");
if (values.upload && live && !values.live) throw new Error("STRIPE_SECRET_KEY is a live key; validate in a sandbox, then pass --live");

const stripePrices = productIds.length ? await fetchStripeCatalogPrices(productIds) : [];
const csv = catalogFeedCsv(buildCatalogFeedRows({
  images: { credits: values["credits-image"] }, stripePrices, ...(link && { link }),
}));
if (values.out) await writeFile(values.out, csv);
else if (!values.upload) process.stdout.write(csv);

if (values.upload) {
  const fileName = `docslurp_product_feed_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  const result = await uploadCatalogFeed(csv, { fileName, mode: values.mode });
  const details = result.import.status_details;
  console.log(`${result.import.id} ${result.import.status} (livemode=${result.import.livemode})`);
  if (details?.failed) console.error(`${details.failed.code}: ${details.failed.failure_message}`);
  if (result.errorCsv) console.error(result.errorCsv);
  if (result.import.status !== "succeeded") process.exitCode = 1;
}
