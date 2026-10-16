# Contributor agreement automation

Organization members are exempt under their existing contribution/employment terms. The workflow can verify this exemption with GitHub's pull-request author association and commit authors, using its repository token when all commits belong to that member or an exempt bot. It does not execute pull-request code.

Other contributions fail closed until the CLA Assistant credentials are configured. Store `CLA_BOT_TOKEN` with read:org for the organization member allowlist and `CLA_SIGNATURES_TOKEN` scoped to Contents read/write on the private `DocSlurp/docslurp-cla-signatures` repository. That repository stores `signatures/v1/cla.json` on main. Review CLA.md and the workflow before enabling external contributions. Signature comments must be posted by the contributor; automation must not sign for a person.

The workflow runs on pull_request_target and issue comments, with no checkout of untrusted PR code. Contributor signature data stays outside this source repository.
