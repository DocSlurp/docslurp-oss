# Antivirus definition freshness

A container image copy can give old ClamAV definitions a recent filesystem
mtime. Startup now reads the signature timestamp reported by `clamscan --version`
for the configured definition directory. The metadata probe runs in UTC, accepts
only the native version/date format, and rejects missing, malformed or excessively
future timestamps. Startup applies the same precise freshness deadline used by
VM scans. A copied file cannot make an expired database pass this check.

Production workers also run FreshClam's native foreground daemon, checking for
updates twelve times per day. It uses the existing configured mirror and receives
only PATH, HOME, LANG and TZ. Database, object-store, model and authentication
credentials are excluded. FreshClam supplies its own update scheduling and
network retry behavior; no customer file is passed to the updater.

The entrypoint owns both the updater and worker. An updater exit stops the worker
with failure; worker exit status is preserved. TERM/INT are forwarded to the
worker, and updater cleanup follows worker shutdown. The managed path requires
Bash 5.1+, GNU date and timeout, available in the Debian worker images. An older
Bash refuses the managed path explicitly.

`DOCSLURP_CLAMAV_MANAGE_UPDATER=false` opts out when an operator supplies an
external updater. It defaults to true in production and false in development.
An explicit `DOCSLURP_CLAMAV_UPDATE_ON_STARTUP=false` (including its existing
`0`, `no` and `off` aliases) also leaves updates under operator control. Neither option disables the VM's per-scan freshness refusal.
The existing signature age limit and network-blocked, credential-free parser VM
boundary remain unchanged. Workers still copy only the named definition assets
into that VM; host scanning of customer files is not introduced.

Native updater reference: [FreshClam manual](https://github.com/Cisco-Talos/clamav/blob/main/docs/man/freshclam.1.in).

## Validation and independent review

The full entrypoint subprocess tests use synthetic tools and definitions, with
no network or customer data. They cover old headers with new mtimes, failed
refresh, missing/malformed/relative/future metadata, fractional age expiration,
non-UTC hosts, sanitized updater environment, updater failure, worker exit status,
TERM/INT cleanup, signals during child PID capture, and the external-updater opt-out.

Three independent read-only council reviewers inspected the security boundaries:
Architect `clam_architect`, Ruthless Minimalist `clam_minimalist`, and adversarial
Security `clam_security`. Architect and Minimalist reproduced a timezone mismatch;
Security also reproduced relative date acceptance. The coordinator forced UTC,
restricted the native format, aligned numeric versions with the guest contract,
and added timezone, malformed-version and signal lifecycle regressions. The
managed-path tool requirements are documented above. A final Architect review
also found that false startup-update aliases still launched the daemon; the
coordinator reused the existing boolean parser and added all four opt-out
regressions. A subsequent Security review reproduced a signal between forking the worker
and recording its PID. The coordinator queued TERM/INT until each new child PID
was captured, covering both worker and updater launches with deterministic race
regressions. Fresh final rechecks are recorded in the pull request before merge. Synthetic tests do not establish the
availability of any particular mirror or replace VM scanning acceptance.
