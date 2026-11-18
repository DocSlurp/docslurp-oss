-- Two processing quality levels (Fastest, Smartest) replace three (Fastest, Balanced, Smart). Every project now stores
-- `quality: "auto"` and holds its level in the Auto ladder's highest rung (`ladder.maxRung`): `ocr` is Fastest (text
-- layer, OCR for scans and image pages, never a vision model), `fast` is Fastest with Read scans off, `intelligent` is
-- Smartest (text layer, a vision model for every page the text layer cannot carry).
--
-- Stored projects move without raising anyone's spend: the retired `good` (a vision model on every page) becomes
-- Smartest, which reads fewer pages with a model; every `auto` project (Balanced, whose ladder was written with the old
-- `intelligent` default) becomes Fastest, the new default. Explicit lower rungs (`fast`, `ocr`) are kept. Run snapshots
-- are not touched: a run keeps executing what it was admitted with, and readers map retired words on read.
--
-- The two updates are not a fixed point on their own (a moved `good` project reads as `auto` + `intelligent`), so they
-- run once, recorded in pipeline_data_migrations; a second run of this file changes nothing.
CREATE TABLE IF NOT EXISTS pipeline_data_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pipeline_data_migrations WHERE name = 'two-quality-levels') THEN
    UPDATE projects
    SET pipeline = jsonb_set(
      pipeline,
      '{ladder}',
      coalesce(pipeline -> 'ladder', '{}'::jsonb) || '{"maxRung": "ocr"}'::jsonb
    )
    WHERE coalesce(pipeline ->> 'quality', 'auto') = 'auto'
      AND coalesce(pipeline -> 'ladder' ->> 'maxRung', 'intelligent') = 'intelligent';

    UPDATE projects
    SET pipeline = jsonb_set(
      jsonb_set(pipeline, '{quality}', '"auto"'::jsonb),
      '{ladder}',
      coalesce(pipeline -> 'ladder', '{}'::jsonb) || '{"maxRung": "intelligent"}'::jsonb
    )
    WHERE pipeline ->> 'quality' = 'good';

    INSERT INTO pipeline_data_migrations (name) VALUES ('two-quality-levels') ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;
