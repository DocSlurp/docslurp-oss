import { randomUUID } from "node:crypto";

import { sql } from "../db.js";

export type ChatFeedbackRating = "up" | "down";

export interface UpsertChatFeedbackInput {
  workspaceId: string;
  userId: string;
  messageId: string;
  rating: ChatFeedbackRating;
  /** `undefined` keeps any existing value; `null` clears it. */
  threadId?: string | null;
  comment?: string | null;
  question?: string | null;
  answer?: string | null;
  model?: string | null;
}

export interface ChatFeedbackRecord {
  id: string;
  messageId: string;
  rating: ChatFeedbackRating;
  comment: string | null;
  updatedAt: string;
}

interface ChatFeedbackRow {
  id: string;
  message_id: string;
  rating: ChatFeedbackRating;
  comment: string | null;
  updated_at: Date | string;
}

function toRecord(row: ChatFeedbackRow): ChatFeedbackRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    rating: row.rating,
    comment: row.comment,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

/**
 * Upserts one user's rating for one assistant message. Optional fields that are
 * `undefined` keep their stored value on update, so a rating-only resend never
 * erases a previously written comment.
 */
export async function upsertChatFeedback(input: UpsertChatFeedbackInput): Promise<ChatFeedbackRecord> {
  const keep = (value: string | null | undefined) => value === undefined;
  const value = (v: string | null | undefined) => v ?? null;

  const [row] = await sql<ChatFeedbackRow[]>`
    INSERT INTO chat_message_feedback (
      id, workspace_id, user_id, thread_id, message_id, rating, comment, question, answer, model
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.userId}, ${value(input.threadId)},
      ${input.messageId}, ${input.rating}, ${value(input.comment)}, ${value(input.question)},
      ${value(input.answer)}, ${value(input.model)}
    )
    ON CONFLICT (user_id, workspace_id, message_id) DO UPDATE SET
      rating = EXCLUDED.rating,
      thread_id = CASE WHEN ${keep(input.threadId)} THEN chat_message_feedback.thread_id ELSE EXCLUDED.thread_id END,
      comment = CASE WHEN ${keep(input.comment)} THEN chat_message_feedback.comment ELSE EXCLUDED.comment END,
      question = CASE WHEN ${keep(input.question)} THEN chat_message_feedback.question ELSE EXCLUDED.question END,
      answer = CASE WHEN ${keep(input.answer)} THEN chat_message_feedback.answer ELSE EXCLUDED.answer END,
      model = CASE WHEN ${keep(input.model)} THEN chat_message_feedback.model ELSE EXCLUDED.model END,
      updated_at = now()
    RETURNING id, message_id, rating, comment, updated_at
  `;

  if (!row) {
    throw new Error("Failed to persist chat feedback");
  }

  console.log(
    `[chat-feedback] write rating=${input.rating} workspaceId=${input.workspaceId} messageId=${input.messageId} hasComment=${row.comment !== null}`,
  );

  return toRecord(row);
}

/** Removes one user's rating for a message. Idempotent. */
export async function deleteChatFeedback(args: {
  workspaceId: string;
  userId: string;
  messageId: string;
}): Promise<void> {
  await sql`
    DELETE FROM chat_message_feedback
    WHERE user_id = ${args.userId}
      AND workspace_id = ${args.workspaceId}
      AND message_id = ${args.messageId}
  `;
}
