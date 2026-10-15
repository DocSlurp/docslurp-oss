# Batch failure and retry policy

Apply this operator policy before expensive, batch, or long-running work: evals, builds, installs, downloads, data processing, and remote jobs. It governs admission and recovery, not candidate-visible instructions or model scoring. Existing stricter gates still apply; paid evals close admissions on the first infrastructure error under local remote operations.

## Define the stop contract before launch

Record the useful completion signal, expected duration and failure rate, cost and wall-time ceilings, maximum concurrency, retry allowance, and owner responsible for stopping the queue. Group work by shared failure dependencies: task/family, configured environment or image, host, provider/model route, and runner revision. A healthy group must not hide a broken group in the aggregate.

Preflight permissions, dependency availability, configuration, storage, credentials without exposing values, and required services using the cheapest available checks. Start with one representative canary per materially different environment before increasing concurrency. A launcher exit or a health endpoint alone does not prove useful work completed.

Require an admission gate that can stop pending work and retries across every worker. Use a coordinator check before each claim, a persisted stop state, or a bounded operator-supervised batch. If the runner cannot stop new work promptly, use small serial batches; do not launch an unattended large queue. Set observation frequency and batch size so one interval of failures cannot consume a material part of the budget.

## Budget validation overhead

Optimize for time to useful completion and fewer invalid attempts. A check with no model charges still consumes operator time, host time, and possibly rented infrastructure. Before adding a blocking smoke or canary, record the failure it detects, the evidence required to pass, its time/cost ceiling, and why existing evidence or a cheaper check is insufficient. A 3–15 minute check needs a concrete purpose proportional to the work it protects; a ten-minute gate before a fifteen-minute job normally needs redesign or an explicit necessity, not repetition by habit.

- Reject statically unsuitable work before execution: missing prerequisites, incompatible configuration, and absent required review or metadata should fail cheap admission checks. An eventual smoke-only classification is not evidence that executing the item was a useful preflight.
- Use the first real work item as the canary when it satisfies the frozen task, configuration, evidence, and approval contract. Count a valid completion toward the requested work. Keep directed diagnostics, synthetic checks, changed budgets, and other non-matching canaries separate; never relabel them as comparable results.
- Reuse a passed prerequisite check only with a recorded dependency fingerprint: relevant source/build, lockfile, image/environment, configuration, and check version. Record the evidence location and its validity conditions. Recheck affected dependencies after changes, and keep cheap fresh checks for volatile service health, available capacity, credentials/credit, and current authorization. Missing provenance or a relevant failure invalidates reuse. Mandatory fresh-target/reset, cleanup, and explicit full-gate requirements still apply.
- During repair, build the smallest deterministic reproduction of the observed blocker and verify the changed boundary before another full end-to-end canary. Run independent checks concurrently only when they cannot mutate shared state or obscure attribution. Complete any required full admission gate before resuming expensive work.
- Measure check duration, actual blocking wall time, infrastructure/model cost provenance, blocker caught, subsequent failure missed, and whether the result completed useful work or reused valid evidence. Summed row runtimes are not critical-path delay. Report avoided spend as unknown unless supported by an explicit counterfactual; do not claim savings merely because a smoke passed.

Review repeated or slow gates using those measurements. Consolidate duplicate checks and retain checks that cover distinct failure boundaries. Stop or diagnose an over-budget check under the same stop contract as the main job; validation is not exempt from runaway-work limits.

## Stop on evidence, not on exhaustion

**A 100% or near-total failure rate is an emergency stop condition, not a reason to finish the matrix, consume the retry budget, or wait out the timer.** Close admissions as soon as a shared blocker is credible. Thresholds below are fallback ceilings when the cause is initially ambiguous, never minimum waits.

