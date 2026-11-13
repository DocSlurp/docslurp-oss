import { describe, expect, it } from "vitest";
import {
  CURRENT_INGEST_VERSION,
  DATA_UNAVAILABLE_MESSAGES,
  DATA_UNAVAILABLE_REASONS,
  INGEST_CAPABILITIES,
  dataUnavailable,
  dataUnavailableSchema,
  figureResumeUnavailableReason,
  ingestRecordFields,
  ingestStatus,
  isDataUnavailable,
  workspaceIngestVersion,
} from "../ingest-version.js";

describe("ingest version", () => {
  it("is a positive integer and the workspace reports it with every capability", () => {
    expect(Number.isInteger(CURRENT_INGEST_VERSION) && CURRENT_INGEST_VERSION > 0).toBe(true);
    expect(workspaceIngestVersion()).toEqual({ ingestVersion: CURRENT_INGEST_VERSION, capabilities: [...INGEST_CAPABILITIES] });
  });

  it("treats version 0 as unknown: an update is available and no capability is claimed", () => {
    expect(ingestStatus({ ingestVersion: 0, ingestCapabilities: ["parseSourceDecision"] })).toEqual({
      version: 0, capabilities: [], currentVersion: CURRENT_INGEST_VERSION, updateAvailable: true,
    });
    expect(ingestStatus({})).toMatchObject({ version: 0, updateAvailable: true });
    expect(ingestStatus({ ingestVersion: -3 })).toMatchObject({ version: 0 });
  });

  it("reports a current document as up to date and drops unknown capability names", () => {
    expect(ingestStatus({ ingestVersion: CURRENT_INGEST_VERSION, ingestCapabilities: ["pageFacts", "secretFlag", "pageFacts", 7] })).toEqual({
      version: CURRENT_INGEST_VERSION, capabilities: ["pageFacts"], currentVersion: CURRENT_INGEST_VERSION, updateAvailable: false,
    });
  });

  it("maps row columns only when selected", () => {
    expect(ingestRecordFields({})).toEqual({});
    expect(ingestRecordFields({ ingest_version: 0, ingest_capabilities: [] })).toEqual({ ingestVersion: 0, ingestCapabilities: [] });
    expect(ingestRecordFields({ ingest_version: 1, ingest_capabilities: ["figureLedger"] })).toEqual({ ingestVersion: 1, ingestCapabilities: ["figureLedger"] });
  });
});

describe("typed unavailable states", () => {
  it("has reviewed copy for every reason, with no error wording", () => {
    for (const reason of DATA_UNAVAILABLE_REASONS) {
      const message = DATA_UNAVAILABLE_MESSAGES[reason];
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/error|fail|denied|forbidden|exception/i);
    }
  });

  it("offers a reprocess only for reasons a reprocess fixes, and only to a caller who may start one", () => {
    expect(dataUnavailable("needs-reprocess", { canEdit: true, ingestVersion: 0 })).toEqual({
      status: "unavailable", reason: "needs-reprocess", message: DATA_UNAVAILABLE_MESSAGES["needs-reprocess"], canReprocess: true,
      ingestVersion: 0, currentIngestVersion: CURRENT_INGEST_VERSION,
    });
    expect(dataUnavailable("needs-reprocess", { canEdit: false }).canReprocess).toBe(false);
    expect(dataUnavailable("needs-reprocess").canReprocess).toBe(false);
    for (const reason of ["withheld", "processing", "not-supported", "disabled", "temporarily-unavailable"] as const) {
      expect(dataUnavailable(reason, { canEdit: true }).canReprocess).toBe(false);
    }
    expect(dataUnavailable("not-extracted", { canEdit: true }).canReprocess).toBe(true);
  });

  it("validates with its schema and rejects anything else", () => {
    expect(dataUnavailableSchema.parse(dataUnavailable("withheld"))).toMatchObject({ reason: "withheld", ingestVersion: null });
    expect(isDataUnavailable({ status: "unavailable", reason: "boom", message: "x", canReprocess: false, ingestVersion: null, currentIngestVersion: 1 })).toBe(false);
    expect(isDataUnavailable({ error: { code: "quarantine_rescan_required" } })).toBe(false);
  });

  it("maps the figure runner's blocked reasons", () => {
    expect(figureResumeUnavailableReason(null)).toBeNull();
    expect(figureResumeUnavailableReason("unscanned")).toBe("needs-reprocess");
    expect(figureResumeUnavailableReason("figures-off")).toBe("disabled");
    expect(figureResumeUnavailableReason("resume-off")).toBe("disabled");
    expect(figureResumeUnavailableReason("attempts")).toBe("not-extracted");
    expect(figureResumeUnavailableReason("stale")).toBe("processing");
    expect(figureResumeUnavailableReason("something-new")).toBe("not-extracted");
  });
});
