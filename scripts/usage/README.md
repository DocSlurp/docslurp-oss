# Reconcile vision provider receipts

After delayed OpenRouter receipts become available, run:

```
pnpm exec tsx scripts/usage/reconcile-vision-receipts.ts ORG_ID PROJECT_ID
```

Requires `DATABASE_URL` and the OpenRouter key used for these platform calls.
This is an explicit operator action, not an automatic scheduled production job.
Each invocation examines at most 100 scoped ledger rows and replaces provider
cost metadata only when all attempts have known charges. Customer credit columns
are never changed. Repeated invocation is idempotent; concurrent metadata changes
are skipped via compare-and-swap. Incomplete rows remain unresolved, retaining
their estimates and original generation IDs. No response ID means reconciliation
cannot establish an actual charge; do not label that request free.

This command handles OpenRouter vision attempt records, not direct-provider
invoices or historical records whose attempt IDs were discarded. Use the matching
account credential; BYOK upstream amounts are included only when confirmed.

Each response includes `nextCursor`. Pass it as the third positional argument to
advance past the examined batch, including unresolved rows. Continue until it is
null. A later reconciliation sweep starts without a cursor to revisit delayed
receipts. This explicit traversal prevents old missing-ID rows from starving later rows.
