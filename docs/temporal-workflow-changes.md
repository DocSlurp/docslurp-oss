# Changing Temporal workflow code safely

Workers deploy with a Fly rolling strategy, and a run can stay open for up to 24 hours
(`TEMPORAL_WORKFLOW_EXECUTION_TIMEOUT`). After a deploy, new workers pick up runs that
old code started and rebuild their state by replaying the recorded history through the
new code. If the new code issues a different sequence of commands, the workflow task
fails with a `NondeterminismError`. Temporal retries that task indefinitely, the run's
lease expires, and SQL marks the run failed while Temporal still shows it as running.

## What counts as workflow code

Anything bundled into the workflow sandbox:

- `worker/src/temporal/workflows.ts`
- the modules it imports: `shared.ts`, `page-fanout.ts`, `pipeline-workflow-plan.ts`,
  `workflow-stage-order.ts`, `document-shards.ts`, `stage-groups.ts`

Activity implementations (`activities.ts`, stages) are not replayed. You can change them
freely as long as their names and input/output shapes stay compatible.

These changes break replay of in-flight runs:

- adding, removing or reordering activity calls, timers (`sleep`, `condition` with a
  timeout), child workflows or signals sent to children
- renaming an activity, workflow, signal or query
- changing child workflow IDs, or how many children a run starts for the same input
- changing `WORKFLOW_STAGE_ORDER`. Runs without an explicit `stageOrder` fall back to it
- changing how many times `Math.random()` is called before a timer, or `Date.now()`
  arithmetic that decides a branch

Changing timeouts or retry policies in `proxyActivities` options, or the contents of
query results, does not affect replay.

## How to make the change

1. **Gate on workflow input** (the existing pattern). New behaviour keys off a field the
   API records in the start input (`slotGate`, `pageChildBatchSize`, `pageBundleSize`).
   Histories that started without the field keep their old command sequence. Use this
   pattern when the API can opt new runs in. If older workers would mishandle the new
   field, record it only when the whole fleet supports it: add a worker capability and
   gate the app on it (App and worker skew). That is
   how `stageOrder` with index-before-enrich and `groupableStages` are recorded.
2. **Otherwise, use `patched()`**:

   ```ts
   import { patched, deprecatePatch } from "@temporalio/workflow";

   // Release N: old and new code side by side.
   if (patched("vision-batch-prefetch")) {
     await activities.prefetchPages(input);   // new command
   }
   ```

   Patch IDs are permanent. Never reuse one, and do not reorder patched blocks.
3. **Retire the old branch in two steps.** Release N+1 calls
   `deprecatePatch("vision-batch-prefetch")` and keeps only the new branch. Ship it only
   after every run started before release N has closed: at least 24 hours after release N
   reached all workers, and
   `temporal workflow list --query 'ExecutionStatus="Running" AND StartTime < "<N deploy time>"'`
   returns nothing. In release N+2, remove the `deprecatePatch` call.

## Replay test and fixtures

`worker/src/__tests__/temporal-replay.test.ts` runs as part of `pnpm test` in CI. It
replays every history in `worker/testdata/temporal-histories/` against the current
workflow code, and checks that a deliberately incompatible workflow fails replay.

```bash
pnpm --filter @docslurp/worker test:temporal-replay
```

**If the test fails, fix the workflow, not the fixtures.** The failure is the
nondeterminism that in-flight production runs would hit. Guard the change with input
gating or `patched()` until the test passes against the old histories.

The fixtures are recorded by `worker/src/test/temporal-replay/record-histories.ts`. The
script runs the real workflows on Temporal's time-skipping test server (downloaded on
first use) with stubbed activities:

```bash
# Add a scenario, for example one that covers a new patched branch:
pnpm --filter @docslurp/worker temporal:record-histories <scenario-name>
# Re-record everything (deletes the existing fixtures first):
pnpm --filter @docslurp/worker temporal:record-histories
```

- **Add a scenario** when you add a workflow path, or a patched branch. Record only the
  new scenario name, so the old histories stay as regression coverage for runs that
  started on old code.
