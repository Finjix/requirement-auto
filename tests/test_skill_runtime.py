import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "skills/gof-requirement/scripts"
sys.path.insert(0, str(SCRIPTS))
import skill_runtime as runtime
import package_skill


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gof runtime 中文 ")
        self.root = Path(self.temp.name) / "skill with spaces"
        self.base = self.root / "runtime"
        for path, data in [(runtime.NODE_PATH, b"test node"), (runtime.CLI_PATH, b"test cli"),
                           ("windows-x64/node_modules/@larksuite/cli/package.json",
                            json.dumps({"name": "@larksuite/cli", "version": runtime.CLI_VERSION}).encode())]:
            target = self.base / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        self.manifest = {"schema": 1, "platform": "windows-x64", "cli_version": runtime.CLI_VERSION,
                         "node_version": runtime.NODE_VERSION,
                         "files": {p.relative_to(self.base).as_posix(): runtime.sha256(p)
                                   for p in self.base.rglob("*") if p.is_file()}}
        self.save_manifest()

    def save_manifest(self):
        (self.base / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_relative_paths_relocate_and_isolate_configuration(self):
        moved = self.root.parent / "moved 技能目录"
        shutil.move(str(self.root), moved)
        found = runtime.layout(moved)
        self.assertEqual(found["cli"], moved / "runtime" / runtime.CLI_PATH)
        env = runtime.runtime_environment(moved)
        self.assertEqual(env["LARKSUITE_CLI_CONFIG_DIR"], str(moved / ".state/feishu-cli"))
        self.assertEqual(env["PATH"], os.environ["PATH"])

    def test_missing_binary_tampering_and_unlisted_file_block_before_process(self):
        with patch.object(runtime.subprocess, "run") as runner:
            (self.base / runtime.CLI_PATH).write_bytes(b"tampered")
            with self.assertRaises(runtime.RuntimeError):
                runtime.doctor(self.root)
            (self.base / runtime.CLI_PATH).unlink()
            with self.assertRaises(runtime.RuntimeError):
                runtime.doctor(self.root)
            (self.base / runtime.CLI_PATH).write_bytes(b"test cli")
            (self.base / "unlisted.js").write_text("unexpected", encoding="utf-8")
            with self.assertRaises(runtime.RuntimeError):
                runtime.doctor(self.root)
            runner.assert_not_called()

    def test_incompatible_versions_and_path_traversal_rejected(self):
        self.manifest["node_version"] = "26.0.0"
        self.save_manifest()
        with self.assertRaises(runtime.RuntimeError):
            runtime.layout(self.root)
        self.manifest["node_version"] = runtime.NODE_VERSION
        self.manifest["files"]["../../outside.exe"] = "0" * 64
        self.save_manifest()
        with self.assertRaises(runtime.RuntimeError):
            runtime.layout(self.root)

    def test_actual_binary_version_must_match_manifest(self):
        def run(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, "v24.19.0", "")
        with patch.object(runtime.subprocess, "run", side_effect=run), self.assertRaises(runtime.RuntimeError):
            runtime.doctor(self.root)

    def test_platform_and_missing_package_never_trigger_install(self):
        with patch.object(runtime.sys, "platform", "linux"), self.assertRaises(runtime.RuntimeError):
            runtime.layout(self.root)
        with patch.object(runtime.subprocess, "run") as runner, self.assertRaises(runtime.RuntimeError):
            runtime.layout(self.root / "absent")
        runner.assert_not_called()

    def test_archive_extraction_rejects_escape_and_checksum_requires_exact_entry(self):
        archive = self.root.parent / "bad.zip"
        with zipfile.ZipFile(archive, "w") as zip_file:
            zip_file.writestr("../escape.txt", "bad")
        with self.assertRaises(ValueError):
            package_skill.extract_zip(archive, self.root.parent / "unpacked")
        self.assertFalse((self.root.parent / "escape.txt").exists())
        with self.assertRaises(ValueError):
            package_skill.checksum_entry("abc  file.zip", "file.zip")

    def test_locked_cli_dependency_has_fixed_version_and_integrity(self):
        root = SCRIPTS.parent
        lock = json.loads((root / "assets/runtime-package/package-lock.json").read_text(encoding="utf-8"))
        cli = lock["packages"]["node_modules/@larksuite/cli"]
        self.assertEqual(cli["version"], runtime.CLI_VERSION)
        self.assertTrue(cli["integrity"].startswith("sha512-"))


@unittest.skipUnless(os.environ.get("GOF_OFFLINE_SKILL_ROOT"), "完整包集成测试仅在构建后运行")
class OfflinePackageTests(unittest.TestCase):
    def test_complete_package_without_global_node_cli_or_dependency_downloads(self):
        root = Path(os.environ["GOF_OFFLINE_SKILL_ROOT"])
        env = dict(os.environ, PATH=str(Path(os.environ["SystemRoot"]) / "System32"),
                   HTTP_PROXY="http://127.0.0.1:9", HTTPS_PROXY="http://127.0.0.1:9", NO_PROXY="")
        command = [sys.executable, str(root / "scripts/skill_runtime.py"), "doctor"]
        completed = subprocess.run(command, capture_output=True, encoding="utf-8", env=env, cwd=root.parent, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["status"], "runtime_verified")
        found = runtime.layout(root)
        for args in ([str(found["cli"]), "sheets", "+cells-set", "--help"],
                     [str(found["node"]), "--version"]):
            completed = subprocess.run(args, capture_output=True, encoding="utf-8",
                                       env=dict(env, **{k: v for k, v in runtime.runtime_environment(root).items()
                                                      if k.startswith("LARKSUITE_")}), timeout=30)
            self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse((root / ".state").exists())


if __name__ == "__main__":
    unittest.main()
