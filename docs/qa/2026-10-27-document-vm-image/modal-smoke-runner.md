# Coordinator one-shot QA runner — prepared, not launched

Latest user authorization replaces the earlier 60-second QA lifetime with
**1,800 seconds**, retaining **one VM, no retries, $20 aggregate, no deployment**.
The user accepted the account limit and waived further shared-spend-limit
investigation. Missing workspace-budget enforcement is no longer a stop condition.
This child has preparation/mock-testing authority only; it has not authenticated,
imported an image or created a VM. Production's 60-second executor is unchanged.

## Files and dry validation

- `scripts/document-vm/modal_smoke.py`: default plan-only CLI, pinned identities,
  one-create control loop, durable attempt lock, evidence collector and Python
  Modal 1.6.2 adapter supporting the coordinator's existing CLI-profile auth.
- `scripts/document-vm/guest_smoke.py`: trusted synthetic helper staged only in
  `/job`; it copies assets into `/job/tampered` for refusal tests and never writes
  canonical assets.
- `scripts/document-vm/test_modal_smoke.py`: seven mock-only test methods.
- `modal-smoke-plan.json`: actual default-plan output, including runner bundle
  fingerprint for two independent reviews.
- `modal-smoke-dry-validation.log`: all 13 preparation/integrity/mock tests pass.

The Python adapter follows the reviewed campaign's fixed image, `env -i`, hard
CPU/memory limits, mandatory identity, bounded streams, absolute control deadline,
late-create recovery and terminate/poll cleanup. The production TypeScript
executor creates a fresh VM per operation and cannot supply all QA cases in one
VM; it is not changed. The runner extracts and hash-checks its actual
`IMAGE_PROGRAM`, executes the actual image's `vm_entry.py`, and uses Python's
public SDK rather than requiring environment-token auth in JavaScript.

Public Modal 1.6.2 package source was inspected locally, not imported with a live
profile: `Client.from_env`, `App.lookup(create_if_missing=False)`,
`Sandbox.create(runtime="vm", cpu=(2,2), memory=(1024,1024), timeout=1800)`, binary
`exec`, filesystem writes, `terminate`, and `poll`. No new SDK/API live readiness
claim is made from mocks. No App is created/deployed; an existing coordinator-
approved App name is required.

## Two-review gate and coordinator command

Default mode is safe to run without Modal installed and does not import its SDK:

```sh
python3 scripts/document-vm/modal_smoke.py
python3 -m unittest discover -s scripts/document-vm -p 'test_*.py' -v
```

Before coordinator execution, obtain two independent approvals for the exact
runner fingerprint and image, including an adversarial reviewer. Fill a separate
review JSON from `modal-smoke-reviews.template.json`; its pending decisions
intentionally fail the execution gate. Source changes invalidate the fingerprint.
The parent also owns package/public pull and signing-policy readiness; pending
GHCR browser/Actions access is not bypassed with registry credentials or a rebuild.

Use the same Python interpreter/environment that owns the coordinator's
authenticated Modal CLI **1.6.2**, optionally selecting its existing profile via
`MODAL_PROFILE`. Credentials stay on the coordinator; no `.env` is parsed or copied.
After reviews and parent readiness, the coordinator's concrete invocation is:

```sh
python scripts/document-vm/modal_smoke.py --execute \
  --app EXISTING_APPROVED_APP \
  --reviews /absolute/path/to/completed-reviews.json \
  --output "$PWD/.cache/document-vm-image/one-modal-smoke"
```

Do not run that command in this child. The default persistent lock is
`.cache/document-vm-image/modal-smoke-attempt.lock`. It is consumed before SDK
initialization and is never automatically removed. Reusing the lock refuses
before a second client/create. Do not delete it to retry a failed or uncertain
attempt. The evidence output must also be new.

## Same-VM work and evidence

One named/tagged sandbox receives the exact image manifest `66a14b94…`, CPU hard
2, RAM request/hard limit 1,024 MiB, `runtime="vm"`, 1,800-second provider expiry,
no GPU, blocked network, no OIDC token, secrets, volumes or network filesystem.
Full image/index/bundle/profile pins are in `modal-smoke-plan.json`; the synthetic
input is hash-pinned to the retained 800×1000 generated image. The guest receives
only that raster and the reviewed helper, never credentials or customer files.

Cases execute sequentially in the **same single VM**: actual model/source/profile
validation with bounded declared-output transfer; lossless WebP encode/decode and
exact RGB equality; missing/wrong model identities; malformed, over-edge, animated
and >25 MiB inputs; tampered copied graph refusal; canonical bundle before/after;
outbound-connection failure; and resource observations. Every negative case must
exit nonzero with the expected refusal, not merely crash for an unrelated reason.
Canonical model assets are hashed again after the copied-graph test.

Commands are bounded to at most 55 seconds each; binary stderr/stdout caps are
16 KiB except the explicit 10 MiB layout-output transfer. The host absolute work
deadline is 1,800 seconds including auth/app lookup/lazy import/create and all
cases, followed by at most 30 seconds for cleanup; an OS alarm bounds a stuck SDK
beyond that reserve. Provider expiry independently protects against host loss.
An ID returned late within the reserve is captured and terminated, never replaced.
Lost IDs or failed termination are reported as `cleanup-unverified-no-retry`.

`state.json` is atomically checkpointed before create and at each case. It records
run/name tag, sandbox ID immediately on return, host-observed request/return/work/
termination timestamps, exact resource/identity request, per-case exit/bytes/time,
and provider poll exit status. Layout JSON, pixel hash, guest resource observations,
network result and capped guest stderr are retained separately. Raw provider
exception strings, profile config and credential-bearing output are not saved.

Termination is not claimed from an acknowledgement: the runner calls terminate
then polls within its cleanup reserve until the provider reports an exit code.
If unverified, retain the evidence and reconcile **that same ID/name** from the
coordinator; never recreate. Provider-enforced expiry is a backstop, not a receipt.

Public SDK 1.6.2 does not expose per-sandbox billed usage in this interface.
`providerUsage.billedUsd` therefore remains null, explicitly requiring coordinator
reconciliation against the captured ID/time; workspace-wide usage is not falsely
attributed and no shared-budget investigation is performed. The known maximum
30-minute allocation compute estimate is **$0.153918**, before region/import/
storage/network. The $20 user authorization is recorded, not represented as an
automatically enforced account billing ceiling. No model-provider call is made.
