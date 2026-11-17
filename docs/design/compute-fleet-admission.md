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

## Fair job admission (migration 0186)

Provider reservations cap hosts. Jobs that share those hosts (slots on a warm OCR host, jobs on a reader VM) need their own fleet-wide cap, with fairness between organizations; per-process counters multiply with the worker count. `ExtractorPluginHost.computeJobAdmission` provides it:

- Operators provision `compute_job_fleets` (`max_jobs`, `max_jobs_per_org`, `enabled`). A missing or disabled row refuses (`register` false, `admit` `unavailable`, `demand` null). Worker roles cannot change it; the API role reaches neither table nor function.
- A job registers a content-free ticket: a hashed organization key (never the id; a per-fleet sha256, not a secret-keyed MAC), its measured page count and a lease. `routing` tickets are demand only (a job still choosing its host); `waiting` tickets are in the fair queue.
- `admit` (SQL `compute_job_admit`, serialized per fleet) drops expired tickets, then fills free slots: each goes to the waiting ticket whose organization holds the fewest admitted jobs, under its cap, oldest first. One organization's burst cannot starve another's single job, and no organization passes `max_jobs_per_org` across the whole fleet.
- Holders renew the lease while they run. A crashed worker stops renewing; its tickets expire and the slots return. Unlike provider reservations, a ticket holds no provider resource, so expiry is safe; a holder whose `renew` returns false has lost its place and must not count on it.
- `demand` returns the asking organization's tickets by state and the fleet's aggregate (no per-organization breakdown), for routing decisions.

Ticket rows never carry content, document ids or tenant ids, and never authorize file access; the provider's own authorization and isolation still apply.
