-- Purges drop embedding_reuse_refs rows pointing into the embedding artifacts
-- they delete (worker/src/db/superseded-purge.ts, retention in store.ts), by
-- artifact URI; without this index each delete scans every org's refs.
CREATE INDEX IF NOT EXISTS "embedding_reuse_refs_artifact_uri_idx" ON "embedding_reuse_refs" USING btree ("artifact_uri");
