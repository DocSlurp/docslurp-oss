-- Policy publication locks the project row before checking the complete retained corpus.
-- Every admission takes that row lock, including deferred/reindex/extract paths. A request
-- prepared before an empty-project policy transition must satisfy the newly committed policy.
CREATE OR REPLACE FUNCTION docslurp_pipeline_policy_covers(candidate jsonb, required jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT
    CASE coalesce(candidate->>'privacyMode', 'standard') WHEN 'strict-privacy' THEN 2 WHEN 'local-only' THEN 1 ELSE 0 END >=
    CASE coalesce(required->>'privacyMode', 'standard') WHEN 'strict-privacy' THEN 2 WHEN 'local-only' THEN 1 ELSE 0 END
    AND (
      NOT coalesce((required->'piiPolicy'->>'enabled')::boolean, false)
      OR (
        coalesce((candidate->'piiPolicy'->>'enabled')::boolean, false)
        AND CASE coalesce(candidate->'piiPolicy'->>'action', 'flag_for_review') WHEN 'block_indexing' THEN 3 WHEN 'redact_artifacts' THEN 2 ELSE 1 END >=
            CASE coalesce(required->'piiPolicy'->>'action', 'flag_for_review') WHEN 'block_indexing' THEN 3 WHEN 'redact_artifacts' THEN 2 ELSE 1 END
        AND coalesce(candidate->'piiPolicy'->'patterns', '["ssn","credit-card","openai-api-key","anthropic-api-key","github-token","generic-api-key","aws-access-key","stripe-api-key","private-key"]'::jsonb)
          @> coalesce(required->'piiPolicy'->'patterns', '["ssn","credit-card","openai-api-key","anthropic-api-key","github-token","generic-api-key","aws-access-key","stripe-api-key","private-key"]'::jsonb)
        AND coalesce(required->'piiPolicy'->'allowlistPatterns', '[]'::jsonb) @> coalesce(candidate->'piiPolicy'->'allowlistPatterns', '[]'::jsonb)
      )
    )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_check_run_policy_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_policy jsonb;
BEGIN
  SELECT pipeline INTO required_policy FROM projects WHERE id=NEW.project_id AND org_id=NEW.org_id FOR UPDATE;
  IF NOT FOUND OR docslurp_pipeline_policy_covers(NEW.pipeline, required_policy) IS NOT TRUE THEN
    RAISE EXCEPTION 'Run policy no longer satisfies the project policy; reload before retrying' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER project_runs_policy_admission BEFORE INSERT ON project_runs
FOR EACH ROW EXECUTE FUNCTION docslurp_check_run_policy_admission();
