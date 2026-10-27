"""Bound a local Docker case and remove its unique daemon-owned container."""
import subprocess
import uuid


def run_container(base, command, timeout=65, cleanup_timeout=5):
    name = 'docslurp-image-case-' + uuid.uuid4().hex
    invocation = base[:-1] + ['--name', name, base[-1]] + command
    try:
        result = subprocess.run(invocation, capture_output=True, timeout=timeout)
        return result, name
    finally:
        # Killing a timed-out docker CLI does not kill its daemon-side container.
        # Always address our exact unique name; never prune or touch other jobs.
        cleanup = subprocess.run([base[0], 'rm', '-f', name], capture_output=True, timeout=cleanup_timeout)
        absent = (b'No such container' in cleanup.stderr or b'No such object' in cleanup.stderr) and name.encode() in cleanup.stderr
        if cleanup.returncode != 0 and not absent:
            raise RuntimeError('Owned validation container cleanup was not confirmed: ' + name)
