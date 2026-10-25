import { describe, it, expect, vi } from "vitest";
const emit = vi.hoisted(() => vi.fn());
const recordException = vi.hoisted(() => vi.fn());
const setStatus = vi.hoisted(() => vi.fn());
const setAttribute = vi.hoisted(() => vi.fn());
vi.mock("@opentelemetry/api-logs", () => ({ logs: { getLogger: () => ({ emit }) } }));
vi.mock("@opentelemetry/api", () => ({ trace: { getActiveSpan: () => ({ recordException, setStatus, setAttribute }) }, SpanStatusCode: { ERROR: 2 } }));
import { exceptionDetails, isCancellation, reportException } from "../error-reporting.js";

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
  describe("caller cancellation", () => {
    const abort = () => new DOMException("This operation was aborted", "AbortError");

    it("classifies aborts, including wrapped ones, but never timeouts", () => {
      expect(isCancellation(abort())).toBe(true);
      expect(isCancellation(new Error("wrapped", { cause: abort() }))).toBe(true);
      expect(isCancellation(new DOMException("timed out", "TimeoutError"))).toBe(false);
      const deadline = new Error("deadline", { cause: abort() });
      deadline.name = "ChatTurnDeadlineError";
      expect(isCancellation(deadline)).toBe(false);
      expect(isCancellation(new Error("boom"))).toBe(false);
      expect(isCancellation("This operation was aborted")).toBe(false);
    });

    it("treats the request signal's own abort reason as a cancel, even a bare string", () => {
      const controller = new AbortController();
      controller.abort("Client connection prematurely closed.");
      expect(isCancellation("Client connection prematurely closed.", controller.signal)).toBe(true);
      expect(isCancellation("Client connection prematurely closed.")).toBe(false);
      expect(isCancellation("something else", controller.signal)).toBe(false);
      const live = new AbortController();
      expect(isCancellation(live.signal.reason, live.signal)).toBe(false);
      const timedOut = new AbortController();
      const timeout = new DOMException("timed out", "TimeoutError");
      timedOut.abort(timeout);
      expect(isCancellation(timeout, timedOut.signal)).toBe(false);
    });

    it("reports a cancel as an INFO outcome without an ERROR status or exception", () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      emit.mockClear(); recordException.mockClear(); setStatus.mockClear(); setAttribute.mockClear();
      reportException(abort(), { operation: "chat-completions-stream" });
      const event = emit.mock.calls.at(-1)![0];
      expect(event).toMatchObject({ severityText: "INFO", severityNumber: 9, body: "public_operation_cancelled" });
      expect(event.attributes).toMatchObject({ operation: "chat-completions-stream", "docslurp.outcome": "cancelled" });
      expect(setAttribute).toHaveBeenCalledWith("docslurp.outcome", "cancelled");
      expect(recordException).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("keeps real failures at ERROR", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      emit.mockClear(); setStatus.mockClear();
      reportException(new Error("provider exploded"));
      expect(emit.mock.calls.at(-1)![0]).toMatchObject({ severityText: "ERROR", body: "public_operation_failed" });
      expect(setStatus).toHaveBeenCalledWith({ code: 2 });
      vi.restoreAllMocks();
    });
  });
});
