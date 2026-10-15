import { describe, it, expect, vi } from "vitest";
const emit = vi.hoisted(() => vi.fn());
const recordException = vi.hoisted(() => vi.fn());
vi.mock("@opentelemetry/api-logs", () => ({ logs: { getLogger: () => ({ emit }) } }));
vi.mock("@opentelemetry/api", () => ({ trace: { getActiveSpan: () => ({ recordException, setStatus: vi.fn() }) }, SpanStatusCode: { ERROR: 2 } }));
import { exceptionDetails, reportException } from "../error-reporting.js";

describe("exception reporting", () => {
  it("retains real nested causes and stacks in OTLP with credentials removed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("insufficient credits; api_key=secret-value Bearer secret-token");
    const error = new Error("Provider unavailable", { cause });
    reportException(error, { requestId: "request-123", runId: "run-456" });
    const event = emit.mock.calls.at(-1)![0];
    expect(event.attributes).toMatchObject({ requestId: "request-123", runId: "run-456", "exception.type": "Error", "exception.message": "Provider unavailable" });
    expect(event.attributes["exception.causes"]).toContain("insufficient credits");
    expect(event.attributes["exception.stacktrace"]).toContain("error-reporting.test.ts");
    expect(JSON.stringify(event)).not.toMatch(/secret-value|secret-token/);
    expect(recordException).toHaveBeenCalled();
    expect(cause.message).toContain("secret-value");
    vi.restoreAllMocks();
  });
  it("bounds cycles and handles non-Error throws", () => {
    const error = new Error("cycle"); error.cause = error;
    expect(JSON.stringify(exceptionDetails(error))).toContain("depth limit");
    expect(exceptionDetails("failure")).toEqual({ message: "failure" });
  });
  it("does not throw when telemetry fails", () => {
    emit.mockImplementationOnce(() => { throw new Error("exporter down"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportException(new Error("original"))).not.toThrow();
    vi.restoreAllMocks();
  });
});
