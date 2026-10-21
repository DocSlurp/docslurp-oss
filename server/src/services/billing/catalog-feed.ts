import type Stripe from "stripe";

import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, SERVICE_PLANS } from "@docslurp/shared";

import { appUrl, getStripe } from "./stripe-client.js";

/**
 * The Stripe Agentic Commerce catalog feed
 * (docs.stripe.com/agentic-commerce/concepts/catalog-feed): paid plans,
 * prepaid credit packs and any extra Stripe products as CSV rows, plus the
 * Product Catalog Import upload.
 *
 * Every row is discovery-only (`disable_checkout=true`). Agent checkout
 * completes a Checkout Session with no DocSlurp organization attached, so
 * nothing could grant the credits or start the subscription; agents send the
 * buyer to the pricing page instead.
 */

/** Product Catalog Imports are preview-only; the client's pinned version does not serve them. */
export const CATALOG_IMPORT_API_VERSION = "2026-09-30.preview";

/** Software as a service, business use. Plans and credits are both SaaS access. */
const SAAS_TAX_CODE = "txcd_10103001";

/** Prepaid credit packs listed for discovery, in cents (1 credit = 1 cent). */
export const CREDIT_PACK_CENTS = [2_500, 10_000, 50_000] as const;

export const CATALOG_FEED_COLUMNS = [
  "id", "title", "description", "link", "brand", "mpn", "image_link", "product_category",
  "item_group_id", "item_group_title", "custom_variant_option_name_1", "custom_variant_option_value_1",
  "availability", "inventory_not_tracked", "price", "stripe_product_tax_code", "tax_behavior",
  "product_highlight", "disable_checkout",
] as const;

export type CatalogFeedRow = Record<(typeof CATALOG_FEED_COLUMNS)[number], string>;

const BRAND_ASSETS = "https://raw.githubusercontent.com/DocSlurp/docslurp-oss/main/docs/brand";

/** Public JPEG or PNG images, at least 800×800, from docs/brand by default. */
export const DEFAULT_CATALOG_IMAGES = {
  plan: `${BRAND_ASSETS}/product-plan-1200.png`,
  credits: `${BRAND_ASSETS}/product-credits-1200.png`,
};

export interface CatalogFeedOptions {
  /** Public landing page for every product. Must answer HTTP 200 without a session. */
  link?: string;
  images?: { plan: string; credits: string };
  /** Extra Stripe prices to list, each with its product expanded. */
  stripePrices?: readonly Stripe.Price[];
}

const PRODUCT_CATEGORY = "Software > Computer Software > Business & Productivity Software";

function usd(cents: number): string {
  return `${(cents / 100).toFixed(2)} USD`;
}

function credits(n: number): string {
  return n.toLocaleString("en-US");
}

const NO_VARIANT = { item_group_id: "", item_group_title: "", custom_variant_option_name_1: "", custom_variant_option_value_1: "" };

export function buildCatalogFeedRows(options: CatalogFeedOptions = {}): CatalogFeedRow[] {
  const link = options.link ?? `${appUrl()}/pricing`;
  const images = options.images ?? DEFAULT_CATALOG_IMAGES;
  const shared = {
    link, brand: "DocSlurp", image_link: images.credits, product_category: PRODUCT_CATEGORY,
    availability: "in_stock", inventory_not_tracked: "true", stripe_product_tax_code: SAAS_TAX_CODE,
    tax_behavior: "exclusive", disable_checkout: "true",
  };
  const plans = SERVICE_PLANS.filter((plan) => plan.stripeLookupKey && plan.monthlyMinimumCents > 0).map((plan): CatalogFeedRow => {
    const id = `docslurp-plan-${plan.id}`;
    return {
      ...shared, id, mpn: id, image_link: images.plan,
      title: `DocSlurp ${plan.label} plan, monthly`,
      description: `${plan.tagline} DocSlurp turns documents and media into page-by-page Markdown, chunks, embeddings and structured fields, served through search, RAG context and cited chat. `
        + `The ${plan.label} plan bills a $${(plan.monthlyMinimumCents / 100).toFixed(2)} monthly minimum in advance and includes ${credits(plan.includedCreditsPerMonth)} credits each month. Support: ${plan.support}.`,
      item_group_id: "docslurp-plans", item_group_title: "DocSlurp plans",
      custom_variant_option_name_1: "Plan", custom_variant_option_value_1: plan.label,
      price: usd(plan.monthlyMinimumCents),
      product_highlight: JSON.stringify(plan.highlights),
    };
  });
  const packs = CREDIT_PACK_CENTS.map((cents): CatalogFeedRow => {
    if (cents < MIN_TOPUP_CENTS || cents > MAX_TOPUP_CENTS) throw new Error(`Credit pack ${cents} is outside the top-up range`);
    const id = `docslurp-credits-${cents}`;
    return {
      ...shared, id, mpn: id,
      title: `DocSlurp ${credits(cents)} prepaid credits`,
      description: `${credits(cents)} prepaid DocSlurp credits for document ingestion, search and chat (1 credit = $0.01). Credits are added to your organization's prepaid balance.`,
      item_group_id: "docslurp-credits", item_group_title: "DocSlurp prepaid credits",
      custom_variant_option_name_1: "Credits", custom_variant_option_value_1: credits(cents),
      price: usd(cents),
      product_highlight: JSON.stringify(["1 credit = $0.01", "Pays for ingestion, search and chat"]),
    };
  });
  const extra = (options.stripePrices ?? []).map((price) => stripePriceRow(price, shared));
  return [...plans, ...packs, ...extra];
}

