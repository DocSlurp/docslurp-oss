import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * The chat turn a piece of work belongs to. Every Usage Event written while a
 * turn is current (agent steps, nested tool searches and grounded answers,
 * query embeddings) is stamped `metadata.chatTurnId`, so the turn's spend can
 * be voided when its answer is never delivered (services/billing/chat-turn-billing.ts).
 *
 * The context is process-local on purpose: every event of a turn is written by
 * the process serving it, so the turn can wait for its own in-flight writes
 * before it settles the bill.
 */
export type ChatTurnStatus = "open" | "delivered" | "failed";

export interface ChatTurnEventRecord {
  /** The Usage Event's id: the refund voids exactly these rows (by primary key). */
  id: string;
  /** Customer credits the event debited (0 when non-billable). */
  creditCents: number;
  /** Credits a late event of a failed turn would have billed but did not. */
  waivedCreditCents: number;
  /** What the provider charged us, recorded for our own accounting. */
  providerCostCents: number;
}

export interface ChatTurnContext {
  readonly id: string;
  status: ChatTurnStatus;
  /** Whether events written after a failure are non-billable (CHAT_REFUND_UNDELIVERED_TURNS). */
  refundOnFailure: boolean;
  /** Usage writes still in flight; a failing turn waits for them before refunding. */
  readonly inflight: Set<Promise<unknown>>;
  /** Every Usage Event this process wrote for the turn. */
  readonly events: ChatTurnEventRecord[];
  /** Whether a chat answer already took the turn id as its response id (nested answers get their own). */
  answerIdClaimed: boolean;
}

const chatTurnStorage = new AsyncLocalStorage<ChatTurnContext>();

export function createChatTurnContext(options: { id?: string; refundOnFailure: boolean }): ChatTurnContext {
  return {
    id: options.id ?? randomUUID(),
    status: "open",
    refundOnFailure: options.refundOnFailure,
    inflight: new Set(),
    events: [],
    answerIdClaimed: false,
  };
}

export function runInChatTurnContext<T>(turn: ChatTurnContext, run: () => T): T {
  return chatTurnStorage.run(turn, run);
}

export function currentChatTurn(): ChatTurnContext | null {
  return chatTurnStorage.getStore() ?? null;
}

/** Track a usage write so a failing turn can wait for it. */
export function trackChatTurnWrite<T>(turn: ChatTurnContext, write: Promise<T>): Promise<T> {
  turn.inflight.add(write);
  const settle = () => { turn.inflight.delete(write); };
  write.then(settle, settle);
  return write;
}

/**
 * Track work that writes Usage Events inside its own transaction (a Search
 * Session's journal flush): the rows are only visible to the refund once that
 * transaction commits, so the turn must wait for the whole write, not just the
 * insert statement. No-op outside a chat turn.
 */
export function trackCurrentChatTurnWrite<T>(write: Promise<T>): Promise<T> {
  const turn = currentChatTurn();
  return turn ? trackChatTurnWrite(turn, write) : write;
}

/**
 * The response id for a chat answer produced in the current turn: the turn id
 * for the first answer (the turn's own), a fresh id for any nested answer (a
 * grounded MCP chat call inside the agent's tools), so two answers never share
 * an id. Null outside a chat turn.
 */
export function claimChatTurnAnswerId(): string | null {
  const turn = currentChatTurn();
  if (!turn) return null;
  if (turn.answerIdClaimed) return randomUUID();
  turn.answerIdClaimed = true;
  return turn.id;
}

/** Resolves once every usage write started for the turn so far has settled. */
export async function settleChatTurnWrites(turn: ChatTurnContext): Promise<void> {
  while (turn.inflight.size > 0) {
    await Promise.allSettled([...turn.inflight]);
  }
}
