-- Chat turn billing (server/src/services/billing/chat-turn-billing.ts).
--
-- Every Usage Event a chat turn writes carries metadata.chatTurnId, and so
-- does the pending credit debit it enqueues. When the turn's answer is not
-- delivered, the refund voids the credits of those events by turn id; this
-- partial index keeps that lookup to the turn's own rows. Only chat events
-- carry the key, so the index stays small. No column is needed: the id is
-- only ever matched exactly, and the pending-debit side is a short-lived
-- table filtered by org first (credit_debits_pending_org_idx).
CREATE INDEX IF NOT EXISTS usage_events_chat_turn_idx
  ON usage_events ((metadata ->> 'chatTurnId'))
  WHERE (metadata ->> 'chatTurnId') IS NOT NULL;
