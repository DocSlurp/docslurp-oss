"""Evaluation compatibility entrypoint; production runtime belongs to the worker."""
from pathlib import Path
import importlib.util
import sys
_runtime = Path(__file__).resolve().parents[2] / "worker/src/layout/runtime"
sys.path.insert(0, str(_runtime))
_spec = importlib.util.spec_from_file_location(__name__, _runtime / "rectification.py")
_module = importlib.util.module_from_spec(_spec)
sys.modules[__name__] = _module
_spec.loader.exec_module(_module)
globals().update(vars(_module))
