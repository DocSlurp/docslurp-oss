#!/bin/sh
# Apply DocSlurp's clamd scan policy to a clamd.conf in place: every line of POLICY replaces any line (commented or not)
# that sets the same option. POLICY must equal clamdLimitLines() in src/tools/clam-limits.ts (clamd-policy.test.ts checks).
# Used by worker/Dockerfile and the real-ClamAV docker tests. The worker still verifies the running daemon's effective
# policy with canaries before trusting it (src/tools/clamd-policy.ts).
set -eu
conf="$1"
POLICY='MaxFileSize 1024M
MaxScanSize 2000M
StreamMaxLength 1024M
MaxFiles 50000
MaxRecursion 17
MaxScanTime 300000
AlertExceedsMax yes
AlertEncryptedArchive yes
AlertEncryptedDoc yes'
keys=$(printf '%s\n' "$POLICY" | awk '{print $1}' | paste -sd'|' -)
# ArchiveBlockEncrypted is the deprecated name of AlertEncryptedArchive: drop it so it cannot contradict the policy.
sed -ri "/^#?[[:space:]]*(ArchiveBlockEncrypted|AlertEncrypted|${keys})[[:space:]]/d" "$conf"
printf '%s\n' "$POLICY" >> "$conf"
