import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

import { defineSandboxContract } from "./contract.js";
import { bubblewrapProvider as bubblewrap } from "../providers/bubblewrap/index.js";
import none from "../providers/none/index.js";

const bubblewrapScratch = path.join(tmpdir(), "docslurp-contract-scratch");
afterAll(() => rmSync(bubblewrapScratch, { recursive: true, force: true }));

defineSandboxContract("none", async () => none.openSession(none.readConfig({}), { activityId: "contract-none" }));

defineSandboxContract("bubblewrap", async () => {
  // The launcher's scratch root must not default to /tmp, which is quota-limited on some hosts.
  const scratchRoot = bubblewrapScratch;
  mkdirSync(scratchRoot, { recursive: true });
  const config = bubblewrap.readConfig({ DOCSLURP_PARSER_SANDBOX_ROOT: scratchRoot });
  const probe = await bubblewrap.probe(config);
  if (!probe.ok) {
    console.warn(`[contract] bubblewrap unavailable, skipping: ${probe.detail}`);
    return { skip: probe.detail };
  }
  return bubblewrap.openSession(config, { activityId: "contract-bubblewrap" });
});
