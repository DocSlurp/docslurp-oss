-- search/session.ts and better-auth.ts call pgp_sym_encrypt. Fresh databases built
-- only from migrations previously lacked pgcrypto. A new migration (not an edit to
-- 0000) so it also runs on databases that already applied 0000.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
