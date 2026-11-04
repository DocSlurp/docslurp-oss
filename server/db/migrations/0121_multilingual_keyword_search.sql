-- Keyword search was English-only: document_chunks.ts_content is to_tsvector('english', text), so accent
-- variants ("Muller" for "Müller") never matched and CJK text, which has no spaces, indexed one token per run.
-- The folded leg is a second, additive leg beside English stemming: the 'simple' configuration (no stemming and no
-- English stop words, so negations such as "not" and "sans" survive) over docslurp_fold_text(text), which
-- lowercases, strips Latin diacritics (NFD, remove combining marks, NFC) and puts a space around every
-- CJK / kana / Hangul character so each is its own token and a phrase of adjacent tokens finds a substring.
-- The function is IMMUTABLE and extension-free (no unaccent), so an expression index over it works on any Postgres 13+.
--
-- This migration only defines the function: instant, no table lock. An earlier draft added a stored generated
-- column plus a GIN index on document_chunks, which rewrites the table under ACCESS EXCLUSIVE (measured 200k rows of
-- ~2 KB text: 221 s for the rewrite, 81 s more for the index, every keyword/hybrid/chat read and chunk insert blocked,
-- and the migrator runs pending migrations in one transaction). Queries instead use the expression
--   to_tsvector('simple'::regconfig, docslurp_fold_text(text))
-- which a GIN expression index serves once built. The index cannot be built here (CREATE INDEX CONCURRENTLY
-- cannot run in a transaction); `node scripts/folded-search-index.mjs` builds it outside the migrator, idempotently
-- (docs/rollout-0121-0127.md). Until it is built the folded leg works by evaluating the expression for the
-- workspace's chunks, bounded by the search statement timeout, so keyword search never depends on the build.
CREATE OR REPLACE FUNCTION docslurp_fold_text(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT regexp_replace(
    normalize(regexp_replace(normalize(lower(input), NFD), '[̀-ͯ]', '', 'g'), NFC),
    '([぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ])', ' \1 ', 'g')
$$;
