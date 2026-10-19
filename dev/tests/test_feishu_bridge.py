"""The Python side of the Feishu transport: the bridge client, the safety probe against a fake server, and the runtime check.

Run:  <skill>/assets/dependencies/python/python.exe -I -B dev/tests/test_feishu_bridge.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "plugins" / "requirement-auto" / "skills" / "gof-requirement"
sys.path.insert(0, str(SKILL / "scripts"))

import batch  # noqa: E402
import feishu_api  # noqa: E402
import skill_runtime  # noqa: E402

VERSION = feishu_api.VERSION


def reply(data):
    return {"ok": True, "data": data}


def failure(kind, message="m", code=None):
    error = {"kind": kind, "message": message}
    if code is not None:
        error["code"] = code
    return {"ok": False, "error": error}


class FakeRun:
    """Stands in for subprocess.run: records the call and answers with what `handler(name, payload)` returns."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, command, input=None, **kwargs):
        name = command[-1]
        payload = json.loads(input) if input else None
        self.calls.append({"name": name, "payload": payload, "input": input, "kwargs": kwargs, "command": command})
        result = self.handler(name, payload)
        return subprocess.CompletedProcess(command, 0 if result.get("ok") else 2, stdout=json.dumps(result) + "\n", stderr="")


def bridge_with(handler):
    runner = FakeRun(handler)
    return feishu_api.Bridge(command=["node", "bridge.mjs"], runner=runner), runner


