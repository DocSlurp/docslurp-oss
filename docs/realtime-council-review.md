# Realtime council review evidence

Status: implementation and reviews in progress; not merge approval.

## Security Paranoid — GPT-6-astra, integrated core 5b2dc6d5

- High: activity delivery checked organization membership but could expose a
  captured private-workspace run after workspace membership removal. Repair:
  authorize the bounded set of constituent workspace IDs again before delivery;
  missing collection authorization support fails closed.
- Medium: unrelated successful session checks could extend a stalled resource
  verification sweep forever. Repair: track the last completed resource sweep
  independently and close on its deadline.
- Medium: timed-out Upgrade authentication retained the pending connection
  reservation. Repair: exactly-once cleanup on timeout, close and settlement,
  cancellation signal, and a separate cap of 32 outstanding authentication calls.
  Non-cooperative providers retain their work slot until settlement, so timeout
  cannot create unbounded abandoned authentication work. Better Auth lookup itself
  has no cancellation API; later lookup phases stop on abort and the explicit
  database liveness query is cancelled. Existing connections share concurrent
  session checks within each socket.

Validation: 40 focused socket/backend/operation/auth tests passed. Regression
cases cover membership removal during projection, a stalled resource alongside
healthy session checks, 544 timed-out cooperative authentication attempts followed
by a successful connection, and capped abandoned work for an uncooperative provider.
The adapter also prevents a stale revocation callback removing a newer subscription
generation. Independent final recheck remains required.
