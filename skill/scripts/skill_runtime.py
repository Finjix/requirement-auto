#!/usr/bin/env python3
"""Verify and locate the relocatable offline Windows runtime. No installer or network."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

CLI_VERSION = "1.0.98"
NODE_VERSION = "24.21.0"
PYTHON_VERSION = "3.13.15"
PYTHON_PACKAGES = {"openpyxl": "3.1.5", "et_xmlfile": "2.0.0"}
DEPENDENCIES = "assets/dependencies"
PYTHON_PATH = "python/python.exe"
NODE_PATH = "node/node.exe"
CLI_PATH = "node_modules/@larksuite/cli/bin/lark-cli.exe"


class RuntimeError(ValueError):
    pass


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def runtime_environment(root):
    return dict(os.environ, LARKSUITE_CLI_CONFIG_DIR=str(Path(root).resolve() / ".state" / "feishu-cli"),
                LARKSUITE_CLI_WORKSPACE="local", LARKSUITE_CLI_NO_UPDATE_NOTIFIER="1",
                LARKSUITE_CLI_NO_SKILLS_NOTIFIER="1")


def layout(root=None, check_platform=True):
    root = Path(root or Path(__file__).resolve().parents[1]).resolve()
    if check_platform and (sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}):
        raise RuntimeError("此完整包仅支持 Windows x64")
    base = root / DEPENDENCIES
    try:
        manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise RuntimeError("缺少完整包 assets/dependencies/manifest.json；请使用完整 skill 包，不下载或调用系统 CLI") from None
    if (manifest.get("schema") != 2 or manifest.get("platform") != "windows-x64"
            or manifest.get("cli_version") != CLI_VERSION or manifest.get("node_version") != NODE_VERSION
            or manifest.get("python_version") != PYTHON_VERSION or manifest.get("python_packages") != PYTHON_PACKAGES):
        raise RuntimeError("运行时版本或平台与技能不匹配")
    files = manifest.get("files")
    if not isinstance(files, dict) or not {PYTHON_PATH, NODE_PATH, CLI_PATH} <= files.keys():
        raise RuntimeError("完整包缺少 Python、Node 或飞书 CLI")
    actual = {p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file() and p != base / "manifest.json"}
    if actual != set(files):
        raise RuntimeError("运行时文件缺失或出现清单外文件")
    for name, expected in files.items():
        file = base / name
        if (not isinstance(expected, str) or len(expected) != 64 or file.is_symlink()
                or base.resolve() not in file.resolve().parents or sha256(file) != expected):
            raise RuntimeError("运行时文件摘要或路径校验失败")
    package = json.loads((base / "node_modules/@larksuite/cli/package.json").read_text(encoding="utf-8"))
    if package.get("name") != "@larksuite/cli" or package.get("version") != CLI_VERSION:
        raise RuntimeError("飞书 npm 包版本不匹配")
    return {"root": root, "python": base / PYTHON_PATH, "node": base / NODE_PATH, "cli": base / CLI_PATH, "manifest": manifest}


def doctor(root=None):
    runtime = layout(root)
    probe = ("import importlib, importlib.metadata as m, json, sys; "
             "[importlib.import_module(n) for n in " + repr(list(PYTHON_PACKAGES)) + "]; "
             "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), "
             "'bits': 64 if sys.maxsize > 2**32 else 32, "
             "'packages': {n: m.version(n) for n in " + repr(list(PYTHON_PACKAGES)) + "}}))")
    result = subprocess.run([str(runtime["python"]), "-I", "-B", "-c", probe], capture_output=True,
                            encoding="utf-8", shell=False, timeout=20, env=runtime_environment(runtime["root"]))
    expected = {"version": PYTHON_VERSION, "bits": 64, "packages": PYTHON_PACKAGES}
    try:
        actual_python = json.loads(result.stdout)
    except (ValueError, TypeError):
        actual_python = None
    if result.returncode != 0 or actual_python != expected:
        raise RuntimeError("包内 Python 或运行依赖实际版本不匹配")
    for name, expected in (("node", "v" + NODE_VERSION), ("cli", "lark-cli version " + CLI_VERSION)):
        result = subprocess.run([str(runtime[name]), "--version"], capture_output=True, encoding="utf-8",
                                shell=False, timeout=20, env=runtime_environment(runtime["root"]))
        if result.returncode != 0 or result.stdout.strip() != expected:
            raise RuntimeError("包内运行时实际版本不匹配")
    return {"status": "runtime_verified", "platform": "windows-x64", "node_version": NODE_VERSION,
            "python_version": PYTHON_VERSION, "python_packages": PYTHON_PACKAGES,
            "cli_version": CLI_VERSION, "files_verified": len(runtime["manifest"]["files"]),
            "python": str(runtime["python"]), "node": str(runtime["node"]), "cli": str(runtime["cli"]), "network_required": False}


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["doctor"])
    parser.add_argument("--root", help="完整 skill 包的根目录；默认按脚本位置解析")
    args = parser.parse_args(argv)
    try:
        result = doctor(args.root)
        code = 0
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
        result, code = {"status": "blocked", "reason": "完整包校验失败；检查平台、固定版本及文件摘要，不自动安装依赖"}, 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
