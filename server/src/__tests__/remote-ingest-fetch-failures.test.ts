import { describe, expect, it } from "vitest";
import { UnsafeExternalUrlError } from "../lib/network-security.js";
import { classifyUrlFetchFailure } from "../services/remote-ingest.js";

const URL_TEXT = "https://files.example.com/grant/GRANTSECRET0123456789/report.pdf";

/** undici's shape: `TypeError: fetch failed`, the reason in `cause` (probed on Node 24). */
function fetchFailed(cause: Error & { code?: string }) {
  return new TypeError("fetch failed", { cause });
}
const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("URL fetch failures map to a fixed vocabulary", () => {
  it.each<[string, unknown, string]>([
    ["policy refusal", new UnsafeExternalUrlError("Only https URLs are allowed"), "blocked"],
    ["timeout signal", new DOMException(`The operation was aborted due to timeout fetching ${URL_TEXT}`, "TimeoutError"), "timeout"],
    ["connect timeout", fetchFailed(withCode(`Connect Timeout Error (attempted address: ${URL_TEXT})`, "UND_ERR_CONNECT_TIMEOUT")), "timeout"],
    ["DNS", fetchFailed(withCode(`getaddrinfo ENOTFOUND files.example.com`, "ENOTFOUND")), "dns"],
    ["pinned resolver", fetchFailed(new Error("Unable to resolve URL host")), "dns"],
    ["connection refused", fetchFailed(withCode("connect ECONNREFUSED 203.0.113.9:443", "ECONNREFUSED")), "refused"],
    ["connection reset", fetchFailed(withCode("read ECONNRESET", "ECONNRESET")), "refused"],
    ["certificate", fetchFailed(withCode(`Hostname/IP does not match certificate's altnames: Host: files.example.com`, "ERR_TLS_CERT_ALTNAME_INVALID")), "tls"],
    ["expired certificate", fetchFailed(withCode("certificate has expired", "CERT_HAS_EXPIRED")), "tls"],
    ["TLS record", fetchFailed(withCode("wrong version number", "ERR_SSL_WRONG_VERSION_NUMBER")), "tls"],
    ["refused redirect", fetchFailed(new Error("unexpected redirect")), "redirect"],
    ["anything else", fetchFailed(new Error(`socket hang up for ${URL_TEXT}`)), "unreachable"],
  ])("%s → %s", (_label, error, failure) => {
    const result = classifyUrlFetchFailure(error);
    expect(result.failure).toBe(failure);
    // Client copy and logged codes never carry the URL or its grant.
    expect(`${result.message} ${result.codes.join(",")}`).not.toMatch(/GRANTSECRET|files\.example\.com/);
  });
});
