# New aggregate authorization: $20, execution not delegated

After exact-image publication succeeded, the user stated **“allow $20”**. The
parent clarified that this replaces the prior $0.05 cap with a **$20 aggregate
cap covering publication, import, provisioning/startup, storage and the smoke**,
including associated network costs.

The constraints remain: **one synthetic Modal VM, 60-second expiry, no retries,
no deployment**. The reviewed image remains unchanged; no rebuild was authorized.
This implementation task is delegated documentation work only, with no authority
to access credentials, publish, launch or sign.

The parent architect is reassessing a defensible aggregate upper bound. No
revised admission clearance or VM launch has been reported. Raising the budget
does not itself supply missing import, retained-storage or startup bounds.

`budget-authorization.json` records the new authorization separately. The original
$0.05 failure remains in `publication-attempt.json` and
[operational-attempt.md](operational-attempt.md). The successful image publication,
verified hashes, private package visibility and pending keyless signing remain
in [publication-success.md](publication-success.md).

Latest authorization supersedes the earlier QA expiry: **one VM up to 1,800
seconds**, $20 aggregate, no retries and no deployment. The user accepts the
account limit and waives shared-spend-limit investigation; unknown workspace
budget enforcement is no longer an admission stop. The coordinator will launch
only after two independent runner reviews and registry/signing readiness. This
child prepares and mock-tests [the one-shot runner](modal-smoke-runner.md), with
no credential access or execution authority. Production expiry remains 60 seconds.
