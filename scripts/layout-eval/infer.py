"""Evaluation compatibility entrypoint; production runtime belongs to the worker."""
from pathlib import Path
import runpy
import sys
_runtime = Path(__file__).resolve().parents[2] / "worker/src/layout/runtime"
sys.path.insert(0, str(_runtime))
globals().update(runpy.run_path(str(_runtime / "infer.py"), run_name=__name__))
