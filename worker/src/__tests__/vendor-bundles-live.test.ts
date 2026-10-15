// Opt-in live check against the private bucket. Read-only. Run with:
//   DOCSLURP_LIVE_VENDOR_BUNDLE_TEST=1 DOCSLURP_VENDOR_BUNDLE_S3_*=... pnpm --filter @docslurp/worker exec vitest run src/__tests__/vendor-bundles-live.test.ts
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ensureVendorBundle, resetVendorBundleStateForTests } from "../tools/vendor-bundles.js";

const live = process.env.DOCSLURP_LIVE_VENDOR_BUNDLE_TEST === "1";

describe.skipIf(!live)("live private vendor bundle install", () => {
  it("installs unstructured through the s3:// source", async () => {
    resetVendorBundleStateForTests();
    const cache = path.resolve(process.env.DOCSLURP_VENDOR_BUNDLE_DIR ?? ".scratch/live-vendor-cache");
    const env = {
      ...process.env,
      DOCSLURP_VENDOR_BUNDLE_BASE_URL: process.env.DOCSLURP_VENDOR_BUNDLE_BASE_URL?.startsWith("s3://") ? process.env.DOCSLURP_VENDOR_BUNDLE_BASE_URL : "s3://docslurp-vendor-bundles",
      DOCSLURP_VENDOR_BUNDLE_DIR: cache,
    };
    try {
      const installed = await ensureVendorBundle("unstructured", { env });
      expect(installed.sitePackages).toContain(cache);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  }, 900_000);
});
