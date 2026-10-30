# LibreOffice launcher validation — 2026-10-30

Built worker/Dockerfile at 1b712db0 locally: image docslurp-pr234-runtime:1b712db0, manifest sha256:e6177897dd3f15c3126194a3ffd61fd0c84ef51363e4dbc062c7f1f430648c7d. Debian trixie, runtime UID 10001, no network, host mounts or credentials. Docker outer seccomp, AppArmor and masked system paths were disabled to permit nested namespaces; the worker launcher and its base seccomp filter stayed enabled.

The unchanged launcher aborted LibreOffice with UNO RuntimeException and produced no PDF. Debian links /usr/lib/libreoffice/share/registry/main.xcd and printer configuration into /etc/libreoffice. Repeating with only that directory added through DOCSLURP_PARSER_SANDBOX_READABLE_PATHS succeeded: a benign text document converted to PDF, exit 0. The launcher change adds the same directory as a read-only runtime mount; the image itself was not rebuilt after this change.

Cancellation: started headless LibreOffice listening on a socket inside its isolated network namespace, sent TERM to the launcher after two seconds. Exit 143 in 9 ms; no remaining soffice.bin process and no run-* sandbox directory. The javaldx warning was present in both runs; it did not prevent this conversion.

This validates one benign Writer conversion and bounded cancellation, not all Office formats, macro behavior or the broader VM isolation requirement. No production deployment was performed.
