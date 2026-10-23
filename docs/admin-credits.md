# Administrator promotional credits

Platform administrators can open `/app/admin` to find organizations by name,
ID, or owner email and issue up to $100 per request. Organization owners and
organization admins cannot issue credits. API keys are not accepted: the API
requires an authenticated platform administrator session and the normal cookie
mutation origin checks.

`POST /v1/admin/billing/credits` accepts:

```json
{
  "requestId": "2a5f1819-67d3-4966-b926-5e319c39a0da",
  "orgId": "organization-id",
  "amountCents": 10000,
  "reason": "Acceptance testing allowance"
}
```

This creates a Stripe Billing Credit Grant, category `promotional`, denominated
in USD, with no expiry and no charge to the customer. Its metadata records the
request, organization, administrator and reason. The grant ID is mirrored into
DocSlurp's prepaid ledger using the same idempotent reconciler as Stripe webhooks.
A credit is one cent. These promotional grants fund the organization's access;
credits belong to the organization, not an individual user.

Stripe grants apply to metered subscription invoice lines, not one-off Checkout
purchases. DocSlurp currently sells no metered Stripe subscription prices, so the
Stripe grant records the promotional allocation; DocSlurp's ledger tracks actual
consumption. Stripe's displayed balance is therefore not a live DocSlurp balance.
This is not a customer invoice balance adjustment, refund, payment, or credit note.
Do not later introduce metered invoices that independently consume these same
grants without reconciling the two ledgers.

Request receipts are permanent and retain the actor, original parameters,
customer, Stripe grant ID and completion time, including after account deletion.
Audit log events record requested and completed attempts. The server rejects
request IDs reused with different parameters or administrators. Concurrent
requests serialize on the normalized UUID. Webhook delivery before or after
synchronous mirroring cannot double the local credit. Migration 0071 serializes
reconciliation by grant ID in a transaction and persists terminal void tombstones,
including voids that precede any local grant. Stale create responses or delayed
created webhooks cannot resurrect a voided allocation. Audit metadata keeps
`creditRequestId` separate from the HTTP `requestId`.

The browser saves unfinished requests under separate UUID keys before sending,
exposes every unfinished entry after reload and removes only the successful UUID.
Concurrent tabs cannot overwrite or delete another request's recovery receipt.
A server `credit_request_rejected` response proves the organization was absent
before any receipt or issuance; only that rejection unlocks the form automatically.
All uncertain outcomes remain recoverable. On any timeout or incomplete response, retry the **same request ID** and
payload. Do not create another request to bypass an uncertain result. Stripe
idempotency keys can be removed after 24 hours, so an uncertain request with no
recorded grant ID stops automatic retries after 20 hours. A request with a saved
grant ID retrieves that grant rather than creating another, even after that time.

For `credit_reconciliation_required`, look up `requestId` in Stripe grant metadata
and the `admin_credit_requests` receipt. If a grant exists, verify its customer,
amount and actor before recording that ID through an operator-reviewed database
repair and retrying. If no grant is found, establish that the original call did
not succeed before authorizing any replacement. A voided grant or changed customer
ownership also requires reconciliation. There is no automatic replacement grant.

The $100 cap applies per request; this interface is privileged and is not a
campaign budget manager. An operator issuing a limited campaign must maintain its
recipient ledger and overall budget separately.

Sources verified 2026-10-23:

- [Stripe create credit grant](https://docs.stripe.com/api/billing/credit-grant/create)
- [Stripe billing credit eligibility and ledger](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
