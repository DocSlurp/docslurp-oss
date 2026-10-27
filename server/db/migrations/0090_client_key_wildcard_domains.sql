-- Browser (client) API key allowed websites used to match a host and every
-- subdomain of it, and the old normalizer stored "*.example.com" as plain
-- "example.com". Entries are now exact unless they start with "*." (which
-- covers subdomains, not the apex). Keep each stored key's meaning by adding
-- "*.<entry>" beside every bare domain entry. Entries that already carry a
-- wildcard, a scheme or a port, IPv4 literals, localhost and single labels
-- are left as they are. Idempotent: a re-run adds nothing.
UPDATE api_keys AS k
SET allowed_domains = expanded.domains
FROM (
  SELECT
    ak.id,
    ARRAY(
      SELECT entry FROM (
        SELECT entry, min(ord) AS ord
        FROM (
          SELECT stored.entry, stored.n * 2 AS ord
          FROM unnest(ak.allowed_domains) WITH ORDINALITY AS stored(entry, n)
          UNION ALL
          SELECT '*.' || stored.entry, stored.n * 2 + 1
          FROM unnest(ak.allowed_domains) WITH ORDINALITY AS stored(entry, n)
          WHERE stored.entry NOT LIKE '*.%'
            AND position(':' IN stored.entry) = 0
            AND position('/' IN stored.entry) = 0
            AND position('.' IN stored.entry) > 0
            AND stored.entry !~ '^[0-9.]+$'
        ) candidates
        GROUP BY entry
      ) ordered
      ORDER BY ord
    ) AS domains
  FROM api_keys AS ak
  WHERE ak.key_type = 'client' AND cardinality(ak.allowed_domains) > 0
) AS expanded
WHERE k.id = expanded.id
  AND k.allowed_domains IS DISTINCT FROM expanded.domains;
