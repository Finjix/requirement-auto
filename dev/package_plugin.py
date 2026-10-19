#!/usr/bin/env python3
"""Check the layout of plugins/requirement-auto and pack it into a ZIP with a SHA-256 file. No network, no installs.

    python.exe -I -B dev/package_plugin.py --check
    python.exe -I -B dev/package_plugin.py --output dev/dist/requirement-auto-windows-x64.zip
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "requirement-auto"
SKILL = PLUGIN / "skills" / "gof-requirement"
MARKETPLACE = ROOT / ".agents" / "plugins" / "marketplace.json"
MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
# What a stdio entry of the portable mcp.json may contain (Agent Plugins schema); anything else makes Codex drop the server.
STDIO_KEYS = {"type", "command", "args", "env", "cwd"}
FORBIDDEN_PARTS = {"__pycache__", "node_modules", ".state", ".git", ".codex"}
FORBIDDEN_NAMES = {"auth.json", "login.json", "app.json", "refresh.lock", ".env"}
REQUIRED_FILES = [
    "plugin.json", "mcp.json", "server/dist/bridge.mjs", "server/dist/mcp.mjs",
    "skills/gof-requirement/SKILL.md", "skills/gof-requirement/agents/openai.yaml",
    "skills/gof-requirement/scripts/feishu_api.py", "skills/gof-requirement/scripts/batch.py",
    "skills/gof-requirement/references/feishu-sdk-workflow.md",
    "skills/gof-requirement/assets/dependencies/manifest.json", "skills/gof-requirement/assets/dependencies/python/python.exe",
]


def problems():
    found = []
    for name in REQUIRED_FILES:
        if not (PLUGIN / name).is_file():
            found.append(f"missing {name}")
    try:
        manifest = json.loads((PLUGIN / "plugin.json").read_text(encoding="utf-8"))
        if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", manifest.get("name", "")):
            found.append("plugin.json: name must be kebab-case")
        if not manifest.get("version") or not manifest.get("description"):
            found.append("plugin.json: version and description are required")
        market = json.loads(MARKETPLACE.read_text(encoding="utf-8"))
        entries = [p for p in market.get("plugins", []) if p.get("name") == manifest.get("name")]
        if len(entries) != 1 or entries[0].get("source", {}).get("path") != "./plugins/requirement-auto":
            found.append("marketplace.json does not point at plugins/requirement-auto")
    except (OSError, ValueError) as error:
        found.append(f"plugin.json / marketplace.json unreadable: {error}")
    try:
        mcp = json.loads((PLUGIN / "mcp.json").read_text(encoding="utf-8"))
        if mcp.get("$schema") != MCP_SCHEMA or set(mcp) != {"$schema", "mcpServers"}:
            found.append("mcp.json: needs exactly $schema and mcpServers")
        for name, server in mcp.get("mcpServers", {}).items():
            if server.get("type") == "stdio" and set(server) - STDIO_KEYS:
                found.append(f"mcp.json: {name} has keys Codex does not accept: {sorted(set(server) - STDIO_KEYS)}")
    except (OSError, ValueError) as error:
        found.append(f"mcp.json unreadable: {error}")
    text = (SKILL / "SKILL.md").read_text(encoding="utf-8") if (SKILL / "SKILL.md").is_file() else ""
    if not re.match(r"---\nname: gof-requirement\ndescription: ", text):
        found.append("SKILL.md: front matter must start with name: gof-requirement and a description")
    for path in PLUGIN.rglob("*"):
        parts = set(path.relative_to(PLUGIN).parts)
        if parts & FORBIDDEN_PARTS or (path.is_file() and path.name in FORBIDDEN_NAMES):
            found.append(f"must not ship: {path.relative_to(PLUGIN).as_posix()}")
    return found


def pack(output):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit(f"{output} exists; choose a new file name")
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(p for p in PLUGIN.rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(f"requirement-auto/{path.relative_to(PLUGIN).as_posix()}", date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    Path(str(output) + ".sha256").write_text(f"{digest}  {output.name}\n", encoding="utf-8")
    print(f"{output}\nsha256 {digest}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--output")
    args = parser.parse_args(argv)
    found = problems()
    for line in found:
        print(f"problem: {line}")
    if found:
        return 1
    if args.check:
        print("plugin layout ok")
        return 0
    pack(args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
