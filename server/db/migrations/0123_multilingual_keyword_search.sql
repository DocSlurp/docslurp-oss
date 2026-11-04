-- Keyword search was English-only: document_chunks.ts_content is to_tsvector('english', text), so accent
-- variants ("Muller" for "Müller") never matched and CJK text, which has no spaces, indexed one token per run.
-- ts_folded is a second, additive leg beside English stemming: the 'simple' configuration (no stemming and no
-- English stop words, so negations such as "not" and "sans" survive) over docslurp_fold_text(text), which
-- lowercases, strips Latin diacritics (NFD, remove combining marks, NFC) and puts a space around every
-- CJK / kana / Hangul character so each is its own token and a phrase of adjacent tokens finds a substring.
-- The function is IMMUTABLE and extension-free (no unaccent), so generated columns work on any Postgres 13+.
-- Adding a stored generated column rewrites document_chunks once; the GIN index builds after it.
CREATE OR REPLACE FUNCTION docslurp_fold_text(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT regexp_replace(
    normalize(regexp_replace(normalize(lower(input), NFD), '[̀-ͯ]', '', 'g'), NFC),
    '([぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ])', ' \1 ', 'g')
$$;
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "ts_folded" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, docslurp_fold_text(text))) STORED;
--> statement-breakpoint
CREATE INDEX "document_chunks_ts_folded_idx" ON "document_chunks" USING gin ("ts_folded" tsvector_ops);
