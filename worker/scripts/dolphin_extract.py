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
    dolphin_cfg = config.get("dolphin") if isinstance(config.get("dolphin"), dict) else {}

    repo_path = (
        dolphin_cfg.get("repoPath")
        or os.environ.get("DOLPHIN_REPO_PATH")
    )
    model_path = (
        dolphin_cfg.get("modelPath")
        or os.environ.get("DOLPHIN_MODEL_PATH")
    )
    mode = dolphin_cfg.get("mode") or "page"
    max_batch_size = str(dolphin_cfg.get("maxBatchSize") or 8)
    python_bin = os.environ.get("DOLPHIN_PYTHON_BIN") or sys.executable

    if not repo_path or not model_path:
        raise SystemExit(
            "dolphin extraction requires repo/model paths via documentExtraction.dolphin or "
            "DOLPHIN_REPO_PATH and DOLPHIN_MODEL_PATH"
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
