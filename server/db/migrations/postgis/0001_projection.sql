CREATE TABLE geo_projection_generations (
  document_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  org_id text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (document_id, workspace_id, org_id) REFERENCES documents(id, workspace_id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, org_id) REFERENCES workspaces(id, org_id) ON DELETE CASCADE,
  UNIQUE (document_id, workspace_id, org_id, source_revision)
);
CREATE TABLE geo_projection_features (
  document_id text NOT NULL,
  workspace_id text NOT NULL,
  org_id text NOT NULL,
  source_revision bigint NOT NULL,
  field_path text NOT NULL CHECK (length(field_path) BETWEEN 1 AND 2048),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  geom geometry(Geometry,4326) NOT NULL,
  PRIMARY KEY (document_id, field_path, ordinal),
  FOREIGN KEY (document_id, workspace_id, org_id, source_revision)
    REFERENCES geo_projection_generations(document_id, workspace_id, org_id, source_revision) ON DELETE CASCADE,
  CHECK (ST_NDims(geom) = 2 AND NOT ST_IsEmpty(geom)),
  CHECK (GeometryType(geom) IN ('POINT','MULTIPOINT','POLYGON','MULTIPOLYGON')),
  CHECK (ST_IsValid(geom)),
  CHECK (ST_NPoints(geom) <= 100000),
  CHECK (ST_XMin(Box3D(geom)) >= -180 AND ST_XMax(Box3D(geom)) <= 180
    AND ST_YMin(Box3D(geom)) >= -90 AND ST_YMax(Box3D(geom)) <= 90)
);
CREATE INDEX geo_projection_geometry ON geo_projection_features USING gist (geom);
CREATE INDEX geo_projection_point_geography ON geo_projection_features USING gist ((geom::geography))
  WHERE GeometryType(geom) IN ('POINT','MULTIPOINT');
-- Readers must use this view: stale generations are never ready, even before cleanup.
CREATE VIEW ready_geo_projection_generations AS
SELECT g.* FROM geo_projection_generations g JOIN documents d
ON (d.id, d.workspace_id, d.org_id, d.projection_revision) =
   (g.document_id, g.workspace_id, g.org_id, g.source_revision);
