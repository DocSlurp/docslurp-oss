-- Retyped kg_communities.vector to vector(1024). That column was dropped in
-- 0008 (vectors live in LanceDB) and is no longer created by 0000, so this
-- migration is now a no-op kept for journal continuity.
SELECT 1;
