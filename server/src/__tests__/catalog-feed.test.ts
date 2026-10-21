import { describe, expect, it, vi } from "vitest";

import { buildCatalogFeedRows, CATALOG_FEED_COLUMNS, CATALOG_IMPORT_API_VERSION, catalogFeedCsv, uploadCatalogFeed } from "../services/billing/catalog-feed.js";

const images = { plan: "https://docslurp.example/plan.png", credits: "https://docslurp.example/credits.png" };

describe("Stripe catalog feed", () => {
  it("lists paid plans and credit packs as discovery-only SaaS products", () => {
    const rows = buildCatalogFeedRows({ images, link: "https://docslurp.example/pricing" });
    expect(rows.map((row) => [row.id, row.price])).toEqual([
      ["docslurp-plan-silver", "20.00 USD"],
      ["docslurp-plan-gold", "50.00 USD"],
      ["docslurp-plan-platinum", "500.00 USD"],
      ["docslurp-credits-2500", "25.00 USD"],
      ["docslurp-credits-10000", "100.00 USD"],
      ["docslurp-credits-50000", "500.00 USD"],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        brand: "DocSlurp", mpn: row.id, link: "https://docslurp.example/pricing",
        image_link: row.id.startsWith("docslurp-plan-") ? images.plan : images.credits,
        availability: "in_stock", inventory_not_tracked: "true", stripe_product_tax_code: "txcd_10103001", disable_checkout: "true",
      });
      // Field limits from the feed spec.
      expect(row.id.length).toBeLessThanOrEqual(100);
      expect(row.title.length).toBeLessThanOrEqual(150);
      expect(row.description.length).toBeLessThanOrEqual(5000);
      expect(JSON.parse(row.product_highlight).every((item: string) => item.length <= 150)).toBe(true);
    }
    expect(rows[1]!.title).toBe("DocSlurp Gold plan, monthly");
    expect(rows[1]!.description).toContain("$50.00 monthly minimum in advance and includes 5,500 credits each month");
  });

  it("lists extra Stripe products from their default price", () => {
    const product = {
      id: "prod_pro", object: "product", deleted: undefined, name: "DocSlurp – Pro Token Pack", images: [], tax_code: null,
      description: "Purchase tokens to use within DocSlurp.Tokens are consumed by usage.",
      marketing_features: [{ name: "Fast workflows" }, { name: "Fast workflows" }, { name: " " }],
    };
    const price = { id: "price_pro", currency: "usd", unit_amount: 2500, tax_behavior: "unspecified", recurring: { interval: "month", interval_count: 1 }, product };
    const [row] = buildCatalogFeedRows({ images, stripePrices: [price as never] }).slice(-1);
    expect(row).toMatchObject({
      id: "prod_pro", mpn: "prod_pro", title: "DocSlurp – Pro Token Pack, monthly", price: "25.00 USD", image_link: images.credits,
      description: "Purchase tokens to use within DocSlurp. Tokens are consumed by usage. Billed $25.00 every month.",
      stripe_product_tax_code: "txcd_10103001", tax_behavior: "exclusive", item_group_id: "", disable_checkout: "true",
      product_highlight: JSON.stringify(["Fast workflows"]),
    });
  });

  it("writes RFC 4180 CSV with quoted JSON and commas", () => {
    const csv = catalogFeedCsv(buildCatalogFeedRows({ images }));
    const [header, firstRow] = csv.split("\r\n");
    expect(header).toBe(CATALOG_FEED_COLUMNS.join(","));
    expect(firstRow).toContain(`"[""2,000 credits every month"",`);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("creates the import on the preview API, PUTs the CSV and polls to a terminal status", async () => {
    const pending = { id: "pcimprt_1", status: "awaiting_upload", status_details: { awaiting_upload: { upload_url: { url: "https://upload.example/put", expires_at: "" } } } };
    const create = vi.fn(async () => pending);
    const retrieve = vi.fn()
      .mockResolvedValueOnce({ id: "pcimprt_1", status: "processing" })
      .mockResolvedValueOnce({ id: "pcimprt_1", status: "succeeded_with_errors", status_details: { succeeded_with_errors: { error_file: { download_url: { url: "https://upload.example/errors" } } } } });
    const http = vi.fn(async (url: string | URL | Request) => new Response(String(url).endsWith("errors") ? "stripe_error_message,id\nbad,docslurp-plan-gold\n" : null, { status: 200 }));
    const stripe = { v2: { commerce: { productCatalog: { imports: { create, retrieve } } } } };

    const result = await uploadCatalogFeed("id\nx\n", { fileName: "feed.csv", stripe: stripe as never, fetch: http as never, pollIntervalMs: 0 });

    expect(create).toHaveBeenCalledWith({ feed_type: "product", mode: "upsert", metadata: { file_name: "feed.csv" } }, { apiVersion: CATALOG_IMPORT_API_VERSION });
    expect(http.mock.calls[0]).toEqual(["https://upload.example/put", { method: "PUT", headers: { "Content-Type": "text/csv" }, body: "id\nx\n" }]);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(result.import.status).toBe("succeeded_with_errors");
    expect(result.errorCsv).toContain("docslurp-plan-gold");
  });
});