class BridgeClientTests(unittest.TestCase):
    def test_every_call_gets_stdin_and_a_timeout_and_never_a_shell(self):
        bridge, runner = bridge_with(lambda name, payload: reply({"revision": 3}))
        self.assertEqual(bridge.revision("shtABCDEFGH"), {"revision": 3})
        call = runner.calls[0]
        self.assertEqual(call["command"], ["node", "bridge.mjs", "sheets-revision"])
        self.assertEqual(call["payload"], {"token": "shtABCDEFGH"})
        self.assertIs(call["kwargs"]["shell"], False)
        self.assertEqual(call["kwargs"]["timeout"], 60)
        # A command without arguments still gets (empty) stdin, so the bridge never waits on an inherited pipe.
        bridge.call("auth-status")
        self.assertEqual(runner.calls[1]["input"], "")

    def test_bridge_failures_map_to_the_exceptions_the_workflow_expects(self):
        cases = [
            (failure("occupied"), feishu_api.OccupiedRefusal, "非空"),
            (failure("unknown_result"), batch.Blocked, "结果未知"),
            (failure("auth_required", "飞书登录已过期，请重新授权"), batch.Blocked, "auth_required.*重新授权"),
            (failure("scope_missing", "缺少权限：x"), batch.Blocked, "缺少权限"),
            (failure("api", "SECRET-SERVER-TEXT code=1"), batch.Blocked, "飞书接口调用失败"),
        ]
        for result, exception, pattern in cases:
            bridge, _ = bridge_with(lambda name, payload, result=result: result)
            with self.assertRaises(exception) as caught:
                bridge.call("api-get", {"path": "/open-apis/x"})
            self.assertRegex(str(caught.exception), pattern)
            self.assertNotIn("SECRET-SERVER-TEXT", str(caught.exception), "an untrusted server message is not echoed")

    def test_a_write_that_got_no_answer_is_an_unknown_result_not_a_plain_failure(self):
        bridge, _ = bridge_with(lambda name, payload: failure("network", "无法连接飞书"))
        with self.assertRaisesRegex(batch.Blocked, "结果未知"):
            bridge.call("sheets-cells-set", {}, write=True)
        with self.assertRaisesRegex(batch.Blocked, "飞书接口调用失败"):
            bridge.call("api-get", {})

    def test_timeouts_and_unreadable_output_stop_the_workflow(self):
        def hang(command, **kwargs):
            raise subprocess.TimeoutExpired(command, kwargs.get("timeout", 1))

        write = feishu_api.Bridge(command=["node", "b.mjs"], runner=hang)
        with self.assertRaisesRegex(batch.Blocked, "结果未知"):
            write.call("sheets-cells-set", {}, write=True)
        with self.assertRaisesRegex(batch.Blocked, "读取超时"):
            write.call("api-get", {})

        def garbage(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, stdout="not json", stderr="")

        with self.assertRaisesRegex(batch.Blocked, "不可解析"):
            feishu_api.Bridge(command=["node", "b.mjs"], runner=garbage).call("auth-status")

        def missing(command, **kwargs):
            raise FileNotFoundError

        with self.assertRaisesRegex(batch.Blocked, "无法启动"):
            feishu_api.Bridge(command=["node", "b.mjs"], runner=missing).call("auth-status")

    def test_a_reply_that_reports_partial_success_or_truncation_is_refused(self):
        for data in ({"errors": [{"code": 1}]}, {"status": "partial_success"}, {"nested": {"has_more": True}}, {"ok": False}):
            bridge, _ = bridge_with(lambda name, payload, data=data: reply(data))
            with self.assertRaises(batch.Blocked):
                bridge.call("api-get", {})

    def test_reads_are_restricted_to_open_apis_without_query_strings(self):
        bridge, runner = bridge_with(lambda name, payload: reply({}))
        for bad in ("/other", "/open-apis/a/../b", "/open-apis/a?x=1", "https://x/open-apis/a"):
            with self.assertRaises(batch.Blocked):
                bridge.api_read(bad)
        self.assertEqual(runner.calls, [])

    def test_a_write_without_the_no_overwrite_flag_never_leaves_python(self):
        bridge, runner = bridge_with(lambda name, payload: reply({}))
        for writes in ([], [{"sheet_id": "s", "range": "A1:A1", "cells": [[{}]]}], [{"allow_overwrite": True}], "x"):
            with self.assertRaises(batch.Blocked):
                bridge.cells_set("shtABCDEFGH", writes)
        with self.assertRaises(batch.Blocked):
            bridge.cells_set("../x", [{"allow_overwrite": False}])
        self.assertEqual(runner.calls, [])
        bridge.cells_set("shtABCDEFGH", [{"sheet_id": "s", "range": "A1:A1", "cells": [[{"value": 1}]], "allow_overwrite": False}])
        self.assertEqual(runner.calls[0]["name"], "sheets-cells-set")
        self.assertIs(runner.calls[0]["payload"]["writes"][0]["allow_overwrite"], False)

    def test_doctor_requires_the_right_bridge_a_configured_app_a_login_and_every_scope(self):
        def handler(overrides):
            data = {
                "info": reply({"bridge": VERSION, "app_configured": True}),
                "auth-status": reply({"logged_in": True, "name": "李小明", "open_id": "ou_1", "storage": "host"}),
                "auth-check-scopes": reply({"complete": True, "granted": list(feishu_api.SCOPES), "missing": []}),
            }
            data.update(overrides)
            return lambda name, payload: data[name]

        bridge, runner = bridge_with(handler({}))
        result = bridge.doctor()
        self.assertEqual((result["user_name"], result["open_id"], result["identity"]), ("李小明", "ou_1", "user"))
        self.assertEqual([c["name"] for c in runner.calls], ["info", "auth-status", "auth-check-scopes"])
        self.assertEqual(runner.calls[2]["payload"]["required"], list(feishu_api.SCOPES))
        self.assertNotIn("token", json.dumps(result).lower())

        for overrides, pattern in [
            ({"info": reply({"bridge": "other/9", "app_configured": True})}, "版本"),
            ({"info": reply({"bridge": VERSION, "app_configured": False})}, "未配置飞书应用"),
            ({"auth-status": reply({"logged_in": False})}, "尚未授权"),
            ({"auth-check-scopes": reply({"complete": False, "granted": [], "missing": ["x"]})}, "缺少本流程必要权限"),
        ]:
            bridge, _ = bridge_with(handler(overrides))
            with self.assertRaisesRegex(batch.Blocked, pattern):
                bridge.doctor()

    def test_login_commands_pass_through_without_printing_secrets(self):
        bridge, runner = bridge_with(lambda name, payload: reply({"state": "pending", "retry_after_s": 5, "expires_in_s": 200}))
        args = type("Args", (), {"action": "poll", "wait": 7, "probe_scope": False})
        self.assertEqual(feishu_api.login(bridge, args)["state"], "pending")
        self.assertEqual(runner.calls[-1]["payload"], {"wait_ms": 7000})
        self.assertEqual(runner.calls[-1]["kwargs"]["timeout"], 37)
        feishu_api.login(bridge, type("Args", (), {"action": "start", "wait": 40, "probe_scope": True}))
        self.assertEqual(runner.calls[-1]["payload"], {"extra_scopes": ["sheets:spreadsheet:create"]})
        with self.assertRaises(batch.Blocked):
            feishu_api.login(bridge, type("Args", (), {"action": "poll", "wait": 51, "probe_scope": False}))


