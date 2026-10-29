-- Shard calibration (worker/src/pipeline/shard-calibration.ts) reads the newest shard_timing_ms rows per
-- planner profile; a partial index keeps that lookup off the stage_name scan of per-page rows.
CREATE INDEX IF NOT EXISTS "performance_log_shard_timing_idx"
  ON "performance_log" ((metadata->>'profileKey'), "created_at" DESC)
  WHERE "metric" = 'shard_timing_ms';
