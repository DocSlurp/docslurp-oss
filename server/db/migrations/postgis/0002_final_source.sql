CREATE FUNCTION publish_accepted_geo_source(doc text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source geo_accepted_sources; feature jsonb;
BEGIN
  SELECT a.* INTO STRICT source FROM geo_accepted_sources a JOIN documents d
    ON (d.id,d.workspace_id,d.org_id,d.projection_revision)=(a.document_id,a.workspace_id,a.org_id,a.source_revision)
    WHERE a.document_id=doc;
  DELETE FROM geo_projection_generations WHERE document_id=doc;
  INSERT INTO geo_projection_generations VALUES(source.document_id,source.workspace_id,source.org_id,
    source.source_revision,source.schema_digest,source.result_digest);
  FOR feature IN SELECT value FROM jsonb_array_elements(source.features) LOOP
    INSERT INTO geo_projection_features VALUES(source.document_id,source.workspace_id,source.org_id,
      source.source_revision,feature->>'fieldPath',(feature->>'ordinal')::integer,
      ST_SetSRID(ST_GeomFromGeoJSON((feature->'geometry')::text),4326));
  END LOOP;
END $$;
