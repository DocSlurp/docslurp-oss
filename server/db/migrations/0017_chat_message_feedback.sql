-- Persist per-user thumbs up/down (+ optional comment) on workspace chat answers.
CREATE TABLE IF NOT EXISTS chat_message_feedback (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  thread_id text,
  message_id text NOT NULL,
  rating text NOT NULL,
  comment text,
  question text,
  answer text,
  model text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT chat_message_feedback_rating_check CHECK (rating = ANY (ARRAY['up'::text, 'down'::text])),
  CONSTRAINT chat_message_feedback_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT chat_message_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS chat_message_feedback_user_workspace_message_idx ON chat_message_feedback USING btree (user_id, workspace_id, message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_message_feedback_workspace_id_idx ON chat_message_feedback USING btree (workspace_id, created_at DESC);
