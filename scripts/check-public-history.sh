#!/usr/bin/env bash
# Fails when <ref> carries history that must never be in this public repository:
#   - a root commit other than the OSS root (the private pre-split history has its own root), or
#   - a commit not on <base> that touches a path that exists only in the private DocSlurp/app repo.
# Usage: scripts/check-public-history.sh <ref> [base-ref]   (exit 1 on a violation)
# Background: on 2026-10-27 a bulk push published a branch with the private history (app/, api/, docs/business).
set -euo pipefail
ref=${1:?usage: check-public-history.sh <ref> [base-ref]}
base=${2:-origin/main}
OSS_ROOT=146c5d4531a495ccaf90aab1f503b53016cd65fe
PRIVATE_PATHS='^(app|api|db|research|models|mockups|infographics|infra|integrations|cli|\.design-overhaul|\.tmp-screenshots|test-results)/|^docs/(business|reports)/|(^|/)\.env(\.production)?$'
status=0
while read -r root; do
  if [ "$root" != "$OSS_ROOT" ]; then echo "::error::$ref has foreign root commit $root (private pre-split history?)"; status=1; fi
done < <(git rev-list --max-parents=0 "$ref")
hits=$(git rev-list "$ref" --not "$base" | git diff-tree --stdin --no-commit-id --name-only -r --root | grep -E "$PRIVATE_PATHS" | sort -u | head -20 || true)
if [ -n "$hits" ]; then echo "::error::$ref adds private-only paths:"; echo "$hits"; status=1; fi
[ $status -eq 0 ] && echo "public-history guard: $ref ok"
exit $status
