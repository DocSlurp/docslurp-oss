import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { buildCatalogFeedRows, catalogFeedCsv, DEFAULT_CATALOG_IMAGES, fetchStripeCatalogPrices, uploadCatalogFeed } from "../src/services/billing/catalog-feed.js";

/**
 * Write the Stripe Agentic Commerce product feed and optionally upload it.
 *
 *   pnpm --filter @docslurp/server catalog:feed --out feed.csv
 *   pnpm --filter @docslurp/server catalog:feed --stripe-product prod_123 --upload
 *
 * Uses STRIPE_SECRET_KEY (or a restricted key with Product Catalog Imports
 * write, plus Products read for --stripe-product). Live keys also need --live,
 * so a sandbox validates first.
 */
const { values } = parseArgs({
  options: {
    link: { type: "string", default: process.env.STRIPE_CATALOG_LINK },
    "plan-image": { type: "string", default: DEFAULT_CATALOG_IMAGES.plan },
    "credits-image": { type: "string", default: DEFAULT_CATALOG_IMAGES.credits },
    "stripe-product": { type: "string", multiple: true, default: process.env.STRIPE_CATALOG_PRODUCTS?.split(",").map((id) => id.trim()).filter(Boolean) ?? [] },
    out: { type: "string" },
    upload: { type: "boolean", default: false },
    mode: { type: "string", default: "upsert" },
    live: { type: "boolean", default: false },
  },
});

if (values.mode !== "upsert" && values.mode !== "replace") throw new Error("--mode must be upsert or replace");
const live = /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY?.trim() ?? "");
if (values.upload && live && !values.live) throw new Error("STRIPE_SECRET_KEY is a live key; validate in a sandbox, then pass --live");

const stripePrices = values["stripe-product"].length ? await fetchStripeCatalogPrices(values["stripe-product"]) : [];
const csv = catalogFeedCsv(buildCatalogFeedRows({
  images: { plan: values["plan-image"], credits: values["credits-image"] }, stripePrices, ...(values.link && { link: values.link }),
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
