import { describe, expect, it } from "vitest";
import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";

import { findWebhookEvent } from "../lib/webhook-events.js";

/** Catalog examples are documentation and test-delivery payloads: they must look like what the worker outbox sends. */
const OUTBOX_RUN_FIELDS = ["deliveredAt", "error", "event", "failedDocuments", "pagesProcessed", "processedDocuments", "runId", "stage", "status", "projectId"];

describe("webhook event catalog", () => {
  it.each(["run.completed", "run.failed"])("%s example has the outbox's fields, no cost, and only public error copy", (type) => {
    const example = findWebhookEvent(type)!.examplePayload;
    expect(Object.keys(example).sort()).toEqual(OUTBOX_RUN_FIELDS);
    expect(example).not.toHaveProperty("costCents");
    expect(example.error === null || (Object.values(PUBLIC_ERROR_MESSAGES) as string[]).includes(example.error as string)).toBe(true);
  });
});
