#!/usr/bin/env python3
"""Verify and locate the offline runtime of the skill: the bundled Python and the plugin's Feishu bridge. No installer or network."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

BRIDGE_VERSION = "feishu-sdk-bridge/1"
MIN_NODE_MAJOR = 24
PYTHON_VERSION = "3.13.15"
PYTHON_PACKAGES = {"openpyxl": "3.1.5", "et_xmlfile": "2.0.0"}
DEPENDENCIES = "assets/dependencies"
PYTHON_PATH = "python/python.exe"
# <plugin>/skills/gof-requirement is the skill root; the Feishu bridge is built into <plugin>/server/dist.
BRIDGE_PATH = "server/dist/bridge.mjs"
MANIFEST_SCHEMA = 3


class RuntimeError(ValueError):
    pass


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def plugin_root(root):
    return Path(root).resolve().parents[1]


def runtime_environment(root=None):
    """The bridge and its Node process inherit the host's environment: the app credentials and the user directory come from it."""
    return dict(os.environ)


def find_node():
    """The Node of the machine (the same >= 24 that lark-agent needs). Nothing is downloaded."""
    found = shutil.which("node")
    if not found:
        raise RuntimeError("找不到 node；飞书桥需要系统已安装 Node.js 24 或更高版本")
    result = subprocess.run([found, "--version"], capture_output=True, encoding="utf-8", shell=False, timeout=20)
    match = re.fullmatch(r"v(\d+)\.\d+\.\d+", result.stdout.strip())
    if result.returncode != 0 or not match or int(match.group(1)) < MIN_NODE_MAJOR:
        raise RuntimeError(f"需要 Node.js {MIN_NODE_MAJOR} 或更高版本")
    return Path(found), result.stdout.strip()


def layout(root=None, check_platform=True):
    root = Path(root or Path(__file__).resolve().parents[1]).resolve()
    if check_platform and (sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}):
        raise RuntimeError("此完整包仅支持 Windows x64")
    base = root / DEPENDENCIES
    try:
        manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise RuntimeError("缺少完整包 assets/dependencies/manifest.json；请使用完整插件包，不下载或调用系统依赖") from None
    if (manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("platform") != "windows-x64"
            or manifest.get("python_version") != PYTHON_VERSION or manifest.get("python_packages") != PYTHON_PACKAGES):
        raise RuntimeError("运行时版本或平台与技能不匹配")
    files = manifest.get("files")
    if not isinstance(files, dict) or PYTHON_PATH not in files:
        raise RuntimeError("完整包缺少 Python")
    actual = {p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file() and p != base / "manifest.json"}
    if actual != set(files):
        raise RuntimeError("运行时文件缺失或出现清单外文件")
    for name, expected in files.items():
        file = base / name
        if (not isinstance(expected, str) or len(expected) != 64 or file.is_symlink()
                or base.resolve() not in file.resolve().parents or sha256(file) != expected):
            raise RuntimeError("运行时文件摘要或路径校验失败")
    bridge = plugin_root(root) / BRIDGE_PATH
    if not bridge.is_file():
        raise RuntimeError("找不到插件内的飞书桥 server/dist/bridge.mjs；请使用完整插件包")
    return {"root": root, "python": base / PYTHON_PATH, "bridge": bridge, "manifest": manifest}


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
    node, node_version = find_node()
    return {"status": "runtime_verified", "platform": "windows-x64", "python_version": PYTHON_VERSION,
            "python_packages": PYTHON_PACKAGES, "bridge_version": BRIDGE_VERSION, "node": str(node),
            "node_version": node_version, "files_verified": len(runtime["manifest"]["files"]),
            "python": str(runtime["python"]), "bridge": str(runtime["bridge"]), "network_required": False}


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["doctor"])
    parser.add_argument("--root", help="技能根目录；默认按脚本位置解析")
    args = parser.parse_args(argv)
    try:
        result = doctor(args.root)
        code = 0
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, RuntimeError) else "完整包校验失败；检查平台、固定版本及文件摘要，不自动安装依赖"
        result, code = {"status": "blocked", "reason": reason}, 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
