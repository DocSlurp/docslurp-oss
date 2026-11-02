\set ON_ERROR_STOP on
SET statement_timeout = '20s';
SELECT version(), postgis_full_version();
DO $$
DECLARE
  area geometry := ST_GeomFromText('POLYGON((0 0,10 0,10 10,0 10,0 0),(3 3,3 7,7 7,7 3,3 3))',4326);
  origin geography := ST_SetSRID(ST_Point(0,0),4326)::geography;
  east geography := ST_SetSRID(ST_Point(1,0),4326)::geography;
BEGIN
  IF NOT ST_DWithin(origin,origin,0) OR ST_DWithin(origin,east,111319) OR NOT ST_DWithin(origin,east,111320) THEN
    RAISE EXCEPTION 'spheroidal radius meters failed';
  END IF;
  IF NOT ST_DWithin('SRID=4326;POINT(0 90)'::geography,'SRID=4326;POINT(180 90)'::geography,0) THEN RAISE EXCEPTION 'polar coincidence failed'; END IF;
  IF NOT ST_CoveredBy(area,ST_Multi(area)) THEN RAISE EXCEPTION 'polygon multipolygon coverage failed'; END IF;
  IF abs(ST_Distance(origin,east)-111319.490793) > 0.001 THEN RAISE EXCEPTION 'equatorial distance failed'; END IF;
  IF NOT ST_DWithin(origin, 'SRID=4326;MULTIPOINT((0 0),(2 0))'::geography,0) THEN RAISE EXCEPTION 'multipoint any failed'; END IF;
  IF NOT ST_CoveredBy(ST_SetSRID(ST_Point(0,5),4326),area) OR ST_Within(ST_SetSRID(ST_Point(0,5),4326),area) THEN RAISE EXCEPTION 'inclusive boundary failed'; END IF;
  IF ST_Intersects(ST_SetSRID(ST_Point(5,5),4326),area) OR NOT ST_Intersects(ST_SetSRID(ST_Point(3,5),4326),area) THEN RAISE EXCEPTION 'hole semantics failed'; END IF;
  IF ST_CoveredBy('SRID=4326;MULTIPOINT((1 1),(11 1))'::geometry,area) THEN RAISE EXCEPTION 'multipoint all failed'; END IF;
  IF ST_IsValid('SRID=4326;POLYGON((0 0,2 2,0 2,2 0,0 0))'::geometry) THEN RAISE EXCEPTION 'invalid topology accepted'; END IF;
  IF NOT ST_Intersects(ST_SetSRID(ST_Point(180,0),4326),ST_MakeEnvelope(170,-10,180,10,4326))
    OR NOT ST_Intersects(ST_SetSRID(ST_Point(-179,0),4326),ST_MakeEnvelope(-180,-10,-170,10,4326))
    OR ST_Intersects(ST_SetSRID(ST_Point(0,0),4326),ST_Union(ST_MakeEnvelope(170,-10,180,10,4326),ST_MakeEnvelope(-180,-10,-170,10,4326))) THEN RAISE EXCEPTION 'dateline split bbox failed'; END IF;
END $$;
-- Temporary synthetic relations only: this is not application projection DDL.
CREATE TEMP TABLE geo_plan AS SELECT n, ST_SetSRID(ST_Point((n % 100)/10.0-5,((n / 100) % 100)/10.0-5),4326) AS geom FROM generate_series(1,10000) n;
CREATE INDEX ON geo_plan USING gist(geom);
CREATE INDEX ON geo_plan USING gist((geom::geography));
ANALYZE geo_plan;
EXPLAIN (ANALYZE,BUFFERS) SELECT n FROM geo_plan WHERE ST_Intersects(geom,ST_MakeEnvelope(1,1,2,2,4326));
EXPLAIN (ANALYZE,BUFFERS) SELECT n FROM geo_plan WHERE ST_DWithin(geom::geography,'SRID=4326;POINT(0 0)'::geography,1000);
SELECT 'PostGIS semantic assertions passed' AS result;
