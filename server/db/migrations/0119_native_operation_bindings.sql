-- Application identity remains independent of native task execution.
ALTER TABLE chat_operations ADD COLUMN runtime text NOT NULL DEFAULT 'legacy'
  CHECK(runtime IN ('legacy','mastra'));
CREATE INDEX chat_operations_runtime_owner ON chat_operations(runtime,user_id,root_id);
