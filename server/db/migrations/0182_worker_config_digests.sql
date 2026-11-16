-- Configuration digests each worker process reports with its capability heartbeat (worker-capabilities.ts), by name:
-- `operator` is the sha-256 of the validated operator config file (DOCSLURP_OPERATOR_CONFIG), null when none is
-- configured. The app compares them with its own to show and refuse app/worker config skew (/ops/worker-fleet).
alter table worker_capabilities add column if not exists config_digests jsonb not null default '{}'::jsonb;
