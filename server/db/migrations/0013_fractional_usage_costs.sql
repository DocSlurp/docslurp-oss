-- Preserve sub-cent provider charges; round only at external payment boundaries.
ALTER TABLE usage_events ALTER COLUMN cost_cents TYPE numeric(24,12);
--> statement-breakpoint
ALTER TABLE organizations ALTER COLUMN credit_balance_cents TYPE numeric(24,12);
--> statement-breakpoint
ALTER TABLE credit_ledger ALTER COLUMN delta TYPE numeric(24,12);
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS admin_stats;
--> statement-breakpoint
ALTER TABLE workspace_runs ALTER COLUMN input_cost_cents TYPE numeric(24,12), ALTER COLUMN output_cost_cents TYPE numeric(24,12);
--> statement-breakpoint
CREATE MATERIALIZED VIEW admin_stats AS SELECT date_trunc('hour', created_at) AS hour, count(*) AS runs_count, sum(pages_total) AS pages_total, avg(output_cost_cents + input_cost_cents) AS avg_cost_cents FROM workspace_runs GROUP BY date_trunc('hour', created_at);
