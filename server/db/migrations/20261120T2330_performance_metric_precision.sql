-- destructive-migration: Widens the existing decimal column in place. Old releases use the same numeric type and read and write the same representation; existing values are preserved exactly.
-- Metrics mix counts, byte sizes, fractional costs and derived rates.
-- A checkpoint that reuses prior work can have a millisecond duration and
-- a large page count, yielding a rate outside the old numeric(16,4) range.
ALTER TABLE performance_log ALTER COLUMN value TYPE numeric;
