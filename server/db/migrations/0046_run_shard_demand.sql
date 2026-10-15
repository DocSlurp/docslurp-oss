-- Document shards still waiting or running for a run's current stage. The
-- workflow sets it when a stage fans out across machines, each finished shard
-- decrements it, and the stage's own checkpoint clears it. The autoscaler
-- query (packages/shared/src/worker-autoscale.ts) turns it into machines.
ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS shard_demand integer DEFAULT 0 NOT NULL;
