Deployment admission is closed by `node server/db/ingest-admission.mjs pause HOLDER` using the database owner.
The holder is a unique deployment identifier. A second deployment cannot replace it. There is no automatic expiry.
The migration installs triggers on new documents, upload sessions, runs and terminal-run readmission, so older API
instances are fenced too. Shared row locks held to admission transaction commit serialize with the pause update.
Runtime roles cannot modify the gate. Existing run status changes can finish while admission remains closed.

`drain HOLDER` polls nonterminal runs for up to four minutes; errors abort immediately. Blocked and paused runs
count as open. `resume HOLDER` rechecks ownership and zero open runs before opening. Failure leaves admission
closed. Deployment tooling must verify new worker readiness before resuming. Restore compatible runtime images
before reopening following a failed deployment. Tests exercise the real migration in an isolated PGlite database.
