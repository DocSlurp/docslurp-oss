# Funding, processing pauses and credit alerts

DocSlurp uses prepaid credits. There is no Silver plan to upgrade to. Starter
accounts see **Add credits**, funded accounts see **Buy credits**, and ordinary
members are directed to an organization owner, administrator or billing member.
These are interface choices; existing server billing authorization still controls
who can pay or change billing settings.

Processing leaves the configured chat/search reserve untouched. A processing
pause therefore does not claim that every credit is gone, or that chat/search
remain available without limit. Native 402 responses expose reviewed numeric
facts (`availableCredits`, `heldCredits`, `chatReserveCredits`) and closed
`spendKind`/`account` labels. Arbitrary provider messages remain suppressed.
Run records expose only the closed spend pause codes. Headers, the composer and
Activity distinguish funding pauses from stalled workers.

## Automatic resume

Existing `org_spend_changed` notifications request a debounced organization sweep;
the existing maintenance interval remains the fallback after listener outages.
Each resume serializes on the run ID and rechecks spend eligibility inside a
transaction. A refused lease, database failure or failed Temporal resume signal
rolls back the pause change, lease and progress event. Subsequent sweeps retry.
A successful resume writes one progress event; repeated sweeps see an unpaused
run and do nothing. Manual resume keeps the existing workspace access checks and
cannot fall through to the operator resume when delivery is deferred.

The transaction includes signal delivery, so a slow Temporal service can hold a
run row lock until the RPC finishes or fails. An ambiguous successful signal
followed by a database rollback is retried idempotently; durable pause state
remains the recovery source of truth.

## Operator alerts

The existing elected alert evaluator now observes recently active organizations
with credit grants, plus organizations with credit-paused runs. Billing-exempt
organizations and deployments with billing disabled are excluded.

- `credits-running-low:<orgId>` warns when processing-available credits (available
  minus live leases minus the chat reserve) are at most 100 credits ($1). At zero
  or less it escalates to critical immediately, even during the normal cooldown.
  Funding above that margin emits one resolved notification.
- `credit-resume-delayed:<orgId>` warns when processing credits are available but
  credit-paused runs have remained paused at least two minutes. It resolves once
  they resume. This separates financial recovery from workflow recovery.

Both use the existing consecutive-evaluation filter, repeat cooldown and leader
lease. Defaults remain two evaluations, one minute between evaluations and four
hours between reminders. A failed credit snapshot does not resolve existing
alerts. Alert state and failed delivery receipts are in memory; a process/leader
restart can send another first alert. This is not a durable notification outbox.

Notifications use the existing Telegram bot (`TELEGRAM_BOT_TOKEN` with
`ALERT_TELEGRAM_CHAT_ID`, falling back to `TELEGRAM_CHAT_ID`;
`ALERT_TELEGRAM=off` disables it). Telegram success requires both HTTP success
and JSON `ok=true`. Failed sends, including recovery notifications, remain pending
and retry at most once each evaluator tick. A newer transition replaces an
obsolete pending message. Tokens and token-bearing URLs are never logged.
Startup reports whether Telegram configuration is available.

Every firing/recovery notification emits the existing structured `[alert]` log
line, which the deployment's OTLP log pipeline ships to SigNoz. Delivery result
and pending-delivery lines are visible alongside it. There is no direct SigNoz
HTTP write or new scheduler. Production validation must confirm configured
Telegram delivery and actual SigNoz log ingestion; local tests use fake transport
and do not establish either external service's readiness.
