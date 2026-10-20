import { describe, it, vi } from "vitest";

import { defineSandboxContract } from "./contract.js";
import modal from "../providers/modal/index.js";

// Live test against Modal: runs only when credentials are present in the environment.
if (process.env.MODAL_TOKEN_ID) {
  // Remote sandbox creation and exec round-trips exceed the default 5s test timeout.
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
  defineSandboxContract("modal", async () => {
    // The default image is not published yet; any public image with bash, cat, env and sleep works.
    const config = modal.readConfig({
      ...process.env,
      DOCSLURP_MODAL_IMAGE: process.env.DOCSLURP_MODAL_IMAGE ?? "debian:trixie-slim",
      DOCSLURP_MODAL_CPU: process.env.DOCSLURP_MODAL_CPU ?? "1",
      DOCSLURP_MODAL_MEMORY_MB: process.env.DOCSLURP_MODAL_MEMORY_MB ?? "1024",
      DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS: process.env.DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS ?? "300",
    });
    const probe = await modal.probe(config);
    if (!probe.ok) return { skip: probe.detail };
    return modal.openSession(config, { activityId: "contract-modal" });
  });
} else {
  describe.skip("sandbox contract: modal (set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET to run)", () => {
    it("runs against live Modal", () => {});
  });
}
