# Feedback and bug reports

Signed-in users can send feedback or report a bug from the app. The dashboard
posts each report to `POST /v1/feedback`. The server stores it and, for high
severity, alerts the team live.

## Where reports go

- **Database:** every report lands in `feedback_reports` (migration 0088) with
  its organization, workspace (when the reporter can reach it), user, category,
  severity, message, route, screen name, trace ID, request ID, public error
  code, client timestamp and timezone, user agent and server build
  (`DOCSLURP_GIT_SHA`, else `FLY_IMAGE_REF`). Each report gets a reference
  such as `FB-7KQ2-M9XD` that the user sees and can quote.
- **Telemetry:** each stored report emits a `[feedback] stored ...` log line and
  an OTLP log event `docslurp.feedback.report`. The event carries the reference,
  severity, category, alert outcome, org, user, workspace, trace ID and request
  ID. It never carries the message text. In SigNoz, filter logs on
  `event.name = docslurp.feedback.report`, and open the reported trace by its
  `docslurp.feedback.trace_id`.
- **Live alert (high severity only):** the server sends the alert through the
  same channels as operational alerts: Telegram and/or `ALERT_WEBHOOK_URL`. The
  alert carries the reference, org name and ID, user email, category, screen,
  route, error code, trace ID, request ID, a SigNoz trace link (when
  `SIGNOZ_UI_URL` is set) and a 280-character excerpt of the message.

Normal-severity reports are stored and logged only. They are not emailed.

## Configuration

Check these variables for presence only. Never print their values.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID` (else `TELEGRAM_CHAT_ID`) | Telegram delivery. Requires `NODE_ENV=production`. `ALERT_TELEGRAM=off` turns it off. |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_FORMAT` | Slack-compatible `{ text }` webhook (default), or a structured `json` payload with `kind: "feedback_report"`. |
| `ALERT_ENVIRONMENT` | The environment label in the alert. Defaults to the Fly app name. |
| `SIGNOZ_UI_URL` | Base URL of the SigNoz UI (https). Alerts then link to `<SIGNOZ_UI_URL>/trace/<traceId>`. |
| `FEEDBACK_ALERTS=off` | Stores high-severity reports without paging, and leaves operational alerts unchanged. |

If no channel is configured, a high-severity report is stored with
`alert_status = 'unconfigured'` and the server logs an error. The user sees a
message saying the live alert didn't go through and the report is in the
support queue.

## Abuse controls

- Only signed-in app sessions can file reports. API keys cannot, so a leaked or
  automated key cannot page the team. Unauthenticated requests get 401.
- **Rate limits** count over a rolling hour: 20 reports per user (across all
  their orgs) and 100 per org. Over either limit, the server answers `429
  rate_limited` with `Retry-After` and stores nothing.
- **Paging limits** also count over a rolling hour: 3 live pages per user and 10
  per org. A high-severity report that repeats the same user's text from the
  last 24 hours does not page either. Case, whitespace and the prefilled `When:`
  line are ignored when comparing. Such reports are still stored
  (`alert_status = 'suppressed'` with `alert_suppressed_reason`), and the user
  sees "The team already has your high-priority report".
- Counting and inserting run under transaction-scoped advisory locks on the user
  and the org, so concurrent submissions cannot slip past a cap.
- Messages are capped at 4,000 characters and the request body at 16 KB.
  Route query strings and fragments are dropped. A malformed trace ID, request
  ID, error code or timestamp is discarded, not stored.
- **Alert text** is plain text. Telegram receives it without a `parse_mode`.
  Slack-style webhooks receive `&`, `<` and `>` entity-escaped, so `<!channel>`
  and `<url|text>` stay literal. Every user-controlled value is flattened to
  one line, so a report cannot forge alert fields. Control, zero-width and bidi
  characters are removed, and URLs are defanged (`hxxps[://]example[.]com`).

## Tenant scope

A report names a workspace or org only when the reporter can reach it: a
workspace through the normal workspace access check, an org through
membership. Otherwise the report is filed under the reporter's personal org.
The response is the same either way, so the fields reveal nothing about
other tenants. `GET /v1/feedback` lists only the caller's own 20 most recent
reports.

## Trace IDs

Every API response carries a W3C `traceparent` header when tracing is active.
The trace ID is its second field. The CORS policy already exposes this header,
and native error envelopes keep their `requestId`. The app records both from
failed responses and prefills them into the report, so support can open the
trace without the user ever seeing raw error text.
