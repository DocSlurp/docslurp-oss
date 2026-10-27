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
