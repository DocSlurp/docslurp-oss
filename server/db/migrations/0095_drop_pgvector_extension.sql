-- destructive-migration: no object has used the vector extension since 0008 moved vectors to LanceDB; release N-1 never calls it. Drop it wherever the migrating role owns it (databases built from the old 0000 baseline). Where a superuser created it outside migrations, the app role cannot drop it, so log a notice instead of failing the release and let that owner run DROP EXTENSION vector.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_extension e WHERE e.extname = 'vector' AND pg_has_role(current_user, e.extowner, 'MEMBER')) THEN
    DROP EXTENSION vector;
  ELSIF EXISTS (SELECT FROM pg_extension WHERE extname = 'vector') THEN
    RAISE NOTICE 'vector extension is owned by another role; run DROP EXTENSION vector as that owner';
  END IF;
END $$;
