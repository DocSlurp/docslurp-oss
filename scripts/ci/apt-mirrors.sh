#!/usr/bin/env bash
# Point the runner's apt at several Ubuntu mirrors on independent domains, so one mirror's DNS or HTTP failure on
# GitHub-hosted runners does not fail the job. apt's mirror+file method tries the next line when one fails.
# The runner's sources already use mirror+file:/etc/apt/apt-mirrors.txt; packages stay signed by Ubuntu's archive key.
# The Azure HTTP mirror stays last: it can stall until the job expires.
set -euo pipefail
mirrors=(
  'https://archive.ubuntu.com/ubuntu/'
  'https://mirrors.edge.kernel.org/ubuntu/'
  'http://azure.archive.ubuntu.com/ubuntu/'
)
# List only the mirrors that resolve on this runner, in order, so apt does not wait out a dead mirror's timeout on
# every file; when none resolve, keep them all and let apt report the failure.
usable=()
for m in "${mirrors[@]}"; do
  host=${m#*://}; host=${host%%/*}
  if getent hosts "$host" >/dev/null; then echo "apt mirror $host resolves"; usable+=("$m"); else echo "::warning::apt mirror $host does not resolve on this runner"; fi
done
[ ${#usable[@]} -gt 0 ] || usable=("${mirrors[@]}")
printf '%s\n' "${usable[@]}" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
echo "apt mirrors in use: ${usable[*]}"
# Retries and timeouts for every later apt-get call, including Playwright's --with-deps install.
sudo tee /etc/apt/apt.conf.d/80-ci-resilience >/dev/null <<'CONF'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APT::Update::Error-Mode "any";
CONF
