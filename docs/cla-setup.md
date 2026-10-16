# Contributor agreement automation

Organization members are exempt under their existing contribution/employment terms. The workflow can verify this exemption with GitHub's pull-request author association and commit authors, using its repository token when all commits belong to that member or an exempt bot. It does not execute pull-request code.

Other contributions fail closed until the CLA Assistant credentials are configured. Store `CLA_BOT_TOKEN` with read:org for the organization member allowlist and `CLA_SIGNATURES_TOKEN` scoped to Contents read/write on the private `DocSlurp/docslurp-cla-signatures` repository. That repository stores `signatures/v1/cla.json` on main. Review CLA.md and the workflow before enabling external contributions. Signature comments must be posted by the contributor; automation must not sign for a person.

The workflow runs on pull_request_target and issue comments, with no checkout of untrusted PR code. Contributor signature data stays outside this source repository.

Private organization membership may appear as CONTRIBUTOR in webhook payloads even for members. Repository administrators maintain the comma-separated `CLA_ORG_MEMBERS` variable from the authenticated organization membership API. Refresh it with `gh api orgs/DocSlurp/members --paginate --jq '.[].login' | paste -sd, - | gh variable set CLA_ORG_MEMBERS --repo DocSlurp/docslurp-oss` when membership changes, especially removals. This is the same organization-member exemption; an unlisted external author or a commit from another author still follows the full CLA service path. Do not populate this variable from PR input or broaden it to outside collaborators.

After updating the base-branch workflow, use `gh workflow run cla.yml --repo DocSlurp/docslurp-oss --ref main -f pull_request_number=<number>` to verify an existing PR. Manual verification fetches its author and commit metadata from GitHub; it never checks out PR code or signs a contributor agreement.
