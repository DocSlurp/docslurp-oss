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
  missingServingCapabilities,
  workspaceIngestVersion,
} from "../ingest-version.js";
import { PARSE_SOURCE_SCAN_VERSION } from "../parse-source-decision.js";

/**
 * Every capability name ever shipped, in order. Append only: a name is never removed, renamed, reordered or reused, since
 * stored rows and clients keep it. To add a capability, append it here and to INGEST_CAPABILITIES.
 */
const SHIPPED_CAPABILITIES = ["parseSourceDecision", "pageFacts", "figureLedger"];

describe("ingest version", () => {
  it("is a positive integer and the workspace reports it with every capability", () => {
    expect(Number.isInteger(CURRENT_INGEST_VERSION) && CURRENT_INGEST_VERSION > 0).toBe(true);
    expect(workspaceIngestVersion()).toEqual({ ingestVersion: CURRENT_INGEST_VERSION, capabilities: [...INGEST_CAPABILITIES] });
  });

  it("treats version 0 as unknown: an update is available and no capability is claimed", () => {
    expect(ingestStatus({ ingestVersion: 0, ingestCapabilities: ["parseSourceDecision"] })).toEqual({
      version: 0, capabilities: [], currentVersion: CURRENT_INGEST_VERSION, updateAvailable: true,
      missingCapabilities: [], updateRecommended: false,
    });
    expect(ingestStatus({})).toMatchObject({ version: 0, updateAvailable: true });
    expect(ingestStatus({ ingestVersion: -3 })).toMatchObject({ version: 0 });
  });

  it("reports a current document as up to date and drops unknown capability names", () => {
    expect(ingestStatus({ ingestVersion: CURRENT_INGEST_VERSION, ingestCapabilities: ["pageFacts", "secretFlag", "pageFacts", 7] })).toEqual({
      version: CURRENT_INGEST_VERSION, capabilities: ["pageFacts"], currentVersion: CURRENT_INGEST_VERSION, updateAvailable: false,
      missingCapabilities: [], updateRecommended: false,
    });
  });

  it("maps row columns only when selected", () => {
    expect(ingestRecordFields({})).toEqual({});
    expect(ingestRecordFields({ ingest_version: 0, ingest_capabilities: [] })).toEqual({ ingestVersion: 0, ingestCapabilities: [] });
    expect(ingestRecordFields({ ingest_version: 1, ingest_capabilities: ["figureLedger"] })).toEqual({ ingestVersion: 1, ingestCapabilities: ["figureLedger"] });
  });
});

describe("capability list", () => {
  it("is append-only: every shipped name stays, in place", () => {
    expect(INGEST_CAPABILITIES.slice(0, SHIPPED_CAPABILITIES.length)).toEqual(SHIPPED_CAPABILITIES);
    expect(INGEST_CAPABILITIES.length).toBe(SHIPPED_CAPABILITIES.length);
    expect(new Set(INGEST_CAPABILITIES).size).toBe(INGEST_CAPABILITIES.length);
  });
});

describe("update recommended (badge) is measured, not version-based", () => {
  const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  const decided = { parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION, parse_source_sha256: "a".repeat(64), parse_source_key: null, source_sha256: null };
  const unscanned = { parse_source_scan_version: null, parse_source_sha256: null, parse_source_key: null, source_sha256: null };
  it("a version-0 document that serving can still read is not badged", () => {
    const missing = missingServingCapabilities({ ...decided, mime_type: "application/pdf", status: "completed" }, env);
    expect(missing).toEqual([]);
    expect(ingestStatus({ ingestVersion: 0 }, missing)).toMatchObject({ updateAvailable: true, updateRecommended: false });
  });
  it("a PDF or deferred-indexed document without a current parse decision is", () => {
    expect(missingServingCapabilities({ ...unscanned, mime_type: "application/pdf", status: "completed" }, env)).toEqual(["parseSourceDecision"]);
    expect(missingServingCapabilities({ ...unscanned, mime_type: "text/html", indexing_mode: "map", status: "completed" }, env)).toEqual(["parseSourceDecision"]);
    expect(ingestStatus({ ingestVersion: 0 }, ["parseSourceDecision"])).toMatchObject({ missingCapabilities: ["parseSourceDecision"], updateRecommended: true });
  });
  it("other documents, unfinished ones, and installs without quarantine are not", () => {
    expect(missingServingCapabilities({ ...unscanned, mime_type: "text/plain", indexing_mode: "full", status: "completed" }, env)).toEqual([]);
    expect(missingServingCapabilities({ ...unscanned, mime_type: "application/pdf", status: "embed" }, env)).toEqual([]);
    expect(missingServingCapabilities({ ...unscanned, mime_type: "application/pdf", status: "completed" }, { QUARANTINE_ENABLED: "false" } as NodeJS.ProcessEnv)).toEqual([]);
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
