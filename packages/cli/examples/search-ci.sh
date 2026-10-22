#!/usr/bin/env bash
# Usage: bash search-ci.sh 'How do retries work?'
# Searches the organization default workspace unless DOCSLURP_WORKSPACE (a workspace ID, slug or name) is set.
# Requires Node.js 20+, @docslurp/cli, jq, and a search-scoped API key.
set -euo pipefail
: "${DOCSLURP_API_KEY:?Set DOCSLURP_API_KEY}"
query="${1:?Pass a search question}"
result_file="$(mktemp)"
trap 'rm -f "$result_file"' EXIT

docslurp search "$query" --json --timeout 30 > "$result_file"
# Exit nonzero for an incomplete corpus or no evidence, even after HTTP success.
jq -e '.availability.status == "complete" and (.results | length > 0)' "$result_file" > /dev/null
jq '{sessionId, availability, results: [.results[] | {text, score, citation}]}' "$result_file"