- **Re-record everything** only when you intentionally drop compatibility: for example,
  after a `deprecatePatch` cycle removes the old branch, or a breaking change ships with
  the fleet drained. In both cases no open production run may still carry the old
  history. State this in the commit message.

## Worker Build IDs and versioning

Every worker image carries its commit SHA (`DOCSLURP_GIT_SHA` build arg). `deploy-fly.yml`
passes `$GITHUB_SHA`, and the deploy script passes `scripts/worker-build-id.sh`,
which adds `-dirty` for uncommitted trees. `worker/src/temporal/worker-versioning.ts`
resolves the Build ID: `TEMPORAL_WORKER_BUILD_ID` first, then `DOCSLURP_GIT_SHA`, then
the SDK default (bundle checksum). The worker logs it as `buildId=` in its
`status=started` line.

`TEMPORAL_WORKER_VERSIONING` selects how the Build ID is used:

| Mode | Effect |
| --- | --- |
| `off` (default) | The Build ID tags pollers and workflow task completions, so the Temporal UI and CLI show which image ran each task. Task routing does not change. |
| `deployment` | The worker joins Worker Deployment `TEMPORAL_WORKER_DEPLOYMENT_NAME` (default `docslurp-worker`) as version `<name>.<buildId>`, with `TEMPORAL_WORKER_VERSIONING_BEHAVIOR` (`AUTO_UPGRADE` by default, or `PINNED`). |

### Build IDs in the capability handshake

Every worker registers its Build ID in `worker_capabilities` before it polls
(App and worker skew). The app compares it with the
Build ID Temporal reports for each live poller (`DescribeTaskQueue`): a mismatch, or a
poller with no fresh registry row, counts as a worker that supports no gated feature.
So a container that restarts with the same identity on a different image never inherits
the previous image's capabilities.

### Rollback story (versioning `off`)

- **In-flight runs** replay on whichever worker picks up their next task. That is safe
  for every change that follows this page (input gating, `patched()`, the replay test).
  The one unsafe case is rolling back past a release that added a `patched()` branch
  while runs started on it are open; see Rolling back.
- **New runs** only record gated input once every live worker supports it, so a rolled
  back (older) worker appearing on the queue switches new runs back to the old input
  within one cache period (15 s), without turning flags off.
- **Pinning** (each run finishes on the build that started it) needs `PINNED` versioning
  and blue/green worker apps, below. Until then, the guarantees above come from replay
  compatibility rather than routing.

### Rollout

1. **Now: `off`.** The first deploy changes only the Build ID label. Existing runs keep
   flowing because routing is unchanged. Replay safety comes from the CI replay test plus
   `patched()` or input gating.
2. **Later, optional: `deployment` with `AUTO_UPGRADE`.** This needs a human, because
   versioned workers receive no tasks until their version is made current. Turning the
   flag on without the step below stalls every run.
   - Confirm that the Temporal server (`temporalio/auto-setup:1.29.7` in
     `fly.temporal.toml`) has the Worker Deployment APIs enabled. Earlier releases gated
     them behind dynamic config (`system.enableDeploymentVersions`,
     `frontend.workerVersioningWorkflowAPIs`).
   - Add a deploy step that runs
     `temporal worker deployment set-current-version --deployment-name docslurp-worker --build-id "$GITHUB_SHA"`
     once the new machines are polling. Only then set `TEMPORAL_WORKER_VERSIONING=deployment`
     in `fly.worker.toml`.
   - `AUTO_UPGRADE` still moves in-flight runs to the new code, so the `patched()` rules
     above still apply. In exchange, you get version visibility, ramping
     (`set-ramping-version`) and quick rollback of the current version.
3. **`PINNED` only with blue/green worker apps.** A pinned run must finish on the version
   that started it, and its workers must stay up for up to 24 hours. Fly's rolling deploy
   replaces machines in place, so pinned runs would stall. `PINNED` requires two worker
   apps (or machine groups) that alternate per release, with the old one drained once it
   has no pinned runs left.
