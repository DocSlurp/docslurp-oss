#!/usr/bin/env bash
# Scan all reachable history, including merge resolutions and deleted files.
# Usage: check-public-history.sh <ref> [base-ref]
# The legacy base argument is validated but never exempts history from inspection.
# Exit 1 means a policy violation; exit 2 means inspection could not complete.
set -euo pipefail
ref=${1:?usage: check-public-history.sh <ref> [base-ref]}
OSS_ROOT=146c5d4531a495ccaf90aab1f503b53016cd65fe
export GIT_NO_REPLACE_OBJECTS=1
fail() { echo "public-history guard: inspection failed: $*" >&2; exit 2; }
sha=$(git rev-parse --verify --end-of-options "$ref^{commit}") || fail "invalid ref"
if [ $# -ge 2 ]; then
  git rev-parse --verify --end-of-options "$2^{commit}" >/dev/null || fail "invalid base"
fi
shallow=$(git rev-parse --is-shallow-repository) || fail "repository unavailable"
[ "$shallow" = false ] || fail "complete history is required"
roots=$(git rev-list --max-parents=0 "$sha") || fail "cannot enumerate roots"
[ -n "$roots" ] || fail "no root found"
status=0
while IFS= read -r root; do
  if [ "$root" != "$OSS_ROOT" ]; then
    echo "public-history guard: foreign root commit $root" >&2
    status=1
  fi
done <<< "$roots"
# Git pathspecs avoid quoted/newline filename ambiguity. Separate merge diffs
# expose files added by conflict resolution, even when absent from both parents.
paths=$(git log --full-history --format= --name-only --diff-merges=separate "$sha" -- \
  app api db research models mockups infographics infra integrations cli \
  .design-overhaul .tmp-screenshots test-results docs/business docs/reports \
  ':(glob)**/.env' ':(glob)**/.env.production') || fail "cannot inspect paths"
if [ -n "$paths" ]; then
  echo "public-history guard: private-only paths found in reachable history" >&2
  status=1
fi
if [ "$status" -eq 0 ]; then echo "public-history guard: $sha ok"; fi
exit "$status"
