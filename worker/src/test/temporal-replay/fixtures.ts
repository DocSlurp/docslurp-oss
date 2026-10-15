/**
 * Shared paths and file format for the recorded Temporal workflow histories
 * that `temporal-replay.test.ts` replays against the current workflow code.
 * See docs/temporal-workflow-changes.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HISTORY_FIXTURE_DIR = fileURLToPath(new URL("../../../testdata/temporal-histories/", import.meta.url));
export const WORKFLOWS_PATH = fileURLToPath(new URL("../../temporal/workflows.ts", import.meta.url));

export interface HistoryFixture {
  /** Scenario that produced this history (one scenario can record a parent and its children). */
  scenario: string;
  description: string;
  workflowType: string;
  /** Replay needs the original id: page-batch child ids are derived from it. */
  workflowId: string;
  recordedWith: { temporalSdk: string; server: string };
  /** `historyToJSON` output, parsed. */
  history: unknown;
}

export function loadHistoryFixtures(dir = HISTORY_FIXTURE_DIR): Array<HistoryFixture & { file: string }> {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ...(JSON.parse(readFileSync(`${dir}${file}`, "utf8")) as HistoryFixture) }));
}
