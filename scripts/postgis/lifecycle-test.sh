#!/usr/bin/env bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/home/dan/tmp/agents}" TMP="${TMP:-/home/dan/tmp/agents}" TEMP="${TEMP:-/home/dan/tmp/agents}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
image="$(cat "$root/image.txt")"
[[ "$image" == *@sha256:* ]] || exit 1
name="docslurp-geo-lifecycle-$$-$RANDOM"
scratch="$(mktemp -d "$TMPDIR/geo-lifecycle.XXXXXX")"
cleanup() { docker exec "$name" sh -c 'rm -f /var/run/postgresql/.s.PGSQL.*' >/dev/null 2>&1 || true; docker rm -fv "$name" >/dev/null 2>&1 || true; rm -rf -- "$scratch"; }
trap cleanup EXIT
socket_mount=()
if [[ "${GEO_QUERY_INTEGRATION:-0}" == 1 ]]; then
 mkdir "$scratch/socket"; chmod 0777 "$scratch/socket"
 socket_mount=(--mount "type=bind,source=$scratch/socket,target=/var/run/postgresql")
fi
docker run -d "${socket_mount[@]}" --name "$name" --network none --memory 768m --cpus 1 --pids-limit 128 --tmpfs /var/lib/postgresql/data:rw,size=384m --shm-size 64m -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
for attempt in $(seq 1 60); do
 if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
python - "$root" > "$scratch/migrations.sql" <<'PY'
import json,sys,pathlib
r=pathlib.Path(sys.argv[1]).parents[1]/'server/db/migrations'
for entry in json.loads((r/'meta/_journal.json').read_text())['entries']:
 print('BEGIN;');print((r/(entry['tag']+'.sql')).read_text());print('COMMIT;')
print('CREATE EXTENSION IF NOT EXISTS postgis;')
for name in json.loads((r/'postgis/journal.json').read_text()):print((r/'postgis'/name).read_text())
PY
docker exec -i "$name" psql -X -q -U postgres -v ON_ERROR_STOP=1 < "$scratch/migrations.sql"
docker exec -i "$name" psql -X -U postgres -v ON_ERROR_STOP=1 < "$root/lifecycle-test.sql"
# Two real independent backends: wait until A holds the row and is sleeping,
# then B's old revision must wait and refuse after A commits its replacement.
docker exec -i "$name" psql -X -U postgres -v ON_ERROR_STOP=1 > "$scratch/writer.log" 2>&1 <<'SQL' &
SET application_name='geo_lifecycle_writer';
BEGIN;
SELECT id FROM documents WHERE id='geo-doc' FOR UPDATE;
SELECT pg_sleep(3);
UPDATE documents SET projection_revision=projection_revision+1 WHERE id='geo-doc';
COMMIT;
SQL
writer=$!
ready=false
for attempt in $(seq 1 50); do
 if [[ "$(docker exec "$name" psql -X -At -U postgres -c "select count(*) from pg_stat_activity where application_name='geo_lifecycle_writer' and wait_event='PgSleep'")" == 1 ]]; then ready=true; break; fi
 sleep 0.1
done
[[ "$ready" == true ]]
if docker exec "$name" psql -X -U postgres -v ON_ERROR_STOP=1 -c "select commit_geo_final_source('geo-doc','geo-w','geo-o',1,'geo-r',repeat('a',64),repeat('b',64),'[]')" > "$scratch/stale.log" 2>&1; then
 echo 'ERROR: concurrent stale publisher succeeded' >&2; exit 1
fi
wait "$writer"
rg -q 'Stale or ineligible geo source' "$scratch/stale.log"
echo 'PASS: two-backend stale publication refused after writer committed'

if [[ "${GEO_QUERY_INTEGRATION:-0}" == 1 ]]; then
 GEO_TEST_SOCKET="$scratch/socket" pnpm --filter @docslurp/server exec vitest run src/__tests__/geo-query.integration.test.ts
fi
