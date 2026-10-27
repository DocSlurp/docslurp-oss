#!/usr/bin/env bash
# Start one built worker for an arm. Usage: start-worker.sh <A|B> <run-dir>
# A: production routing policy (router shadow, layout off). B: same plus layout shadow.
# Env files live outside the repository in <run-dir>/env (base.env, secrets.env, layout.env).
set -euo pipefail
arm="$1"; run="$2"
root="$(cd "$(dirname "$0")/../.." && pwd)"
set -a
source "$run/env/base.env"
source "$run/env/secrets.env"
if [[ "$arm" == "B" ]]; then source "$run/env/layout.env"; else export PAGE_ROUTER_LAYOUT=off; fi
set +a
cd "$root/worker"
nohup node dist/temporal/worker.js >> "$run/logs/worker-$arm.log" 2>&1 &
echo $! > "$run/logs/worker.pid"
echo "$arm" > "$run/logs/worker.arm"
echo "started worker arm=$arm pid=$(cat "$run/logs/worker.pid")"
