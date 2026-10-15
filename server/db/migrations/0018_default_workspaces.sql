-- Every organization gets at most one default workspace. Requests that omit a
-- workspaceId (uploads, search, chat, MCP) resolve to it, so workspaces stay an
-- optional organizing tool rather than a required argument.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_org_default_idx ON workspaces USING btree (org_id) WHERE is_default;


--> statement-breakpoint
-- Readable, globally unique workspace slugs (e.g. amber-falcon-ridge). The
-- database generates one for every workspace. Every slug a workspace has used
-- stays in workspace_slugs and keeps resolving to it after a rename, like
-- renamed GitHub repositories; no other workspace can take it.
CREATE TABLE IF NOT EXISTS workspace_slugs (
  slug text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT workspace_slugs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_slugs_workspace_id_idx ON workspace_slugs USING btree (workspace_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION generate_workspace_slug() RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  first text[] := ARRAY['able', 'amber', 'ancient', 'azure', 'bold', 'brave', 'breezy', 'bright', 'brisk', 'calm', 'candid', 'clever', 'cosmic', 'crisp', 'curious', 'dapper', 'daring', 'deft', 'eager', 'early', 'earnest', 'fair', 'fancy', 'fleet', 'fluent', 'frank', 'gentle', 'glad', 'golden', 'grand', 'happy', 'hardy', 'hazel', 'honest', 'humble', 'jolly', 'keen', 'kind', 'lively', 'loyal', 'lucid', 'lunar', 'merry', 'mellow', 'modest', 'nimble', 'noble', 'novel', 'patient', 'plucky', 'polar', 'proud', 'quick', 'quiet', 'rapid', 'ready', 'regal', 'rosy', 'rustic', 'sharp', 'silent', 'sleek', 'snowy', 'solar', 'steady', 'sunny', 'swift', 'tidy', 'upbeat', 'vivid', 'warm', 'wise', 'witty', 'zesty'];
  second text[] := ARRAY['alpine', 'aqua', 'arctic', 'ash', 'autumn', 'birch', 'bronze', 'canyon', 'cedar', 'cherry', 'cinder', 'cobalt', 'copper', 'coral', 'cotton', 'crimson', 'crystal', 'dawn', 'desert', 'dune', 'ember', 'fern', 'flint', 'forest', 'frost', 'garnet', 'ginger', 'glacier', 'granite', 'harbor', 'indigo', 'iris', 'ivory', 'jade', 'jasper', 'lagoon', 'lake', 'lemon', 'lilac', 'maple', 'marble', 'meadow', 'mint', 'misty', 'moss', 'ocean', 'olive', 'onyx', 'orchid', 'pebble', 'pine', 'prairie', 'quartz', 'rain', 'reef', 'river', 'ruby', 'sage', 'sand', 'scarlet', 'shadow', 'silver', 'slate', 'spruce', 'stone', 'storm', 'summer', 'teal', 'timber', 'velvet'];
  third text[] := ARRAY['badger', 'beacon', 'bear', 'bison', 'canyon', 'comet', 'condor', 'crane', 'delta', 'eagle', 'falcon', 'fjord', 'fox', 'gecko', 'glade', 'grove', 'harbor', 'hawk', 'heron', 'ibis', 'island', 'jaguar', 'kestrel', 'koala', 'lantern', 'lark', 'lynx', 'marten', 'meadow', 'mesa', 'moose', 'narwhal', 'orbit', 'osprey', 'otter', 'owl', 'panda', 'pelican', 'petrel', 'puffin', 'quail', 'raven', 'ridge', 'robin', 'salmon', 'sparrow', 'spring', 'stream', 'summit', 'swallow', 'tiger', 'trail', 'tundra', 'valley', 'vista', 'walrus', 'willow', 'wolf', 'wren', 'yak', 'zephyr', 'atlas'];
  candidate text;
BEGIN
  FOR attempt IN 1..8 LOOP
    candidate := first[1 + floor(random() * array_length(first, 1))::int] || '-' ||
      second[1 + floor(random() * array_length(second, 1))::int] || '-' ||
      third[1 + floor(random() * array_length(third, 1))::int];
    IF attempt > 4 THEN
      candidate := candidate || '-' || substr(md5(random()::text), 1, 4);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspace_slugs WHERE slug = candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;
  RETURN candidate || '-' || substr(md5(clock_timestamp()::text), 1, 6);
END;
$$;
--> statement-breakpoint
-- A slug is never reused: current and former slugs of other workspaces are taken.
CREATE OR REPLACE FUNCTION guard_workspace_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL THEN
    NEW.slug := generate_workspace_slug();
  END IF;
  IF EXISTS (SELECT 1 FROM workspace_slugs WHERE slug = NEW.slug AND workspace_id <> NEW.id) THEN
    RAISE EXCEPTION 'workspace slug "%" is already taken', NEW.slug USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_workspace_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_slugs (slug, workspace_id) VALUES (NEW.slug, NEW.id) ON CONFLICT (slug) DO NOTHING;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slug text;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspaces_slug_guard ON workspaces;
--> statement-breakpoint
CREATE TRIGGER workspaces_slug_guard
BEFORE INSERT OR UPDATE OF slug ON workspaces
FOR EACH ROW EXECUTE FUNCTION guard_workspace_slug();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspaces_slug_history ON workspaces;
--> statement-breakpoint
CREATE TRIGGER workspaces_slug_history
AFTER INSERT OR UPDATE OF slug ON workspaces
FOR EACH ROW EXECUTE FUNCTION record_workspace_slug();
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM workspaces WHERE slug IS NULL ORDER BY created_at LOOP
    UPDATE workspaces SET slug = generate_workspace_slug() WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE workspaces ALTER COLUMN slug SET DEFAULT generate_workspace_slug();
--> statement-breakpoint
ALTER TABLE workspaces ALTER COLUMN slug SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_idx ON workspaces USING btree (slug);
