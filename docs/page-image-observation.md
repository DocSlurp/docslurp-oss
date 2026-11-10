# Exact page-image observation

A pending `GET` or accepted `POST /v1/documents/:id/pages/:page/image` includes an
`observation` resource: `kind: page-image`, document ID, current run ID, page
number and `reader`/`export` quality. Initiation stays on HTTP. Observation never
starts, restarts or cancels rendering; the existing durable workflow and isolated
renderer remain responsible for execution.

Session-authenticated dashboard clients may subscribe to this resource on their
existing tab WebSocket. Its snapshot contains only the same resource and status:
`pending`, `ready` or `unavailable`. It has no signed URLs, artifact paths, page
text, source bytes or metadata. Page numbers are bounded to 1–999,999, IDs must
be UUIDs, and arbitrary DPI, tenant selectors and replacement fields are refused.
Each subscription and delivery uses current project/session authorization.
Changing the document's run invalidates the old resource.

The read-only query checks only the exact policy-selected artifact slot (and
already-supported reader aliases), excludes withheld artifact URIs, and requires
the run's organization and project to match the document. A live exact render
demand means pending; an absent/expired demand without an image means unavailable.
The snapshot is not a workflow error history. A client bounds waiting and reports
uncertainty instead of starting another render.

The renderer already commits `project_runs.artifacts` and removes its demand in
one transaction. Existing durable realtime revisions on `project_runs` publish
that readiness after commit. A rollback publishes nothing; reconnect snapshots
recover an image completed while offline. No new trigger, broker or job journal
is needed. The processing-only viewer projection remains unchanged.

After `ready`, fetch the original authorized HTTP image endpoint once for its
current URL and validate the same run reference. Image bytes and large artifacts
remain on demand. A healthy connection performs no periodic image GETs. When the
socket is unavailable, use the tab's existing serial bounded fallback owner for
read-only GETs; detach only releases observation. Recovery reads shared by several
viewers must have their own bounded timeout rather than any one viewer's abort
signal. A late observer needs an authoritative snapshot even after completion.

## Independent review and validation (2026-11-09)

Three separate council reviewers inspected the combined core/client diff:

- Architect: P2, shared recovery captured the first observer's abort signal.
- Ruthless Minimalist: independently reproduced that P2 using the actual shared
  client; the surviving observer's callback was never selected.
- Adversarial Security Paranoid: no actionable security findings after examining
  tenant/version scope, withheld artifacts, malformed fields, GET-only recovery,
  delivery authorization and teardown.

The client repair uses a ten-second recovery request independent of individual
observers, with the existing transport epoch and scope checks discarding stale
results. A two-observer regression aborts the first waiter, breaks the socket,
and recovers the second through the actual shared client. A separate regression
resnapshots a late page observer on the same connection. These coordinator
repairs are not presented as second independent reviews.

Executed checks: 16 focused server/database tests, 12 shared wire tests, and 17
client/component/transport tests passed. Database tests cover tenant denial,
committed versus rolled-back artifact updates, exact page and quality, withheld
artifacts, changed run and no signing/fetch side effects. Wire tests reject extra
scope/DPI/URL fields and oversized frames. Model calls and rendering were not
invoked. Production storage, proxy, executor and load acceptance remain separate.


Server typecheck and emitted build passed. The shared full suite initially had
1,195 passing tests and a telemetry pre-test build failure caused by missing type
narrowing in the new wire test. That test was corrected; the shared build and
25 wire/telemetry tests then passed. No production code was weakened or timeout
increased. Existing browser transport Node regressions: all 8 passed. Current
browser enabled build and original asset budgets passed; activation is not part
of this component proof.
