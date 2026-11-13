-- Figure storage billing (docs/extraction/doppler-figures.md, "Storage billing"). The daily storage meter
-- (server/src/services/billing/storage-meter.ts) adds the measured bytes of stored figure files, their index and manifest
-- (document_extraction_levels.asset_bytes, recomputed from committed ledger rows) to objectBytes. Before this the
-- per-page artifact estimate never covered figures, so nothing is counted twice.
--
-- One index-only aggregate per org per day: the meter sums asset_bytes for the org's documents that store any.
CREATE INDEX IF NOT EXISTS document_extraction_levels_org_bytes_idx
  ON document_extraction_levels (org_id) INCLUDE (asset_bytes, document_id, project_id) WHERE asset_bytes > 0;
--> statement-breakpoint
-- Audit: how many of a day's object bytes were measured from the asset ledger.
ALTER TABLE storage_meter_days ADD COLUMN IF NOT EXISTS measured_artifact_bytes bigint NOT NULL DEFAULT 0
  CHECK (measured_artifact_bytes >= 0);
