#!/usr/bin/env bash
# Real release-entrypoint regression on production PostgreSQL/PostGIS versions.
set -euo pipefail
export TMPDIR="${TMPDIR:-/home/dan/tmp/agents}" TMP="${TMP:-/home/dan/tmp/agents}" TEMP="${TEMP:-/home/dan/tmp/agents}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d "$TMPDIR/geo-owner.XXXXXX")"
name="geo-owner-$$-$RANDOM"
cleanup() { docker exec "$name" sh -c 'rm -f /var/run/postgresql/.s.PGSQL.*' >/dev/null 2>&1 || true; docker rm -fv "$name" >/dev/null 2>&1 || true; rm -rf -- "$scratch"; }
trap cleanup EXIT
mkdir "$scratch/socket"; chmod 0777 "$scratch/socket"
docker run -d --name "$name" --network none --memory 1g --cpus 2 --pids-limit 128 --mount "type=bind,source=$scratch/socket,target=/var/run/postgresql" -e POSTGRES_HOST_AUTH_METHOD=trust postgis/postgis@sha256:1ac10b2551ba84ae05db8e7da477afcd0a3fede99bcb7705da2ee157390cb095 >/dev/null
for attempt in $(seq 1 60); do
 if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres <<'SQL'
CREATE ROLE docslurp LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE docslurp OWNER docslurp;
\connect docslurp
CREATE EXTENSION postgis WITH SCHEMA public VERSION '3.6.4';
SELECT version(), postgis_full_version();
SQL
cd "$root"
export DATABASE_URL="postgresql://docslurp@localhost/docslurp?host=$scratch/socket" POSTGIS_MIGRATIONS=1
unset MIGRATION_DATABASE_URL
node server/db/migrate.mjs
node server/db/migrate.mjs
GEO_OWNER_SOCKET="$scratch/socket" node scripts/postgis/migration-owner-test.mjs
docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U docslurp -d docslurp < scripts/postgis/lifecycle-test.sql
