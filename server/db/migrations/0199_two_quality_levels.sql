-- Two processing quality levels (Fastest, Smartest) replace three (Fastest, Balanced, Smart). A project stores
-- `quality: "auto"` and holds its level in the Auto ladder's highest rung (`ladder.maxRung`): `ocr` (and an unset rung)
-- is Fastest (text layer, OCR for scans and image pages, never a vision model), `fast` is Fastest with Read scans off,
-- `intelligent` is Smartest (text layer, a vision model for every page the text layer cannot carry).
--
-- Stored projects move without raising anyone's spend: an `auto` project whose ladder holds the old `intelligent`
-- default (Balanced) becomes Fastest, the new default. The retired `good` is left as stored: readers map it to Smartest
-- (migrateLegacyQualitySettings), which reads fewer pages with a model than `good` did. Run snapshots are not touched.
--
-- Idempotent: a second run finds no `auto` row on the intelligent rung (the first moved them all; `good` rows do not match).
UPDATE projects
SET pipeline = jsonb_set(pipeline, '{ladder,maxRung}', '"ocr"'::jsonb)
WHERE jsonb_typeof(pipeline) = 'object'
  AND jsonb_typeof(pipeline -> 'ladder') = 'object'
  AND coalesce(pipeline ->> 'quality', 'auto') = 'auto'
  AND pipeline -> 'ladder' ->> 'maxRung' = 'intelligent';