| Observation | Required action |
| --- | --- |
| A deterministic setup blocker: required install denied, unavailable required package/library, unsupported runtime, invalid configuration, unfunded route, or unavailable required permission | Stop the affected queue immediately after the first confirmed failure. Change the approach or repair the prerequisite within existing authorization. Repeating the identical command is not a diagnostic. |
| Five consecutive failures with the same operational signature and no useful completions | Stop the affected group immediately. Inspect one full raw failure and the shared dependency before admitting another item. |
| At least 20 completed attempts in a rolling window with at least 95% operational failures | Stop the affected group and diagnose. For example, 499 failures out of 500 attempts in a minute requires immediate action; waiting ten minutes would be unacceptable. |
| Ten minutes without useful progress and at least five failures | Stop and reassess assumptions, even when the errors have different wording. A slower or more expensive job needs an earlier checkpoint or smaller canary, not five costly full-length failures. |
| Explicit budget, deadline, ownership, containment, or cleanup limit reached | Stop admissions immediately and enter the applicable cleanup procedure. |

Persist any task-specific thresholds and rationale before launch. A workload expected to reject most inputs can define rejection as a valid completed outcome; it still needs separate operational-failure and useful-progress counters. Valid low scores, candidate refusals, or a correctly delivered approval rejection are not automatically infrastructure failures. A shared lack of a required capability still warrants early diagnosis under the eval operations contract. Missing validity evidence is an admission failure until explained, not a low model score.

Count failures and retries from raw attempts, before eligibility filtering. Report attempted, eligible, non-eligible, pending, and completed counts separately. Inspect in-flight liveness and resource use as well as completed rows: silent hangs will never increment a completed-failure counter. Do not mistake a quiet client stream for a stalled worker while server-side work is progressing within its budget.

When stopping, persist the reason, affected groups, window counts, timestamps, signature, observed useful progress, known or estimated spend, and queued/in-flight identities. Freeze claims and automatic retries across workers. Reconcile already-running jobs before resubmission; let bounded healthy jobs drain only when they remain valid and within the stop contract. Cancel known-invalid or runaway owned jobs through their normal shutdown path, preserve partial evidence, and verify cleanup. A global provider, database, storage, or runner fault stops every dependent group; resume unaffected groups only after isolation is demonstrated.

## Retry only when something can improve

Classify the failure first. A retry is justified by a transient condition or a concrete changed prerequisite, never merely by remaining budget.

- For documented transient throttling, temporary service unavailability, or connection setup failure, use bounded backoff with jitter and honor `Retry-After`. Reduce admission rate or concurrency. Default to at most two retries per logical operation within the original time and cost ceilings unless a stricter contract applies.
- Keep one retry owner. Count SDK, worker, shell-loop, and coordinator attempts together so nested retries cannot multiply the allowance. A retry consumes the same failure-rate and spend budget as an initial attempt.
- For interrupted or ambiguous requests, inspect durable job/provider state first. Retry only when the previous attempt is confirmed stopped or the operation has a verified idempotency mechanism. A reconnect does not establish whether remote work or billing stopped.
- For deterministic permission, package, configuration, or capability failures, keep admissions closed. Record the changed assumption or exact repair and prove it with a cheap probe. If repair is outside available permissions, preserve a resumable blocked state and report the required action; do not repeatedly request the same denied operation or substitute an unapproved environment.

After repair, repeat the relevant zero-cost checks and run exactly one representative replacement canary with the original intended configuration and complete evidence. Reopen gradually only when the canary completes usefully and the failure signature is absent. The same failure returning after that canary closes the gate again and requires a new diagnosis; do not loop through repeated paid repair/canary cycles without new evidence. Preserve failed and replacement attempts as distinct records.

## Completion and cleanup

A stopped batch is diagnosed or blocked, not completed. Report the stop decision, useful and invalid work, remaining scope, repair/retry evidence, cost provenance, and cleanup status. Keep resource watchdogs active during diagnosis; repair must stay within the original budget and expiry. Retrieve evidence and remove only owned resources and credentials through the lifecycle contract. Verify teardown even when the main job fails.

This document is an operator contract. It does not establish that a runner implements an automatic circuit breaker; claim enforcement only after testing that runner's admission and cancellation behavior.