class FakeSheetServer:
    """The server side of the safety probe: it refuses to write over a non-empty cell, like the real allow_overwrite=false."""

    def __init__(self, enforce=True):
        self.enforce = enforce
        self.cells = {}
        self.writes = []

    @staticmethod
    def coords(rng):
        match = re.fullmatch(r"([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?", rng)
        c1, r1, c2, r2 = match.group(1), int(match.group(2)), match.group(3) or match.group(1), int(match.group(4) or match.group(2))
        return [(chr(c), r) for r in range(r1, r2 + 1) for c in range(ord(c1), ord(c2) + 1)]

    def __call__(self, name, payload):
        if name == "info":
            return reply({"bridge": VERSION, "app_configured": True})
        if name == "auth-status":
            return reply({"logged_in": True, "name": "李小明", "open_id": "ou_1", "storage": "host"})
        if name == "auth-check-scopes":
            return reply({"complete": True, "granted": payload["required"], "missing": []})
        if name == "api-get":
            path = payload["path"]
            if path.endswith("/spaces/get_node"):
                return reply({"node": {"node_token": batch.NODE, "obj_type": "sheet", "obj_token": "shtPRODUCTION"}})
            if path.endswith("/sheets/query"):
                return reply({"sheets": [{"sheet_id": "s1", "resource_type": "sheet", "title": "Sheet1", "index": 0}]})
            if path.endswith("/values_batch_get"):
                cells = [self.cells.get(("A", 1), ""), self.cells.get(("B", 1), "")]
                return reply({"valueRanges": [{"values": [cells]}]})
        if name == "sheets-create":
            return reply({"spreadsheet_token": "shtPROBE12345"})
        if name == "sheets-cells-set":
            for write in payload["writes"]:
                targets = self.coords(write["range"])
                if self.enforce and any(self.cells.get(t) not in (None, "") or t in self.cells for t in targets):
                    return failure("occupied")
                flat = [cell for row in write["cells"] for cell in row]
                for target, cell in zip(targets, flat):
                    self.cells[target] = cell.get("formula", cell.get("value"))
                self.writes.append(write["range"])
            return reply({"applied": True})
        raise AssertionError(f"unexpected bridge call {name} {payload}")


class ProbeTests(unittest.TestCase):
    def test_the_probe_records_three_refused_overwrites_and_the_receipt_is_accepted_only_for_this_bridge(self):
        server = FakeSheetServer()
        bridge, _ = bridge_with(server)
        with tempfile.TemporaryDirectory() as tmp:
            receipt = Path(tmp) / "receipt.json"
            result = feishu_api.probe(bridge, receipt)
            self.assertEqual(result["status"], "safety_verified")
            # Only the baseline went through; each of the three attempts to overwrite was refused and left the cells alone.
            self.assertEqual(server.writes, ["A1:B1"])
            data = feishu_api.acceptance(receipt)
            self.assertEqual((data["bridge_version"], data["schema"]), (VERSION, 2))
            self.assertEqual(data["passed"], ["occupied_value", "empty_formula", "repeated_occupancy"])
            self.assertNotEqual(data["probe_workbook"], data["production_token"])

            for key, value in [("bridge_version", "feishu-sdk-bridge/0"), ("schema", 1)]:
                forged = dict(data)
                forged.pop("receipt_id")
                forged[key] = value
                path = Path(tmp) / f"forged-{key}.json"
                path.write_text(json.dumps(feishu_api.seal(forged, "receipt_id")), encoding="utf-8")
                with self.assertRaises(batch.Blocked):
                    feishu_api.acceptance(path)
            # A receipt from the lark-cli days (schema 1, cli_version) no longer opens the production append.
            legacy = {k: v for k, v in data.items() if k not in {"bridge_version", "receipt_id"}}
            legacy.update({"schema": 1, "cli_version": "1.0.98"})
            path = Path(tmp) / "legacy.json"
            path.write_text(json.dumps(feishu_api.seal(legacy, "receipt_id")), encoding="utf-8")
            with self.assertRaises(batch.Blocked):
                feishu_api.acceptance(path)
            # A receipt someone edited by hand fails its digest.
            edited = dict(data)
            edited["passed"] = []
            path = Path(tmp) / "edited.json"
            path.write_text(json.dumps(edited), encoding="utf-8")
            with self.assertRaises(batch.Blocked):
                feishu_api.acceptance(path)

    def test_a_server_that_overwrites_fails_the_probe_and_no_receipt_is_written(self):
        bridge, _ = bridge_with(FakeSheetServer(enforce=False))
        with tempfile.TemporaryDirectory() as tmp:
            receipt = Path(tmp) / "receipt.json"
            with self.assertRaisesRegex(batch.Blocked, "防覆盖探测失败"):
                feishu_api.probe(bridge, receipt)
            self.assertFalse(receipt.exists())

    def test_the_probe_never_overwrites_an_existing_receipt(self):
        bridge, runner = bridge_with(FakeSheetServer())
        with tempfile.TemporaryDirectory() as tmp:
            receipt = Path(tmp) / "receipt.json"
            receipt.write_text("{}", encoding="utf-8")
            with self.assertRaises(batch.Blocked):
                feishu_api.probe(bridge, receipt)
            self.assertEqual(runner.calls, [])


