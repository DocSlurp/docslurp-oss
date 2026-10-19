-- destructive-migration: unused since 54f038b6 (#40) retired automation operations and grounded summaries; contract step for that removal. Release N-1 only deletes ai_operations rows during org offboarding.
DROP TABLE IF EXISTS "ai_operation_events";
DROP TABLE IF EXISTS "ai_operations";
DROP TABLE IF EXISTS "grounded_summaries";
