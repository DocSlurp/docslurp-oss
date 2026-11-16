# Durable compute fleet admission

Provider inventory may lag a launch. Counting inventory and then creating a host can overshoot a fleet cap, even when an advisory lock serializes those operations. Migration 0181 instead reserves a durable database slot before a provider request.

Operators provision `compute_fleets` with an enabled identity and `max_active`. The identity must cover every worker sharing that provider fleet. Runtime application roles have no table access. Worker roles read limits and append or advance reservations, but cannot change limits, delete history, rename a fleet or resurrect a released reservation. Fleet `UPDATE(id)` permission exists only so admission can lock the policy row; an identity trigger refuses renaming.

The insertion trigger locks the fleet policy and serializes admission. It assigns a bounded slot and rejects a full, disabled or unknown fleet. A unique partial index on occupied slots also rejects stale-snapshot duplicate claims. Repeated reservation IDs consume no extra slot; released IDs remain tombstones. There is no automatic expiry: uncertainty cannot become free capacity merely because time passed.

`ExtractorPluginHost.computeAllocationAdmission` is bound to the worker Store at startup. Missing storage refuses admission. It exposes content-free reservation, allocation-ID recording and release operations. It is platform capacity bookkeeping, not tenant authorization or permission to stage a file. Existing document and execution authorization remains mandatory.

Adapters must:

1. Reserve a new UUID before launch and use the returned token for bounded provider-idempotent retries.
2. Persist the exact provider allocation ID before using it. Conflicting IDs fail.
3. Retain the reservation across ambiguous responses, controller crashes and failed cleanup.
4. Release as `not-created` only after definite non-creation, or as `provider-deleted` only after provider-confirmed deletion. A termination request, timeout, missing response or guest shutdown claim is insufficient.
5. Reconcile uncertain reservations independently, using provider evidence and the recorded idempotency token. Do not reclaim them by age.

The database cannot verify a provider API response. Release is a trusted control-plane obligation; parsing guests must never receive these callbacks or database credentials. This generic seam does not provision providers or change any adapter default.

Security review: independent agents `fleet_admission_adversarial` and `fleet_admission_independent` found two blocking issues, both addressed before merge: stale snapshots could ignore a later operator disable/cap reduction (fixed by locking the policy row, with real PostgreSQL tests), and custom application default ACLs survived migration (fixed by revoking nonowner table/column grants inside the migration, tested before reconciliation). The real PostgreSQL tests use the repository's standard database integration gate so CI cannot silently skip them.
