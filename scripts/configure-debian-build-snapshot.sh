#!/bin/sh
# Debian indexes available by 2026-11-19 22:00 UTC. Refresh the timestamp and all
# three signed InRelease hashes together when rolling the base images forward.
set -eu
grep -qx 'VERSION_CODENAME=trixie' /etc/os-release
test -s /usr/share/keyrings/debian-archive-keyring.pgp

# APT still verifies Debian signatures. An immutable snapshot can outlive the
# mirrors' expiry, so also bind every update to the exact signed indexes.
snapshot=20261119T220000Z
cat > /etc/apt/sources.list.d/debian.sources <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$snapshot/
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
Check-Valid-Until: no

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/$snapshot/
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
Check-Valid-Until: no
EOF
cat > /etc/apt/docslurp-snapshot.sha256 <<EOF
0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675  /var/lib/apt/lists/snapshot.debian.org_archive_debian_${snapshot}_dists_trixie_InRelease
6f57bff7c8bf51425b0d654b57a93a8cf83f07a6a5d6116ee766f4612336c642  /var/lib/apt/lists/snapshot.debian.org_archive_debian_${snapshot}_dists_trixie-updates_InRelease
0a8f0fa42b0fc24d8b96a59c3ca091038cd12123bd0762c399be7ec7b038061d  /var/lib/apt/lists/snapshot.debian.org_archive_debian-security_${snapshot}_dists_trixie-security_InRelease
EOF
cat > /etc/apt/apt.conf.d/81docslurp-snapshot <<'EOF'
APT::Update::Error-Mode "any";
APT::Update::Post-Invoke-Success { "sha256sum -c /etc/apt/docslurp-snapshot.sha256"; };
Acquire::Retries "5";
EOF
