#!/usr/bin/env python3
"""Run every check of the repository: runtime manifest, the TypeScript layer (typecheck, build, tests), the Python tests and the
plugin layout check. Run with the bundled interpreter:

    plugins/requirement-auto/skills/gof-requirement/assets/dependencies/python/python.exe -I -B dev/run_tests.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "dev"


def step(title, command, cwd=ROOT):
    print(f"\n=== {title}", flush=True)
    result = subprocess.run(command, cwd=cwd, shell=False)
    if result.returncode != 0:
        print(f"*** FAILED: {title}", flush=True)
    return result.returncode == 0


def main():
    python = [sys.executable, "-I", "-B"]
    results = [step("runtime manifest", [*python, str(DEV / "runtime_manifest.py"), "check"])]

    sdk = DEV / "feishu-sdk"
    npm = shutil.which("npm")
    if npm and (sdk / "node_modules").is_dir():
        # typecheck + build (rewrites plugins/requirement-auto/server/dist) + node:test
        results.append(step("feishu-sdk: typecheck, build, tests", [npm, "test"], cwd=sdk))
    else:
        print("\n=== feishu-sdk: SKIPPED (need npm and `npm install` in dev/feishu-sdk)", flush=True)
        results.append(False)

    results.append(step("python tests", [*python, str(DEV / "tests" / "test_feishu_bridge.py")]))
    results.append(step("plugin layout", [*python, str(DEV / "package_plugin.py"), "--check"]))

    print("\nALL PASSED" if all(results) else "\nSOME CHECKS FAILED", flush=True)
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
