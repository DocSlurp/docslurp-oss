# PostGIS migration ownership

Install PostGIS using the supported privileged database connection. Keep the
application migration connection on the nonsuperuser application owner.
`assertMigrationOwner` requires CREATE on public and ownership (including usable
role membership) of every public application table. It excludes only relations
whose PostgreSQL extension dependency identifies membership in `postgis`.
A table named `spatial_ref_sys` without that dependency is not exempt.
This does not grant privileges, transfer ownership, install an extension, or
weaken the worker/runtime role. Other extension-owned tables remain subject to
the existing ownership check.

Regression: `bash scripts/postgis/migration-owner-test.sh` runs a digest-pinned
PG17.11/PostGIS3.6.4 container without networking, installs PostGIS as postgres,
then invokes the actual migration entrypoint twice as a nonsuperuser owner.
It checks foreign application-table rejection, same-name nonmember rejection,
restricted-role rejection and publication/correction lifecycle. The backend OS
is Debian, while production's reported PostgreSQL build uses Ubuntu.

Threat model: an unprivileged caller must not bypass migration ownership by
naming a table after an extension object. The exemption uses pg_depend's exact
relation/class, extension reference class and extension-membership dependency,
not text names or broad schema ownership. Altering PostGIS membership requires
privileged extension ownership; this check is not an authorization boundary
against a database superuser.
