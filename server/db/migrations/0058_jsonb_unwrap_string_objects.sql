-- Rows written through postgres.js (prepare: false) with
-- `${JSON.stringify(x)}::jsonb` were stored as jsonb STRING scalars holding the
-- JSON text, not as objects/arrays. Unwrap them. None of these columns can
-- legitimately hold a string scalar (all are objects or arrays), and the
-- pg_input_is_valid guard leaves any genuinely non-JSON string untouched.
UPDATE documents
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string' AND pg_input_is_valid(metadata #>> '{}', 'jsonb');

UPDATE audit_log
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string' AND pg_input_is_valid(metadata #>> '{}', 'jsonb');

UPDATE notification_deliveries
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string' AND pg_input_is_valid(metadata #>> '{}', 'jsonb');

UPDATE webhook_deliveries
SET payload = (payload #>> '{}')::jsonb
WHERE jsonb_typeof(payload) = 'string' AND pg_input_is_valid(payload #>> '{}', 'jsonb');

UPDATE grounded_summaries
SET claims = CASE WHEN jsonb_typeof(claims) = 'string' AND pg_input_is_valid(claims #>> '{}', 'jsonb') THEN (claims #>> '{}')::jsonb ELSE claims END,
    citations = CASE WHEN jsonb_typeof(citations) = 'string' AND pg_input_is_valid(citations #>> '{}', 'jsonb') THEN (citations #>> '{}')::jsonb ELSE citations END,
    evidence_spans = CASE WHEN jsonb_typeof(evidence_spans) = 'string' AND pg_input_is_valid(evidence_spans #>> '{}', 'jsonb') THEN (evidence_spans #>> '{}')::jsonb ELSE evidence_spans END
WHERE jsonb_typeof(claims) = 'string' OR jsonb_typeof(citations) = 'string' OR jsonb_typeof(evidence_spans) = 'string';

UPDATE chat_answer_evidence_spans
SET citation = (citation #>> '{}')::jsonb
WHERE jsonb_typeof(citation) = 'string' AND pg_input_is_valid(citation #>> '{}', 'jsonb');
