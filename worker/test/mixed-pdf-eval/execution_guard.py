"""Where this harness may run, and on what (README.md, "Inputs and execution").

The harness OCRs with the worker's PP-OCR CLI under parser-sandbox.sh (bubblewrap). Bubblewrap is not the isolation
boundary for customer bytes: in DocSlurp's service, customer files are OCR'd only in a VM. So the harness reads only
generated or public fixtures, or files the operator owns, from declared data roots, and refuses to run under the service
profile.
"""
import os
from pathlib import Path

DATA_ROOTS_ENV = "MIXED_EVAL_DATA_ROOTS"
REPO_FIXTURE_ROOT = Path(__file__).resolve().parent  # generated fixtures and test data beside the harness


class ExecutionRefused(RuntimeError):
    pass


def data_roots(env=None):
    """The roots inputs may come from: this harness's directory plus MIXED_EVAL_DATA_ROOTS (absolute, os.pathsep-separated)."""
    env = os.environ if env is None else env
    roots = [REPO_FIXTURE_ROOT]
    for raw in (env.get(DATA_ROOTS_ENV) or "").split(os.pathsep):
        raw = raw.strip()
        if not raw:
            continue
        if not os.path.isabs(raw):
            raise ExecutionRefused(f"eval-data-root-not-absolute: {DATA_ROOTS_ENV} entries must be absolute paths")
        roots.append(Path(os.path.realpath(raw)))
    return roots


def assert_eval_execution(*inputs, env=None):
    """Refuse the service profile, and any input (resolved through symlinks) outside a declared data root."""
    env = os.environ if env is None else env
    if (env.get("DOCSLURP_SERVICE_PROFILE") or "").strip().lower() == "service":
        raise ExecutionRefused("eval-refused-under-service-profile: this harness is for customer-owned or public fixtures; "
                               "service customer files are OCR'd only in the VM boundary")
    roots = data_roots(env)
    for item in inputs:
        resolved = Path(os.path.realpath(item))
        if not any(resolved == root or root in resolved.parents for root in roots):
            raise ExecutionRefused(f"eval-input-outside-data-roots: {item} is not under this harness or {DATA_ROOTS_ENV}")
    return roots
