# PR184 second repair: fail closed on unsupported router margins

The default enabled active router retains its 0.5 margin floor. Once-per-page revenue allocation is still unavailable in the router: provider and compute receipts are cost-only, Rich page reads deduplicate in the usage ledger, and remaining page charges settle at completion. No resource list revenue or per-assignment page revenue is invented.

Active routing now refuses positive margin floors with `page-router-incomplete` before probing or model calls. Stored active plans with positive floors or budget deferral/skip evidence also fail at loading, before render or vision can return no pixels successfully. Planning refuses budget-stripped active artifacts outside the ordinary fail-open handler. Shadow planning remains observational.

This is the explicit unavailable/failure alternative, not a functional implementation of default margin routing. Actual once-per-page revenue allocation remains future work. No floor, plan, rate-card, infrastructure observation or billing receipt code changed.

Regression: the real budget guard strips extract-text, math and table assignments under a $1 budget and the default .5 floor; both render and vision reject these artifacts. Lowering the resumed state's floor to zero still refuses the already stripped artifact. New default planning preflight rejects before probe/model/storage and leaves zero new receipts. Existing execution tests explicitly select the supported zero floor to test execution independently.

Live gate at 2026-10-27 14:35 UTC: PASS using existing root credentials loaded privately. All seven sources, including Fly inventory and Vast offers, succeeded. Vast L4 and H100-SXM had no matching offers and remain unverified; OpenRouter pass-through has no independent comparable SKU. Retain earlier evidence in pricing-revenue-parity-2026-10-27 unchanged: its missing-credential finding describes that earlier run only. Inventory showed eight workers, one started; no launch, mutation or paid model call was performed. See live-validation.json for observations and inventory.

Validation: final router/stage, AI usage, attribution parity, tenant-column, page-base-fee and pricing-profile suite: 360 passed, 2 skipped across 41 files (40 passed, 1 skipped). Worker TypeScript --noEmit passed. Public-history guard passed against origin/main. Worker package compilation and routing-asset copy are checked before handoff. A prior pinned-route pricing test needed proper property narrowing for TypeScript; its runtime assertion is unchanged.

Threat model: prevent silent success with omitted scanned, math, table or inset content when cost-only receipts cannot satisfy a positive floor. No tenant scope, identity, credential distribution, parser invocation or billing-debit changes. Coordinator independent review remains required before merge; this repair does not approve merge or deployment.
