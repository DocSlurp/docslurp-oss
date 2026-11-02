INSERT INTO workspaces VALUES ('w','o','{}',NULL);
INSERT INTO documents(id,workspace_id,org_id) VALUES ('d','w','o');
INSERT INTO geo_projection_generations VALUES ('d','w','o',0,repeat('a',64),repeat('b',64));
DO $$ BEGIN
 IF (SELECT count(*) FROM ready_geo_projection_generations) <> 1 THEN RAISE EXCEPTION 'empty generation not ready'; END IF;
END $$;
INSERT INTO document_corrections VALUES ('d','{"location":null}');
DO $$ BEGIN
 IF (SELECT projection_revision FROM documents WHERE id='d') <> 1 THEN RAISE EXCEPTION 'correction failed to fence'; END IF;
 IF EXISTS(SELECT 1 FROM ready_geo_projection_generations) THEN RAISE EXCEPTION 'stale correction visible'; END IF;
END $$;
UPDATE workspaces SET pipeline='{"schema":"changed"}';
DO $$ BEGIN
 IF (SELECT projection_revision FROM documents WHERE id='d') <> 2 THEN RAISE EXCEPTION 'schema failed to fence'; END IF;
 BEGIN
 INSERT INTO geo_projection_features VALUES ('d','other','o',0,'location',0,ST_GeomFromText('POINT(1 2)',4326));
 RAISE EXCEPTION 'cross workspace accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
DELETE FROM documents;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM geo_projection_generations) THEN RAISE EXCEPTION 'delete failed to cascade'; END IF;
END $$;