class RealBridgeTests(unittest.TestCase):
    """The Python client against the real bundled bridge (local commands only: nothing here reaches Feishu)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {"LARK_AGENT_USER_DIR": self.tmp.name, "FEISHU_APP_ID": "cli_x", "FEISHU_APP_SECRET": "secret-000000"}
        patcher = mock.patch.dict(os.environ, self.env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_the_bridge_answers_over_the_real_subprocess_boundary(self):
        bridge = feishu_api.Bridge()
        info = bridge.call("info")
        self.assertEqual(info["bridge"], VERSION)
        self.assertEqual(info["storage"], "host")
        status = bridge.call("auth-status")
        self.assertEqual((status["logged_in"], status["app_configured"]), (False, True))
        with self.assertRaisesRegex(batch.Blocked, "尚未授权"):
            bridge.doctor()
        # The allowlist is enforced inside the bridge too.
        with self.assertRaisesRegex(batch.Blocked, "invalid_request"):
            bridge.call("api-get", {"path": "/open-apis/im/v1/messages"})

    def test_the_login_belongs_to_the_directory_the_host_named(self):
        bridge = feishu_api.Bridge()
        self.assertFalse(bridge.call("auth-status")["logged_in"])
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        # A second user's process is a different environment, and nothing of the first is visible to it.
        with mock.patch.dict(os.environ, {"LARK_AGENT_USER_DIR": other.name}):
            self.assertEqual(feishu_api.Bridge().call("auth-status")["storage"], "host")
        self.assertFalse((Path(other.name) / "requirement-auto").exists(), "status alone creates nothing")


class RuntimeAndPathsTests(unittest.TestCase):
    def test_batches_go_to_the_users_own_directory_when_the_host_names_one(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"LARK_AGENT_USER_DIR": tmp}):
            self.assertEqual(batch.default_batch_root(), Path(tmp).resolve() / "requirement-auto" / "batches")
        with mock.patch.dict(os.environ, {"LARK_AGENT_USER_DIR": "relative/dir"}), self.assertRaises(batch.Blocked):
            batch.default_batch_root()
        with mock.patch.dict(os.environ, {"LARK_AGENT_USER_DIR": Path(tempfile.gettempdir()).anchor}), self.assertRaises(batch.Blocked):
            batch.default_batch_root()
        env = {k: v for k, v in os.environ.items() if k != "LARK_AGENT_USER_DIR"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(batch.default_batch_root(), Path(tempfile.gettempdir()) / "gof-requirement")

    def test_the_runtime_check_catches_a_changed_or_extra_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = Path(tmp) / "plugin" / "skills" / "gof-requirement"
            deps = skill / "assets" / "dependencies"
            (deps / "python").mkdir(parents=True)
            (Path(tmp) / "plugin" / "server" / "dist").mkdir(parents=True)
            (Path(tmp) / "plugin" / "server" / "dist" / "bridge.mjs").write_text("//", encoding="utf-8")
            exe = deps / "python" / "python.exe"
            exe.write_bytes(b"MZ")
            manifest = {"schema": skill_runtime.MANIFEST_SCHEMA, "platform": "windows-x64", "python_version": skill_runtime.PYTHON_VERSION,
                        "python_packages": skill_runtime.PYTHON_PACKAGES, "files": {"python/python.exe": skill_runtime.sha256(exe)}}
            (deps / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(skill_runtime.layout(skill, check_platform=False)["bridge"], Path(tmp) / "plugin" / "server" / "dist" / "bridge.mjs")
            (deps / "extra.txt").write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(skill_runtime.RuntimeError, "清单外"):
                skill_runtime.layout(skill, check_platform=False)
            (deps / "extra.txt").unlink()
            exe.write_bytes(b"MZ-changed")
            with self.assertRaisesRegex(skill_runtime.RuntimeError, "摘要"):
                skill_runtime.layout(skill, check_platform=False)
            exe.write_bytes(b"MZ")
            (Path(tmp) / "plugin" / "server" / "dist" / "bridge.mjs").unlink()
            with self.assertRaisesRegex(skill_runtime.RuntimeError, "飞书桥"):
                skill_runtime.layout(skill, check_platform=False)

    def test_the_shipped_manifest_matches_the_bundled_runtime(self):
        runtime = skill_runtime.layout(SKILL)
        self.assertTrue(runtime["bridge"].is_file())
        self.assertEqual(runtime["manifest"]["schema"], skill_runtime.MANIFEST_SCHEMA)


if __name__ == "__main__":
    unittest.main()
