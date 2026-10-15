#!/usr/bin/env bash
# Prints the Temporal worker Build ID for a local image build: the commit SHA,
# suffixed with -dirty when tracked files differ from it, so an image built
# from uncommitted code never claims a clean commit's Build ID.
set -euo pipefail
sha="$(git rev-parse HEAD)"
if git diff --quiet HEAD --; then
  printf '%s\n' "$sha"
else
  printf '%s-dirty\n' "$sha"
fi