/** A Stripe price as a feed row, keyed by its product so the row survives price changes. */
function stripePriceRow(price: Stripe.Price, shared: Omit<CatalogFeedRow, "id" | "mpn" | "title" | "description" | "price" | "product_highlight" | keyof typeof NO_VARIANT>): CatalogFeedRow {
  const product = price.product;
  if (typeof product !== "object" || product.deleted) throw new Error(`Price ${price.id} needs its product expanded`);
  if (price.currency !== "usd" || price.unit_amount === null) throw new Error(`Price ${price.id} is not a fixed USD amount`);
  const interval = price.recurring ? (price.recurring.interval_count === 1 ? price.recurring.interval : `${price.recurring.interval_count} ${price.recurring.interval}s`) : null;
  // Dashboard-entered copy often runs sentences together ("DocSlurp.Tokens").
  const description = (product.description ?? product.name).replace(/\.(?=[A-Z])/g, ". ");
  const billing = interval ? `Billed $${(price.unit_amount / 100).toFixed(2)} every ${interval}.` : "One-time purchase.";
  const highlights = [...new Set(product.marketing_features.map((feature) => feature.name?.trim()).filter((name): name is string => Boolean(name)))];
  return {
    ...shared, ...NO_VARIANT, id: product.id, mpn: product.id,
    title: interval === "month" ? `${product.name}, monthly` : product.name,
    description: `${description} ${billing}`,
    image_link: product.images[0] ?? shared.image_link,
    price: usd(price.unit_amount),
    stripe_product_tax_code: product.tax_code && typeof product.tax_code === "string" ? product.tax_code : shared.stripe_product_tax_code,
    tax_behavior: price.tax_behavior === "inclusive" ? "inclusive" : "exclusive",
    product_highlight: JSON.stringify(highlights.slice(0, 30)),
  };
}

/** The default price of each product, expanded for {@link buildCatalogFeedRows}. */
export async function fetchStripeCatalogPrices(productIds: readonly string[], stripe: Stripe = getStripe()): Promise<Stripe.Price[]> {
  return Promise.all(productIds.map(async (id) => {
    const product = await stripe.products.retrieve(id, { expand: ["default_price"] });
    const price = product.default_price;
    if (!product.active || !price || typeof price !== "object" || !price.active) throw new Error(`Product ${id} has no active default price`);
    return { ...price, product };
  }));
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

export function catalogFeedCsv(rows: readonly CatalogFeedRow[]): string {
  const lines = [CATALOG_FEED_COLUMNS.join(","), ...rows.map((row) => CATALOG_FEED_COLUMNS.map((column) => csvField(row[column])).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

const TERMINAL = new Set(["succeeded", "succeeded_with_errors", "failed"]);

export interface CatalogImportOptions {
  feedType?: "product" | "inventory" | "pricing" | "promotion";
  /** `replace` deletes every catalog product missing from the file; product feeds only. */
  mode?: "upsert" | "replace";
  fileName: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  stripe?: Stripe;
  fetch?: typeof fetch;
}

/**
 * Create a Product Catalog Import, PUT the CSV to its presigned URL (valid five
 * minutes) and poll until Stripe finishes. A `succeeded_with_errors` import
 * also returns its error CSV, which expires five minutes after retrieval.
 */
export async function uploadCatalogFeed(csv: string, options: CatalogImportOptions): Promise<{ import: Stripe.V2.Commerce.ProductCatalogImport; errorCsv?: string }> {
  const stripe = options.stripe ?? getStripe();
  const http = options.fetch ?? fetch;
  const requestOptions = { apiVersion: CATALOG_IMPORT_API_VERSION };
  const imports = stripe.v2.commerce.productCatalog.imports;
  const created = await imports.create({
    feed_type: options.feedType ?? "product", mode: options.mode ?? "upsert", metadata: { file_name: options.fileName },
  }, requestOptions);
  const uploadUrl = created.status_details?.awaiting_upload?.upload_url.url;
  if (!uploadUrl) throw new Error(`Catalog import ${created.id} returned no upload URL (status ${created.status})`);
  const put = await http(uploadUrl, { method: "PUT", headers: { "Content-Type": "text/csv" }, body: csv });
  if (!put.ok) throw new Error(`Catalog upload for ${created.id} failed with HTTP ${put.status}`);

  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  let current = created;
  while (!TERMINAL.has(current.status)) {
    if (Date.now() > deadline) throw new Error(`Catalog import ${created.id} still ${current.status} after the timeout`);
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 5_000));
    current = await imports.retrieve(created.id, {}, requestOptions);
  }
  const errorUrl = current.status_details?.succeeded_with_errors?.error_file.download_url.url;
  if (!errorUrl) return { import: current };
  const errors = await http(errorUrl);
  return { import: current, ...(errors.ok && { errorCsv: await errors.text() }) };
}
