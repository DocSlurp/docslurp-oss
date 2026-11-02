INSERT INTO "user"(id,name,email) VALUES('geo-u','Geo','geo@example.com');
INSERT INTO organizations(id,name,slug,created_by_user_id) VALUES('geo-o','Geo','geo-life','geo-u');
INSERT INTO workspaces(id,org_id,user_id,name) VALUES('geo-w','geo-o','geo-u','Geo');
INSERT INTO workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,pipeline)
VALUES('geo-r','geo-o','geo-u','geo-w','upload','processing','structured-extract','{}');
INSERT INTO documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status)
VALUES('geo-doc','geo-o','geo-u','geo-w','geo-r','point.txt','text/plain','geo-source','processing'),
('geo-correction','geo-o','geo-u','geo-w','geo-r','correct.txt','text/plain','geo-other','processing');
INSERT INTO document_run_stage_states(run_id,document_id,stage_name,status,attempts,stats)
VALUES('geo-r','geo-doc','structured-extract','processing',1,'{}');
UPDATE documents SET projection_revision=projection_revision+1 WHERE id='geo-doc';
BEGIN;
SELECT commit_geo_final_source('geo-doc','geo-w','geo-o',1,'geo-r',repeat('a',64),repeat('b',64),
 '[{"fieldPath":"/site","ordinal":0,"geometry":{"type":"Point","coordinates":[0,0]}}]');
UPDATE document_run_stage_states SET status='completed' WHERE document_id='geo-doc';
COMMIT;
-- Identical retry after a lost COMMIT acknowledgement is successful.
SELECT commit_geo_final_source('geo-doc','geo-w','geo-o',1,'geo-r',repeat('a',64),repeat('b',64),
 '[{"fieldPath":"/site","ordinal":0,"geometry":{"type":"Point","coordinates":[0,0]}}]');
DO $$ BEGIN
 IF (SELECT count(*) FROM geo_projection_features WHERE document_id='geo-doc' AND ST_X(geom)=0 AND ST_Y(geom)=0) <> 1 THEN RAISE EXCEPTION 'zero point lost'; END IF;
 BEGIN
  PERFORM commit_geo_final_source('geo-doc','other','geo-o',1,'geo-r',repeat('a',64),repeat('b',64),'[]');
  RAISE EXCEPTION 'wrong workspace accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='wrong workspace accepted' THEN RAISE; END IF; END;
END $$;
INSERT INTO document_corrections(id,document_id,run_id,user_id,notes)
VALUES('geo-note','geo-doc','geo-r','geo-u','Only a note');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ready_geo_projection_generations WHERE document_id='geo-doc') THEN RAISE EXCEPTION 'notes-only insert invalidated geometry'; END IF;
END $$;
DELETE FROM document_corrections WHERE id='geo-note';
UPDATE documents SET status='completed',updated_at=now() WHERE id='geo-doc';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ready_geo_projection_generations WHERE document_id='geo-doc') THEN RAISE EXCEPTION 'operational completion invalidated geometry'; END IF;
END $$;
INSERT INTO document_corrections(id,document_id,run_id,user_id,corrected_structured_data)
VALUES('geo-c','geo-correction','geo-r','geo-u','{"site":{"type":"Point","coordinates":[1,2]}}');
SELECT commit_geo_corrected_source('geo-correction','geo-w','geo-o',1,
 '{"site":{"type":"Point","coordinates":[1,2]}}',repeat('c',64),repeat('d',64),
 '[{"fieldPath":"/site","ordinal":0,"geometry":{"type":"Point","coordinates":[1,2]}}]');
-- Invalid topology must roll back both accepted snapshot and projection replacement.
DO $$ BEGIN
 BEGIN
  PERFORM commit_geo_corrected_source('geo-correction','geo-w','geo-o',1,
   '{"site":{"type":"Point","coordinates":[1,2]}}',repeat('c',64),repeat('e',64),
   '[{"fieldPath":"/site","ordinal":0,"geometry":{"type":"Polygon","coordinates":[[[0,0],[2,2],[0,2],[2,0],[0,0]]]}}]');
  RAISE EXCEPTION 'invalid topology accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT result_digest FROM geo_accepted_sources WHERE document_id='geo-correction')<>repeat('d',64) THEN RAISE EXCEPTION 'failed projection corrupted source'; END IF;
END $$;
UPDATE document_corrections SET corrected_structured_data=NULL WHERE document_id='geo-correction';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ready_geo_projection_generations WHERE document_id='geo-correction') THEN RAISE EXCEPTION 'old correction remained ready'; END IF;
END $$;
SELECT commit_geo_corrected_source('geo-correction','geo-w','geo-o',2,NULL,repeat('c',64),repeat('f',64),'[]');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM geo_projection_features WHERE document_id='geo-correction') THEN RAISE EXCEPTION 'clear retained point'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ready_geo_projection_generations WHERE document_id='geo-correction') THEN RAISE EXCEPTION 'accepted empty generation absent'; END IF;
END $$;
DELETE FROM documents WHERE id='geo-correction';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM geo_accepted_sources WHERE document_id='geo-correction') OR EXISTS(SELECT 1 FROM geo_projection_generations WHERE document_id='geo-correction') THEN RAISE EXCEPTION 'delete did not cascade'; END IF;
END $$;
SELECT 'PASS: final source, retry, topology rollback, null correction, scope, cascade';
