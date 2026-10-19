#!/usr/bin/env python3
"""Maintainer tool: write or check plugins/requirement-auto/skills/gof-requirement/assets/dependencies/manifest.json.

The manifest lists every file of the bundled Python runtime with its SHA-256; the skill refuses to run when a file differs.
Run with the bundled interpreter:  <skill>/assets/dependencies/python/python.exe -I -B dev/runtime_manifest.py write|check
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "plugins" / "requirement-auto" / "skills" / "gof-requirement"
BASE = SKILL / "assets" / "dependencies"
sys.path.insert(0, str(SKILL / "scripts"))
import skill_runtime  # noqa: E402


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def build():
    files = {p.relative_to(BASE).as_posix(): digest(p)
             for p in sorted(BASE.rglob("*")) if p.is_file() and p.name != "manifest.json" and "__pycache__" not in p.parts}
    return {
        "schema": skill_runtime.MANIFEST_SCHEMA, "platform": "windows-x64",
        "python_version": skill_runtime.PYTHON_VERSION, "python_packages": skill_runtime.PYTHON_PACKAGES,
        "sources": [
            {"name": "python", "version": skill_runtime.PYTHON_VERSION, "upstream": "https://www.python.org/ftp/python/3.13.15/",
             "imported_from": "video-montage Windows x64 embedded runtime"},
            {"name": "python-packages", "lock": "python-requirements.txt", "versions": skill_runtime.PYTHON_PACKAGES,
             "imported_from": "Codex bundled runtime 26.1013.11914 installed distributions"},
        ],
        "files": files,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["write", "check"])
    args = parser.parse_args(argv)
    manifest = build()
    target = BASE / "manifest.json"
    text = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.action == "write":
        target.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {target} ({len(manifest['files'])} files)")
        return 0
    current = target.read_text(encoding="utf-8") if target.exists() else ""
    if current != text:
        print("manifest.json is out of date; run `write` after reviewing the runtime change")
        return 1
    print(f"manifest.json matches {len(manifest['files'])} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
