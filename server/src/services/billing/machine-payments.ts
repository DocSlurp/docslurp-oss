import crypto from "node:crypto";

import { Receipt } from "mppx";
import { Mppx, stripe as stripeMethods } from "mppx/server";

import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from "@docslurp/shared";
import { env } from "../../config.js";
import { sql, type SqlClient } from "../../db.js";
import { grantOrgCredits } from "./credits.js";
import { postgresMachinePaymentStore } from "./machine-payment-store.js";
import { stripeMode } from "./metering.js";
import { getStripe, isStripeConfigured } from "./stripe-client.js";

/**
 * Agent-paid credit top-ups over MPP (the Machine Payments Protocol, co-authored
 * by Stripe and Tempo; https://docs.stripe.com/payments/machine/mpp). The
 * caller is already authenticated: payment only funds its organization's
 * prepaid pool, at the same 1 credit per cent as a Checkout top-up.
 *
 * Fiat arrives as a Stripe Shared Payment Token (cards and Link, issued by an
 * agent wallet such as Link Agents); stablecoins arrive as USDC on Tempo,
 * settled to a Stripe crypto deposit address. Both land in the Stripe balance
 * as PaymentIntents.
 */

/** Stripe PaymentIntent metadata `purpose` for these grants. */
export const AGENT_TOPUP_PURPOSE = "agent_credit_topup";

/** The MPP methods advertised to MCP clients: SPT is the `stripe` method. */
export type MachinePaymentMethod = "stripe" | "tempo";

export interface MachinePaymentsConfig {
  profileId: string;
  secretKey: string;
  tempoDepositAddress: string | null;
}

export function machinePaymentsConfig(env: NodeJS.ProcessEnv = process.env): MachinePaymentsConfig | null {
  const profileId = env.STRIPE_PROFILE_ID?.trim();
  const stripeKey = env.STRIPE_SECRET_KEY?.trim();
  if (env.MACHINE_PAYMENTS_ENABLED !== "true" || !profileId || !stripeKey) return null;
  return {
    profileId,
    // Challenge IDs are HMAC-bound; derive the key from the Stripe secret unless set (Stripe's own recipe).
    secretKey: env.MPP_SECRET_KEY?.trim()
      || crypto.createHmac("sha256", stripeKey).update("mpp-challenge-signing").digest("base64"),
    tempoDepositAddress: env.MPP_TEMPO_DEPOSIT_ADDRESS?.trim() || null,
  };
}

export function machinePaymentsEnabled(): boolean {
  return isStripeConfigured() && machinePaymentsConfig() !== null;
}

export function machinePaymentMethods(): MachinePaymentMethod[] {
  return machinePaymentsConfig()?.tempoDepositAddress ? ["tempo", "stripe"] : ["stripe"];
}

function createMppx(config: MachinePaymentsConfig) {
  const methods = stripeMethods.create({
    client: getStripe(),
    networkId: config.profileId,
    livemode: stripeMode() === "live",
    store: postgresMachinePaymentStore(),
    ...(config.tempoDepositAddress && { depositAddresses: { tempo: config.tempoDepositAddress } }),
  }).defaultMethods(config.tempoDepositAddress ? undefined : { exclude: ["tempo"] });
  // Payment-Authorization keeps Authorization free for the caller's API key. A fixed
  // realm keeps challenges identical over REST and the in-process MCP dispatcher.
  return Mppx.create({ methods, secretKey: config.secretKey, requiresAuth: true, realm: new URL(env.apiUrl).host });
}

let cached: { fingerprint: string; mppx: ReturnType<typeof createMppx> } | null = null;

function mppxFor(config: MachinePaymentsConfig) {
  const fingerprint = JSON.stringify([config, process.env.STRIPE_SECRET_KEY]);
  if (cached?.fingerprint !== fingerprint) cached = { fingerprint, mppx: createMppx(config) };
  return cached.mppx;
}

export class MachinePaymentsUnavailableError extends Error {
  constructor() {
    super("Agent payments are not enabled on this server");
    this.name = "MachinePaymentsUnavailableError";
  }
}

export function validAgentTopUpCents(amountCents: number): boolean {
  return Number.isInteger(amountCents) && amountCents >= MIN_TOPUP_CENTS && amountCents <= MAX_TOPUP_CENTS;
}

export interface AgentTopUpGrant {
  credits: number;
  amountCents: number;
  /** False when this payment was already granted (a retried call). */
  granted: boolean;
  method: string;
  /** PaymentIntent ID for cards, transaction hash for stablecoins. */
  reference: string;
}

export type AgentTopUpOutcome =
  | { status: 402; challenge: Response }
  | { status: 200; grant: AgentTopUpGrant; withReceipt: (response: Response) => Response };

/**
 * One MPP charge per call. Without a `Payment-Authorization` credential this
 * returns the 402 challenge; with a verified one it grants the credits once
 * per payment (keyed by the Stripe/on-chain reference, so a retried credential
 * never grants twice) and returns a receipt wrapper for the response.
 */
export async function chargeAgentTopUp(args: {
  request: Request;
  orgId: string;
  userId: string;
  amountCents: number;
  client?: SqlClient;
}): Promise<AgentTopUpOutcome> {
  const config = machinePaymentsConfig();
  if (!config || !isStripeConfigured()) throw new MachinePaymentsUnavailableError();
  const credits = args.amountCents;
  const result = await mppxFor(config).charge({
    amount: (args.amountCents / 100).toFixed(2),
    description: `${credits.toLocaleString("en-US")} DocSlurp credits (1 credit = $0.01)`,
    // Bound into the HMAC'd challenge: a credential for one org or amount cannot pay another.
    meta: { orgId: args.orgId, credits: String(credits) },
    scope: "docslurp:buyCredits",
    paymentIntentOptions: { metadata: { orgId: args.orgId, purpose: AGENT_TOPUP_PURPOSE, credits: String(credits) } },
  })(args.request);
  if (result.status === 402) return { status: 402, challenge: result.challenge };

  const receipt = Receipt.fromResponse(result.withReceipt(new Response(null)));
  const isPaymentIntent = receipt.reference.startsWith("pi_");
  const granted = await grantOrgCredits(args.client ?? sql, {
    orgId: args.orgId,
    source: "topup",
    externalId: receipt.reference,
    pool: "prepaid",
    credits,
    userId: args.userId,
    metadata: {
      rail: "mpp",
      method: receipt.method,
      amountCents: args.amountCents,
      ...(isPaymentIntent ? { paymentIntentId: receipt.reference } : { transactionHash: receipt.reference }),
    },
  });
  console.log(
    `[billing] ${granted ? "grant" : "duplicate-grant"} source=topup rail=mpp method=${receipt.method} orgId=${args.orgId} credits=${credits} reference=${receipt.reference}`,
  );
  return {
    status: 200,
    grant: { credits, amountCents: args.amountCents, granted, method: receipt.method, reference: receipt.reference },
    withReceipt: (response) => result.withReceipt(response),
  };
}
