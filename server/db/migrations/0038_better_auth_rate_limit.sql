-- Better Auth rate-limit counters (security gap G-09).
--
-- Better Auth's sign-in, sign-up and password-reset limits were kept in
-- per-process memory, so every app machine had its own budget. With
-- rateLimit.storage = "database" they live here and are shared. Keys are
-- "<client ip>|<path>"; the client IP is the edge-derived address the app sets
-- in x-docslurp-client-ip (Fly-Client-IP on Fly), not a client header.
CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL,
  CONSTRAINT "rateLimit_key_key" UNIQUE ("key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rateLimit_lastRequest_idx" ON "rateLimit" ("lastRequest");
