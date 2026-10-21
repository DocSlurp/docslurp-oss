import { ProtocolError } from "@modelcontextprotocol/server";
import { Challenge, Credential, Mcp, Receipt } from "mppx";

/**
 * MPP's MCP transport binding (draft-payment-transport-mcp-00) over the HTTP
 * adapter routes. Paid adapter routes speak MPP over HTTP (402 with
 * `WWW-Authenticate: Payment`, credential in `Payment-Authorization`, receipt
 * in `Payment-Receipt`); this maps each piece to its JSON-RPC form so REST and
 * MCP clients pay through the same handler.
 */

const PROBLEM_PREFIX = "https://paymentauth.org/problems/";

export interface PaymentCredentialHeader {
  header: string;
  challengeId: string;
}

/** `_meta["org.paymentauth/credential"]` as a `Payment-Authorization` value; null when it does not parse. */
export function paymentCredentialHeader(value: unknown): PaymentCredentialHeader | null {
  if (!value || typeof value !== "object" || !("challenge" in value) || !("payload" in value)) return null;
  try {
    const header = Credential.serialize(value as Credential.Credential);
    return { header, challengeId: Credential.deserialize(header).challenge.id };
  } catch {
    return null;
  }
}

/** The JSON-RPC code MPP assigns a problem type (mirrors mppx's own MCP transport). */
function problemCode(type: string): number {
  switch (type.slice(PROBLEM_PREFIX.length)) {
    case "payment-required": return Mcp.paymentRequiredCode;
    case "malformed-credential":
    case "invalid-payload": return Mcp.invalidParamsCode;
    case "internal-payment-error": return Mcp.internalErrorCode;
    default: return Mcp.paymentVerificationFailedCode;
  }
}

/**
 * A payment challenge or refusal from an adapter route as the protocol error
 * MPP clients expect, or null for an ordinary response. A 402 carries the
 * challenges to pay; a 403 problem means a valid payment that cannot pay for
 * this call, so it offers none and clients must not pay again.
 */
export async function paymentProtocolError(response: Response): Promise<ProtocolError | null> {
  const isProblem = /^application\/problem\+json/i.test(response.headers.get("Content-Type") ?? "");
  const problem = isProblem ? await response.clone().json().catch(() => null) as { type?: unknown; title?: unknown; detail?: unknown } | null : null;
  const paymentProblem = typeof problem?.type === "string" && problem.type.startsWith(PROBLEM_PREFIX) ? problem as { type: string; title?: unknown; detail?: unknown } : null;
  if (response.status === 402 && /\bPayment\b/i.test(response.headers.get("WWW-Authenticate") ?? "")) {
    const challenges = Challenge.fromResponseList(response);
    return new ProtocolError(paymentProblem ? problemCode(paymentProblem.type) : Mcp.paymentRequiredCode,
      typeof paymentProblem?.title === "string" ? paymentProblem.title : "Payment Required",
      { httpStatus: 402, challenges, ...(paymentProblem && { problem: paymentProblem }) });
  }
  if (response.status === 403 && paymentProblem) {
    return new ProtocolError(problemCode(paymentProblem.type), typeof paymentProblem.title === "string" ? paymentProblem.title : "Payment refused",
      { httpStatus: 403, challenges: [], problem: paymentProblem });
  }
  return null;
}

/** `Payment-Receipt` as the `_meta["org.paymentauth/receipt"]` entry for a tool result. */
export function paymentReceiptMeta(response: Response, challengeId: string | undefined): Record<string, unknown> | null {
  if (!challengeId || !response.headers.has("Payment-Receipt")) return null;
  return { [Mcp.receiptMetaKey]: { ...Receipt.fromResponse(response), challengeId } };
}

export const paymentCredentialMetaKey = Mcp.credentialMetaKey;
