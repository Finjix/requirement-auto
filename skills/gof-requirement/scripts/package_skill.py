#!/usr/bin/env python3
"""Build the complete Windows x64 skill ZIP. Downloads occur only at build time."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from skill_runtime import CLI_VERSION, NODE_VERSION, CLI_PATH, NODE_PATH, sha256, doctor


def download(url, output, expected=None):
    output = Path(output)
    if output.exists():
        if expected and sha256(output) == expected:
            return
        raise ValueError("缓存已存在且摘要不匹配：" + output.name)
    partial = output.with_suffix(output.suffix + ".partial")
    if partial.exists():
        raise ValueError("存在未完成下载；检查后移走该单个 .partial 文件再构建：" + partial.name)
    request = urllib.request.Request(url, headers={"User-Agent": "gof-requirement-package/1"})
    with urllib.request.urlopen(request, timeout=60) as response, partial.open("xb") as dest:
        shutil.copyfileobj(response, dest)
    if expected and sha256(partial) != expected:
        raise ValueError("下载摘要不匹配：" + output.name)
    partial.rename(output)


def extract_zip(archive, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(archive) as package:
        for item in package.infolist():
            target = (destination / item.filename).resolve()
            if destination not in target.parents and target != destination:
                raise ValueError("压缩包存在越界路径")
        package.extractall(destination)


def checksum_entry(text, name):
    matches = [line.split()[0] for line in text.splitlines() if len(line.split()) == 2
               and line.split()[1].lstrip("*") == name]
    if len(matches) != 1 or len(matches[0]) != 64:
        raise ValueError("官方校验清单缺少唯一条目：" + name)
    return matches[0]


def build(output, refresh_lock=False):
    root = Path(__file__).resolve().parents[1]
    output = Path(output).resolve()
    if root == output.parent or root in output.parents:
        raise ValueError("交付包和构建目录必须位于源 skill 目录之外")
    if output.exists():
        raise ValueError("交付包已存在，不能覆盖；使用新的 --output 路径")
    output.parent.mkdir(parents=True, exist_ok=True)
    cache = output.parent / ".downloads"
    cache.mkdir(exist_ok=True)
    build_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    stage = output.parent / "builds" / build_id / "gof-requirement"
    shutil.copytree(root, stage, ignore=shutil.ignore_patterns("runtime", ".state", "outputs", "__pycache__", "*.pyc"))
    runtime = stage / "runtime"
    win = runtime / "windows-x64"
    win.mkdir(parents=True)
    node_name = f"node-v{NODE_VERSION}-win-x64.zip"
    node_url = f"https://nodejs.org/dist/v{NODE_VERSION}/{node_name}"
    sums_url = f"https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt"
    with urllib.request.urlopen(sums_url, timeout=60) as response:
        node_hash = checksum_entry(response.read().decode("utf-8"), node_name)
    print("准备便携 Node LTS", flush=True)
    download(node_url, cache / node_name, node_hash)
    extract_zip(cache / node_name, win)
    (win / f"node-v{NODE_VERSION}-win-x64").rename(win / "node")
    node = runtime / NODE_PATH
    npm = win / "node/node_modules/npm/bin/npm-cli.js"
    dependency_source = root / "assets/runtime-package"
    env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get("PATH", ""),
               npm_config_cache=str(cache / "npm"), npm_config_update_notifier="false")
    def npm_run(*args, cwd):
        subprocess.run([str(node), str(npm), *args, "--ignore-scripts", "--no-audit", "--no-fund",
                        "--registry=https://registry.npmjs.org"], cwd=cwd, env=env, check=True, timeout=300)
    if refresh_lock:
        npm_run("install", "--package-lock-only", cwd=dependency_source)
    if not (dependency_source / "package-lock.json").is_file():
        raise ValueError("缺少依赖锁文件；维护依赖时先使用 --refresh-lock")
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(dependency_source / name, win / name)
        shutil.copyfile(dependency_source / name, stage / "assets/runtime-package" / name)
    print("准备固定 npm 依赖（禁用安装脚本）", flush=True)
    npm_run("ci", cwd=win)
    cli_package = win / "node_modules/@larksuite/cli"
    cli_name = f"lark-cli-{CLI_VERSION}-windows-amd64.zip"
    cli_hash = checksum_entry((cli_package / "checksums.txt").read_text(encoding="utf-8"), cli_name)
    cli_url = f"https://github.com/larksuite/cli/releases/download/v{CLI_VERSION}/{cli_name}"
    print("准备官方飞书 CLI 可执行文件", flush=True)
    download(cli_url, cache / cli_name, cli_hash)
    cli_unpack = win / "cli-release"
    extract_zip(cache / cli_name, cli_unpack)
    binary = cli_unpack / "lark-cli.exe"
    if not binary.is_file():
        raise ValueError("官方 CLI 压缩包布局不符合预期")
    (cli_package / "bin").mkdir(exist_ok=True)
    shutil.copyfile(binary, runtime / CLI_PATH)
    binary.unlink()  # Exact staging file only; retain release licenses without duplicating the binary.
    # Keep the release's own license and other files as part of the complete package.
    files = {p.relative_to(runtime).as_posix(): sha256(p) for p in sorted(runtime.rglob("*")) if p.is_file()}
    manifest = {"schema": 1, "platform": "windows-x64", "cli_version": CLI_VERSION, "node_version": NODE_VERSION,
                "sources": [{"name": "node", "url": node_url, "sha256": node_hash, "checksums_url": sums_url},
                            {"name": "lark-cli-binary", "url": cli_url, "sha256": cli_hash,
                             "checksums": "windows-x64/node_modules/@larksuite/cli/checksums.txt"},
                            {"name": "npm-dependencies", "registry": "https://registry.npmjs.org",
                             "lock": "windows-x64/package-lock.json", "sha256": sha256(win / "package-lock.json")}],
                "files": files}
    (runtime / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    verified = doctor(stage)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(stage.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(stage.parent).as_posix())
    digest = sha256(output)
    with output.with_suffix(output.suffix + ".sha256").open("x", encoding="utf-8") as checksum:
        checksum.write(digest + "  " + output.name + "\n")
    return {"status": "package_built", "archive": str(output), "sha256": digest,
            "bytes": output.stat().st_size, "skill_root": str(stage), "runtime": verified}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--refresh-lock", action="store_true", help="仅维护依赖时更新源技能内的 npm 锁文件")
    args = parser.parse_args()
    try:
        result = build(args.output, args.refresh_lock)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
