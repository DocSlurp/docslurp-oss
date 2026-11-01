#!/usr/bin/env bash
set -euo pipefail
# No application credentials, host mounts, published ports, or shared database.
export TMPDIR="${TMPDIR:-/home/dan/tmp/agents}" TMP="${TMP:-/home/dan/tmp/agents}" TEMP="${TEMP:-/home/dan/tmp/agents}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
image="$(cat "$root/image.txt")"
[[ "$image" == *@sha256:* ]] || { echo 'Expected digest-pinned image' >&2; exit 1; }
name="docslurp-postgis-test-$$-$RANDOM"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# PGDATA tmpfs prevents anonymous persistent database volumes.
docker run -d --name "$name" --network none --memory 512m --cpus 1 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,size=256m --shm-size 64m \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { docker logs "$name"; exit 1; }
docker exec -i "$name" psql -X -U postgres -v ON_ERROR_STOP=1 < "$root/test.sql"
