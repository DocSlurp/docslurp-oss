import { speedBoostMultiplier } from "@docslurp/shared";
import { createHash } from "node:crypto";
import { sql, type SqlClient } from "../../db.js";
import { voidChatTurnUsage } from "../../lib/ai-usage.js";
import {
  createChatTurnContext,
  currentChatTurn,
  runInChatTurnContext,
  settleChatTurnWrites,
  type ChatTurnContext,
  type ChatTurnStatus,
} from "../../lib/chat-turn-context.js";
import { cancelPendingChatTurnDebits, grantOrgCredits } from "./credits.js";

/**
 * Chat turn billing: a turn that fails on our side (an error or a server
 * timeout before the answer is produced) costs the customer no credits. Its
 * Usage Events keep their provider cost for our own accounting.
 *
 * A turn the client abandons (it disconnects or aborts) stays charged, before
 * or after the answer was generated: the provider work was done on the
 * client's behalf, and refunding it would let a client get answers, or burn
 * provider spend, for free by disconnecting at the right moment (the answer
 * may already have streamed, and it is persisted to the chat session).
 *
 * Every Usage Event written inside a turn carries `metadata.chatTurnId`
 * (lib/chat-turn-context.ts, stamped by lib/ai-usage.ts), and so does the
 * pending credit debit it enqueues. Failing a turn
 *  1. marks it failed, so events written afterwards bill nothing;
 *  2. waits for the turn's in-flight usage writes;
 *  3. in one transaction voids the credits of the turn's billed events (by
 *     their ids), cancels their debits that are still pending (under the org
 *     lock the flusher takes), and grants back the part that was already
 *     flushed as one `refund` grant per org (never funds the org), external id
 *     `chat-turn-refund:<turnId>:<orgId>:<hash of the voided event ids>`.
 * Voided events never match again, and a grant that collides with an earlier
 * one rolls the whole refund back, so a turn is refunded at most once however
 * often, or wherever, it is failed.
 *
 * CHAT_REFUND_UNDELIVERED_TURNS=false keeps every turn charged.
 */

/** The failure reason of a turn the client abandoned: charged, never refunded. */
export const CLIENT_ABORTED = "client_aborted";

/**
 * Why a turn produced no answer, recorded on its refund. `clientSignal` is
 * the client's request signal: when it fired, the client left
 * (`client_aborted`, charged). An abort or timeout the server raised itself
 * (agent deadline, provider timeout) is ours and refundable.
 */
export function chatTurnFailureReason(error: unknown, clientSignal?: AbortSignal): string {
  if (clientSignal?.aborted) return CLIENT_ABORTED;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  // The agent turn deadline (#91) is a server-side timeout: refundable, recorded as one.
  if (error instanceof Error && (error as { code?: unknown }).code === "chat_deadline_exceeded") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "error";
}

export function chatTurnRefundsEnabled(): boolean {
  const value = process.env.CHAT_REFUND_UNDELIVERED_TURNS?.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value ?? "");
}

/** What a turn cost, reported to clients (error bodies included). */
export interface ChatTurnUsage {
  turnId: string;
  outcome: ChatTurnStatus;
  /** What providers charged for the turn's model and tool calls, in cents. */
  providerCostCents: number;
  /** Credits the turn's answer and usage are worth at the price card, before any refund. */
  creditCents: number;
  /** Credits returned or never billed because the answer was not delivered. */
  refundedCreditCents: number;
  /** Credits the customer pays for the turn (credits − refunded). */
  chargedCreditCents: number;
  /** The turn failed and its credits were waived (false when CHAT_REFUND_UNDELIVERED_TURNS=false). */
  refunded: boolean;
}

export interface ChatTurnRefund {
  turnId: string;
  /** Credits voided on the turn's Usage Events (cancelled pending + granted back). */
  credits: number;
  /** Part of `credits` whose debits were still pending and were cancelled. */
  pendingCancelledCredits: number;
  /** Part of `credits` already applied by a flush and granted back. */
  grantedCredits: number;
}

export interface ChatTurn {
  readonly id: string;
  /**
   * False when this handle joined a turn started by an outer caller (a nested
   * grounded chat inside the agent's tools). Only the owner settles the turn;
   * `delivered` and `failed` on a joined handle report usage and change nothing.
   */
  readonly owned: boolean;
  /** Run work inside the turn: its Usage Events are stamped with the turn id. */
  run<T>(work: () => T): T;
  /** The answer reached the client: the turn is charged. */
  delivered(): ChatTurnUsage;
  /**
   * The answer did not reach the client: refund it (once) unless refunds are
   * off or the client abandoned the turn (`client_aborted`).
   */
  failed(reason: string): Promise<ChatTurnUsage>;
  usage(): ChatTurnUsage;
}

const failures = new WeakMap<ChatTurnContext, Promise<ChatTurnUsage>>();
const refunds = new WeakMap<ChatTurnContext, number>();

/**
 * Start a chat turn, or join the current one. `id` becomes the turn id (the
 * chat response id); omit it for a fresh UUID.
 */
