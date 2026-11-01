#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config-json", default=None)
    return parser.parse_args()


def load_config(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid --config-json payload: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit("--config-json must decode to an object")
    return value


def find_markdown_file(save_dir: Path) -> Path | None:
    markdown_files = sorted(save_dir.rglob("*.md"))
    if markdown_files:
        return markdown_files[0]

    markdown_like = sorted(save_dir.rglob("*.markdown"))
    if markdown_like:
        return markdown_like[0]

    return None


def main() -> None:
    args = parse_args()
    config = load_config(args.config_json)
    # The worker passes this extractor's options (dolphinExtractorOptionsSchema): only mode and maxBatchSize.
    # Repository, model and Python paths come from the worker environment only; a workspace never chooses them.
    unknown = sorted(set(config) - {"mode", "maxBatchSize"})
    if unknown:
        raise SystemExit(f"dolphin options not allowed: {', '.join(unknown)}")

    repo_path = os.environ.get("DOLPHIN_REPO_PATH")
    model_path = os.environ.get("DOLPHIN_MODEL_PATH")
    mode = config.get("mode") or "page"
    if mode not in ("page", "layout"):
        raise SystemExit(f"dolphin mode must be page or layout, got {mode!r}")
    batch = config.get("maxBatchSize", 8)
    if isinstance(batch, bool) or not isinstance(batch, int) or not 1 <= batch <= 32:
        raise SystemExit("dolphin maxBatchSize must be an integer from 1 to 32")
    max_batch_size = str(batch)
    python_bin = os.environ.get("DOLPHIN_PYTHON_BIN") or sys.executable

    if not repo_path or not model_path:
        raise SystemExit(
            "dolphin extraction requires DOLPHIN_REPO_PATH and DOLPHIN_MODEL_PATH in the worker environment"
        )

    repo_dir = Path(repo_path)
    model_dir = Path(model_path)
    if not repo_dir.exists():
        raise SystemExit(f"dolphin repo path not found: {repo_dir}")
    if not model_dir.exists():
        raise SystemExit(f"dolphin model path not found: {model_dir}")

    script_name = "demo_layout.py" if mode == "layout" else "demo_page.py"
    script_path = repo_dir / script_name
    if not script_path.exists():
        raise SystemExit(f"dolphin script not found: {script_path}")

    with tempfile.TemporaryDirectory(prefix="docslurp-dolphin-") as tmp_dir:
        save_dir = Path(tmp_dir) / "results"
        save_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            python_bin,
            str(script_path),
            "--model_path",
            str(model_dir),
            "--save_dir",
            str(save_dir),
            "--input_path",
            args.input,
        ]
        if mode == "page":
            cmd.extend(["--max_batch_size", max_batch_size])

        proc = subprocess.run(
            cmd,
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            stderr = proc.stderr.strip()
            stdout = proc.stdout.strip()
            message = stderr or stdout or f"exit code {proc.returncode}"
            raise SystemExit(f"dolphin extraction failed: {message}")

        markdown_path = find_markdown_file(save_dir)
        if not markdown_path:
            raise SystemExit(
                "dolphin finished but no markdown artifact was found under the save directory"
            )

        Path(args.output).write_text(markdown_path.read_text(encoding="utf-8"), encoding="utf-8")


if __name__ == "__main__":
    main()