export function beginChatTurn(options: { id?: string; speedBoost?: boolean } = {}): ChatTurn {
  speedBoostMultiplier(options.speedBoost);
  const current = currentChatTurn();
  if (current) {
    if (options.speedBoost !== undefined && options.speedBoost !== current.speedBoost) {
      throw new Error("Nested chat cannot change the outer speedBoost choice");
    }
    return handle(current, false);
  }
  return handle(createChatTurnContext({ id: options.id, speedBoost: options.speedBoost, refundOnFailure: chatTurnRefundsEnabled() }), true);
}

/** The turn the caller is running in, if any (joined, never owned). */
export function currentChatTurnHandle(): ChatTurn | null {
  const current = currentChatTurn();
  return current ? handle(current, false) : null;
}

function handle(turn: ChatTurnContext, owned: boolean): ChatTurn {
  return {
    id: turn.id,
    owned,
    run: (work) => (owned ? runInChatTurnContext(turn, work) : work()),
    delivered: () => {
      if (owned && turn.status === "open") turn.status = "delivered";
      return summarize(turn);
    },
    failed: async (reason) => (owned ? await failTurn(turn, reason) : summarize(turn)),
    usage: () => summarize(turn),
  };
}

async function failTurn(turn: ChatTurnContext, reason: string): Promise<ChatTurnUsage> {
  // A delivered answer stays charged; a second failure reuses the first.
  if (turn.status === "delivered") return summarize(turn);
  const existing = failures.get(turn);
  if (existing) return await existing;
  turn.status = "failed";
  // The client left: the turn stays charged, and so do steps finishing after it.
  if (reason === CLIENT_ABORTED) turn.refundOnFailure = false;
  const settled = (async () => {
    await settleChatTurnWrites(turn);
    // Every event of the turn is written by this process; with none billed
    // (a turn refused before it spent) there is nothing to refund.
    if (turn.refundOnFailure && !turn.events.some((event) => event.creditCents > 0)) {
      refunds.set(turn, 0);
    } else if (turn.refundOnFailure) {
      const refund = await refundChatTurn({ turnId: turn.id, eventIds: turn.events.map((event) => event.id), reason });
      refunds.set(turn, refund.credits);
    }
    return summarize(turn);
  })();
  failures.set(turn, settled);
  return await settled;
}

function summarize(turn: ChatTurnContext): ChatTurnUsage {
  const billed = turn.events.reduce((sum, event) => sum + event.creditCents, 0);
  const waived = turn.events.reduce((sum, event) => sum + event.waivedCreditCents, 0);
  const providerCostCents = turn.events.reduce((sum, event) => sum + event.providerCostCents, 0);
  const creditCents = billed + waived;
  const refundedCreditCents = Math.min(creditCents, waived + (refunds.get(turn) ?? 0));
  return {
    turnId: turn.id,
    outcome: turn.status,
    providerCostCents,
    creditCents,
    refundedCreditCents,
    chargedCreditCents: Math.max(0, creditCents - refundedCreditCents),
    refunded: turn.status === "failed" && turn.refundOnFailure && refunds.has(turn),
  };
}

/**
 * Refund one chat turn's credits, idempotently: `eventIds` are the Usage
 * Events the turn wrote (rows that do not carry the turn id are ignored).
 * Safe to call from any process once those writes have committed
 * (ChatTurn.failed waits for them); a repeated call refunds nothing.
 */
export async function refundChatTurn(
  args: { turnId: string; eventIds: readonly string[]; reason: string },
  client: SqlClient = sql,
): Promise<ChatTurnRefund> {
  return await client.begin(async (tx) => {
    const db = tx as unknown as SqlClient;
    const voided = await voidChatTurnUsage(db, { turnId: args.turnId, eventIds: args.eventIds, reason: args.reason });
    let credits = 0;
    let pendingCancelledCredits = 0;
    let grantedCredits = 0;
    for (const org of voided) {
      const pending = await cancelPendingChatTurnDebits(db, { orgId: org.orgId, turnId: args.turnId, usageEventIds: org.eventIds });
      const flushed = Math.max(0, org.credits - pending.credits);
      credits += org.credits;
      pendingCancelledCredits += pending.credits;
      if (flushed <= 0) continue;
      // A `refund` grant returns the credits without funding the org.
      const granted = await grantOrgCredits(db, {
        orgId: org.orgId,
        source: "refund",
        externalId: refundExternalId(args.turnId, org.orgId, org.eventIds),
        credits: flushed,
        metadata: {
          kind: "chat-turn-refund",
          chatTurnId: args.turnId,
          reason: args.reason,
          usageEvents: org.eventIds.length,
          pendingCancelledCredits: pending.credits,
        },
      });
      // The id is derived from events this transaction just voided, so it can
      // only exist already if something else refunded them: never void
      // without granting (the customer would pay for credits spend no longer shows).
      if (!granted) throw new Error(`chat turn refund ${args.turnId}: grant already exists for org ${org.orgId}`);
      grantedCredits += flushed;
    }
    return { turnId: args.turnId, credits, pendingCancelledCredits, grantedCredits };
  }) as ChatTurnRefund;
}

/** One grant per (turn, org, voided event set): a later refund of other events never collides. */
function refundExternalId(turnId: string, orgId: string, eventIds: readonly string[]): string {
  const events = createHash("sha256").update([...eventIds].sort().join(",")).digest("hex").slice(0, 16);
  return `chat-turn-refund:${turnId}:${orgId}:${events}`;
}
