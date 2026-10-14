import copy
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout

import test_gof_batch as existing
import batch
import cls_api
import feishu_api as api


def catalog():
    return {"account": {"id": 1565, "status": 1, "game_ids": [94]}, "can_create": True,
            "games": [{"id": 94, "name": "无尽冬日", "code": "GOFCN"}],
            "directions": [{"id": 390, "name": "2D剪辑", "game_id": 94}],
            "users": [{"id": 653, "name": "张天伟", "status": 1, "roles": ["creative_plan"]},
                      {"id": 663, "name": "北京柒曦文化传媒有限公司（丁杰）", "status": 1, "roles": ["outsource"]}],
            "types": [{"key": "视频", "value": "video", "type": "creative"}],
            "currencies": [{"key": "¥（人民币）", "value": "cny"}], "companies": [], "departments": []}


OBS = {"logged_in": True, "can_create": True, "unpublished": True, "required_complete": True}


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        existing.fixture(self.root / "baseline.xlsx")
        w = existing.openpyxl.load_workbook(self.root / "baseline.xlsx")
        for dv in w.active.data_validations.dataValidation:
            letter = str(dv.sqref)[0]
            dv.sqref = f"{letter}2:{letter}4"
        w.save(self.root / "baseline.xlsx")
        w.close()
        self.snapshot = batch.Snapshot(self.root / "baseline.xlsx")
        self.plan = batch.make_plan(self.snapshot, existing.request())
        self.rules = []
        for spec in self.plan["dropdowns"]:
            self.rules.append({"sheet_id": "ELbWAS", "ranges": [spec["range"].split(":")[0][0] + "2:" + spec["range"].split(":")[0][0] + "4"],
                               "type": "list", "options": spec["options"], "multiple": spec["field"] == "supplier",
                               "highlight": True, "colors": {v: "#bacefd" for v in spec["options"]}})
        self.context = api.seal({"schema": 1, "cli_version": api.VERSION, "target": batch.TARGET,
                               "batch_plan_id": self.plan["plan_id"], "baseline_digest": self.snapshot.fingerprint,
                               "spreadsheet_token": "TESTTOKEN", "sheet_id": "ELbWAS", "revision": 10,
                               "metadata": [], "rules": self.rules,
                               "dropdowns": api.dropdowns(self.plan, "ELbWAS", self.rules)}, "api_plan_id")

    def tearDown(self):
        self.snapshot.close()
        self.temp.cleanup()

    def prepare(self, with_api=False):
        return Path(batch.prepare(self.plan, self.snapshot, self.root,
                                  api_plan=self.context if with_api else None)["batch"])

    def complete(self, path):
        w = existing.openpyxl.load_workbook(self.snapshot.path)
        for row in self.plan["rows"]:
            for coord, value in row["values"].items():
                w.active[coord] = value
        file = path / "complete.xlsx"
        w.save(file)
        w.close()
        return batch.Snapshot(file)

    def test_sixty_typed_rows_only_approved_columns_with_protection(self):
        writes = api.build_writes(self.plan, self.context)
        self.assertEqual(len(writes), 8)
        self.assertTrue(all(w["allow_overwrite"] is False and len(w["cells"]) == 60 for w in writes))
        self.assertEqual({w["range"][0] for w in writes}, set("CDGHIKMN"))
        numbers = next(w for w in writes if w["range"].startswith("C"))
        self.assertEqual([row[0]["value"] for row in numbers["cells"]], list(range(1002, 1062)))
        formulas = next(w for w in writes if w["range"].startswith("G"))
        self.assertTrue(all(row[0]["formula"].startswith("=CONCATENATE") for row in formulas["cells"]))
        supplier = next(w for w in writes if w["range"].startswith("M"))["cells"][0][0]
        self.assertEqual(supplier["multiple_values"], [{"value": "丁杰"}])
        self.assertTrue(supplier["data_validation"]["support_multiple_values"])
        self.assertNotIn("value", supplier)

    def test_context_target_and_tampering_rejected(self):
        invalid = copy.deepcopy(self.context)
        invalid["target"] = batch.TARGET.replace(batch.NODE, "Production")
        invalid.pop("api_plan_id")
        invalid = api.seal(invalid, "api_plan_id")
        with self.assertRaises(batch.Blocked):
            api.build_writes(self.plan, invalid)
        invalid = copy.deepcopy(self.context)
        invalid["sheet_id"] = "other"
        with self.assertRaises(batch.Blocked):
            api.build_writes(self.plan, invalid)

    def test_historical_rules_colors_modes_and_splits_protected(self):
        before = self.rules
        after = copy.deepcopy(before)
        after[0]["ranges"] = ["H2:H2", "H3:H4", "H5:H64"]
        self.assertEqual(api.rule_projection(before, "ELbWAS", self.plan["range"]),
                         api.rule_projection(after, "ELbWAS", self.plan["range"]))
        for field, value in [("multiple", True), ("colors", {"多明星04": "#000000"}), ("options", ["替换"])]:
            mutated = copy.deepcopy(before)
            mutated[0][field] = value
            self.assertNotEqual(api.rule_projection(before), api.rule_projection(mutated))
        hidden = copy.deepcopy(before) + [{**before[0], "ranges": ["Z100:Z100"]}]
        self.assertNotEqual(api.rule_projection(before, "ELbWAS", self.plan["range"]),
                            api.rule_projection(hidden, "ELbWAS", self.plan["range"]))

    def test_api_rule_proof_complements_only_current_xlsx_and_keeps_old_rules(self):
        path = self.prepare(True)
        fresh = self.complete(path)
        after = copy.deepcopy(self.rules)
        for entry, spec in zip(after, self.context["dropdowns"]):
            entry["ranges"].append(spec["range"])
        try:
            with self.assertRaises(batch.Blocked):
                batch.verify(path, fresh)
            api.rule_proof(path / "proof.json", fresh, after, self.context, self.plan)
            evidence = {"transport": "feishu_api", "proof": str(path / "proof.json")}
            self.assertEqual(batch.verify(path, fresh, evidence)["status"], "complete")
            with self.assertRaises(batch.Blocked):
                api.validate_rule_evidence(path, self.snapshot, evidence)
            changed = copy.deepcopy(after)
            changed[0]["colors"][changed[0]["options"][0]] = "#000000"
            with self.assertRaises(batch.Blocked):
                api.rule_proof(path / "bad-proof.json", fresh, changed, self.context, self.plan)
        finally:
            fresh.close()

    def test_missing_capability_receipt_does_not_call_online_writer(self):
        path = self.prepare(True)
        with patch.object(api.Cli, "doctor") as doctor:
            with self.assertRaises(FileNotFoundError):
                api.execute(api.Cli(), path, self.root / "missing.json")
            doctor.assert_not_called()
        bad = api.seal({"schema": 1, "cli_version": api.VERSION, "identity": "user", "probe_workbook": "X",
                        "production_token": "TESTTOKEN", "passed": ["occupied_value"]}, "receipt_id")
        batch.write_json_new(self.root / "bad.json", bad)
        with self.assertRaises(batch.Blocked):
            api.acceptance(self.root / "bad.json")

    def test_append_transport_full_verification_and_concurrent_occupancy_stop(self):
        expected = [["KEEP_EXISTING", '=IF(1=1,"","")']]
        passed = ["occupied_value", "empty_formula", "repeated_occupancy"]
        receipt = api.seal({"schema": 1, "cli_version": api.VERSION, "identity": "user", "probe_workbook": "NEWPROBE",
                           "production_token": "TESTTOKEN", "passed": passed,
                           "observations": [{"case": name, "rejection": "non_empty", "before": expected, "after": expected}
                                            for name in passed]}, "receipt_id")
        receipt_file = self.root / "acceptance.json"
        batch.write_json_new(receipt_file, receipt)
        metadata = [{"title": ws.title, "sheet_id": "ELbWAS" if index == 0 else "OLDER", "index": index,
                     "resource_type": "sheet", "grid_properties": {"row_count": 100, "column_count": 26}}
                    for index, ws in enumerate(self.snapshot.book)]
        testcase = self
        class SimulatedServer:
            def __init__(self, live, race=False):
                self.calls, self.rev, self.applied, self.write_count = [], 10, False, 0
                self.race, self.live = race, live
                shutil.copyfile(testcase.snapshot.path, live)
            def doctor(self):
                return {"identity": "user", "brand": "feishu"}
            def api_read(self, path, params=None):
                if path.endswith("get_node"):
                    return {"node": {"node_token": batch.NODE, "obj_type": "sheet", "obj_token": "TESTTOKEN"}}
                if path.endswith("sheets/query"):
                    return {"sheets": metadata}
                sid = params["range"].split("!")[0]
                rules = []
                if sid == "ELbWAS":
                    for spec, original in zip(testcase.context["dropdowns"], testcase.rules):
                        ranges = original["ranges"] + ([spec["range"]] if self.applied else [])
                        rules.append({"dataValidationType": "list", "conditionValues": spec["options"],
                                      "ranges": [sid + "!" + r for r in ranges], "options": {
                                          "multipleValues": spec["mode"] == "multiple", "highlightValidData": spec["highlight"],
                                          "colorValueMap": dict(zip(spec["options"], spec["colors"]))}})
                return {"sheetId": sid, "dataValidations": rules}
            def sheet(self, command, token, args=(), stdin=None, write=False):
                self.calls.append({"command": ["sheets", command], "write": write, "elapsed_ms": 0})
                if command == "+revision-get":
                    return {"revision": self.rev}
                if command == "+workbook-export":
                    shutil.copyfile(self.live, args[args.index("--output-path") + 1])
                    return {}
                testcase.assertEqual(command, "+cells-set")
                testcase.assertIn("--allow-overwrite=false", args)
                self.write_count += 1
                w = existing.openpyxl.load_workbook(self.live)
                if self.race:
                    w.active["C5"] = '=""'
                    w.save(self.live)
                    w.close()
                    raise batch.Blocked("服务端拒绝并发占用")
                for item in json.loads(stdin):
                    testcase.assertFalse(item["allow_overwrite"])
                    rect = api.CellRange(item["range"])
                    for index, row in enumerate(item["cells"]):
                        cell = row[0]
                        coord = f"{api.get_column_letter(rect.min_col)}{rect.min_row + index}"
                        testcase.assertIsNone(w.active[coord].value)
                        w.active[coord] = cell.get("formula", cell.get("value", cell.get("multiple_values", [{}])[0].get("value")))
                w.save(self.live); w.close()
                self.applied, self.rev = True, 11
                return {"status": "success"}
        path = self.prepare(True)
        server = SimulatedServer(self.root / "live.xlsx")
        self.assertEqual(api.execute(server, path, receipt_file)["status"], "append_verified")
        self.assertTrue(batch.status(path)["append_verified"])
        with self.assertRaises(batch.Blocked):
            api.execute(server, path, receipt_file)
        self.assertEqual(server.write_count, 1)
        reconciled = api.reconcile(server, path)
        self.assertEqual(reconciled["status"], "complete")
        self.assertEqual(server.write_count, 1)
        self.assertTrue(Path(reconciled["report"]).is_file())
        # Separate immutable batch root for the late-occupancy scenario.
        other = Path(batch.prepare(self.plan, self.snapshot, self.root / "race", api_plan=self.context)["batch"])
        server = SimulatedServer(self.root / "race-live.xlsx", True)
        with self.assertRaises(batch.Blocked):
            api.execute(server, other, receipt_file)
        self.assertTrue(batch.status(other)["blocked"])
        self.assertFalse(batch.status(other)["append_verified"])
        w = existing.openpyxl.load_workbook(server.live)
        self.assertEqual(w.active["C5"].value, '=""')
        self.assertEqual(w.active["C2"].value, 1000)
        w.close()

    @patch.object(api, "OFFICIAL_API_ENABLED", True)
    def test_cli_refuses_unsafe_commands_and_never_blindly_retries(self):
        calls = []
        def runner(args, **kw):
            calls.append((args, kw))
            raise subprocess.TimeoutExpired(args[0], 60)
        cli = api.Cli("cli", runner)
        with self.assertRaises(batch.Blocked):
            cli.sheet("+cells-set", "TESTTOKEN", ["--writes", "-"], stdin="[]", write=True)
        self.assertEqual(calls, [])
        with self.assertRaises(batch.Blocked):
            cli.sheet("+cells-set", "TESTTOKEN", ["--writes", "-", "--allow-overwrite=false"], stdin="[]", write=True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["input"], "[]")
        self.assertFalse(calls[0][1]["shell"])
        for command in ["+csv-put", "+history-revert", "+sheet-delete"]:
            with self.assertRaises(batch.Blocked):
                cli.sheet(command, "TESTTOKEN")

    @patch.object(api, "OFFICIAL_API_ENABLED", True)
    def test_cli_partial_truncation_and_credentials_never_report_success(self):
        for data in [{"status": "partial_success"}, {"ranges": [{"truncated": True}]}, {"failed_count": 1}]:
            cli = api.Cli("cli", lambda *a, **k: subprocess.CompletedProcess(a[0], 0, json.dumps({"ok": True, "data": data}), ""))
            with self.assertRaises(batch.Blocked):
                cli.run(["sheets", "+cells-set"], write=True)
        secret = "Bearer DO_NOT_PRINT_THIS"
        cli = api.Cli("cli", lambda *a, **k: subprocess.CompletedProcess(a[0], 1, json.dumps({"ok": False, "error": {"message": secret}}), secret))
        with self.assertRaises(batch.Blocked) as caught:
            cli.run(["api", "GET"])
        self.assertNotIn(secret, str(caught.exception))
        path = self.prepare()
        with self.assertRaises(batch.Blocked):
            batch.record(path, "blocked", evidence={"reason": "test", "Authorization": secret})

    @patch.object(api, "OFFICIAL_API_ENABLED", True)
    def test_permission_failure_is_not_a_proven_occupied_refusal(self):
        for msg in ["Permission denied", "request timeout"]:
            cli = api.Cli("cli", lambda *a, **k: subprocess.CompletedProcess(a[0], 1, json.dumps({"ok": False, "error": {"message": msg}}), ""))
            with self.assertRaises(batch.Blocked) as error:
                cli.run(["sheets", "+cells-set"], write=True)
            self.assertNotIsInstance(error.exception, api.OccupiedRefusal)

    def test_catalog_resolution_aliases_ambiguity_and_optional_fields(self):
        payload, creator, defaults = cls_api.build_payload(self.plan["groups"][0]["request"], catalog())
        self.assertEqual((payload["game_id"], payload["direct_id"], payload["third_user_id"], creator), (94, 390, 663, 653))
        self.assertEqual(payload["status"], -2)
        self.assertNotIn("id", payload)
        self.assertEqual(defaults, {"currency": "cny", "price": 0})
        duplicate = catalog()
        duplicate["users"].append({"id": 2, "name": "另一家公司（丁杰）", "status": 1, "roles": ["outsource"]})
        with self.assertRaises(batch.Blocked):
            cls_api.build_payload(self.plan["groups"][0]["request"], duplicate)
        group = copy.deepcopy(self.plan["groups"][0]["request"])
        group["cls"].update(quotation="12.50", expected_completion="2026-10-20")
        payload, _, defaults = cls_api.build_payload(group, catalog())
        self.assertEqual(payload["price"], 12.5)
        self.assertEqual(payload["expect_end_date"], "2026-10-20")
        self.assertNotIn("price", defaults)
        for price in ["NaN", "Infinity", "-1"]:
            group["cls"]["quotation"] = price
            with self.assertRaises(batch.Blocked):
                cls_api.build_payload(group, catalog())

    def test_api_attempt_requires_existing_verified_batch_and_blocks_duplicates(self):
        path = self.prepare()
        with self.assertRaises(batch.Blocked):
            cls_api.operation(path, "01", "save_draft", catalog(), OBS)
        fresh = self.complete(path)
        try:
            # Legacy fixture proof; retain old validation rules and add new range rules.
            w = existing.openpyxl.load_workbook(fresh.path)
            for spec in self.plan["dropdowns"]:
                dv = existing.DataValidation(type="list", formula1='"' + ",".join(spec["options"]) + '"')
                dv.add(spec["range"])
                w.active.add_data_validation(dv)
            w.save(fresh.path); w.close(); fresh.close()
            fresh = batch.Snapshot(path / "complete.xlsx")
            batch.record(path, "append_started")
            batch.record(path, "append_verified", fresh=fresh)
            batch.record(path, "cls_started", "01")
            op = cls_api.operation(path, "01", "save_draft", catalog(), OBS)
            self.assertEqual(op["action"], "save_draft")
            batch.record(path, "cls_api_attempt", "01", {"action": "save_draft", "operation_id": op["operation_id"], "observations": OBS})
            with self.assertRaises(batch.Blocked):
                cls_api.operation(path, "01", "save_draft", catalog(), OBS)
            batch.record(path, "blocked", evidence={"reason": "unknown"})
            with self.assertRaises(batch.Blocked):
                batch.record(path, "draft_saved", "01", {"confirmed": True, "unpublished": True})
        finally:
            fresh.close()

    def test_csv_immutable_chinese_and_multi_group_content(self):
        path = self.prepare()
        data = cls_api.csv_data(path, self.plan["groups"][0])
        self.assertEqual(data["sha256"], hashlib.sha256((path / self.plan["groups"][0]["csv"]).read_bytes()).hexdigest())
        csv_file = path / self.plan["groups"][0]["csv"]
        csv_file.write_text("bad", encoding="utf-8")
        with self.assertRaises(batch.Blocked):
            cls_api.csv_data(path, self.plan["groups"][0])

    def test_published_receipt_and_wrong_parent_fields_rejected(self):
        payload, _, _ = cls_api.build_payload(self.plan["groups"][0]["request"], catalog())
        wrong = dict(payload, status=-1)
        with self.assertRaises(batch.Blocked):
            cls_api.validate_parent(wrong, payload)
        wrong = dict(payload, third_user_id=1)
        with self.assertRaises(batch.Blocked):
            cls_api.validate_parent(wrong, payload)

    @patch.object(api, "OFFICIAL_API_ENABLED", False)
    @patch.object(api.subprocess, "run", side_effect=AssertionError("hybrid flow must not invoke CLI"))
    def test_api_receipts_record_full_workflow_and_reject_wrong_creator(self, cli_runner):
        path = self.prepare()
        fresh = self.complete(path)
        try:
            w = existing.openpyxl.load_workbook(fresh.path)
            for spec in self.plan["dropdowns"]:
                dv = existing.DataValidation(type="list", formula1='"' + ",".join(spec["options"]) + '"')
                dv.add(spec["range"])
                w.active.add_data_validation(dv)
            w.save(fresh.path); w.close(); fresh.close()
            fresh = batch.Snapshot(path / "complete.xlsx")
            batch.record(path, "append_started")
            batch.record(path, "append_verified", fresh=fresh)
            batch.record(path, "cls_started", "01")
            save = cls_api.operation(path, "01", "save_draft", catalog(), OBS)
            batch.write_json_new(path / "save-op.json", save)
            batch.record(path, "cls_api_attempt", "01", {"action": "save_draft", "operation_id": save["operation_id"], "observations": OBS})
            parent = dict(save["payload"], id=10224, number="GOFCN20261014001", user_id=1565, for_internal=0, sub_scripts=[])
            trace = [{"method": "POST", "path": "/api/workflow/script/save", "http_status": 200, "business_code": 0},
                     {"method": "GET", "path": "/api/workflow/script/10224", "http_status": 200, "business_code": 0}]
            receipt = {"schema": 1, "transport": "cls_api", "status": "verified", "unpublished": True,
                       "action": "save_draft", "operation_id": save["operation_id"], "parent": parent, "calls": trace}
            batch.write_json_new(path / "save-receipt.json", receipt)
            evidence = {"transport": "cls_api", "confirmed": True, "unpublished": True, "draft_id": 10224,
                        "url": "https://creative.centurygames.cn/requirement/10224/edit-outer",
                        "operation": str(path / "save-op.json"), "receipt": str(path / "save-receipt.json"),
                        "requirement_number": parent["number"]}
            batch.record(path, "draft_saved", "01", evidence)
            self.assertNotIn("screenshot", evidence)
            observations = dict(OBS, draft_saved=True, import_enabled=True, import_would_publish=False)
            upload = cls_api.operation(path, "01", "import_scripts", catalog(), observations)
            batch.write_json_new(path / "import-op.json", upload)
            batch.record(path, "cls_api_attempt", "01", {"action": "import_scripts", "operation_id": upload["operation_id"], "observations": observations})
            scripts = [{"id": i + 2000, "script_id": 10224, "name": name, "user_id": 653,
                        "data": upload["expected"]["link"] if i == 0 else "同上", "tags": [{"full_name": batch.FIXED_TAG}]}
                       for i, name in enumerate(upload["expected"]["names"])]
            receipt = dict(receipt, action="import_scripts", operation_id=upload["operation_id"],
                           parent=dict(parent, sub_scripts=scripts), calls=[dict(trace[0], path="/api/workflow/sub-script/multiple-add"), trace[1]])
            batch.write_json_new(path / "import-receipt.json", receipt)
            evidence = dict(evidence, operation=str(path / "import-op.json"), receipt=str(path / "import-receipt.json"),
                            quantity=60, names=self.plan["groups"][0]["names"])
            bad = copy.deepcopy(receipt)
            bad["parent"]["sub_scripts"][0]["user_id"] = 1
            batch.write_json_new(path / "bad-receipt.json", bad)
            with self.assertRaises(batch.Blocked):
                cls_api.validate_batch_receipt(path, "01", dict(evidence, receipt=str(path / "bad-receipt.json")), "scripts_imported")
            batch.record(path, "scripts_imported", "01", evidence)
            audit = batch.report(path)
            self.assertEqual(audit["groups"][0]["scripts_imported"]["draft_id"], 10224)
            self.assertIn("回读时间", audit["evidence_time"])
            self.assertIn("scripts_imported", batch.status(path)["groups"]["01"])
            self.assertIn("GOFCN20261014001", batch.message(path)["message"])
            with self.assertRaises(batch.Blocked):
                cls_api.operation(path, "01", "import_scripts", catalog(), observations)
        finally:
            fresh.close()
        cli_runner.assert_not_called()

    def test_parked_feishu_entrypoints_fail_before_any_cli_call(self):
        commands = [["doctor"], ["snapshot", "--output", str(self.root / "export.xlsx")],
                    ["document", "--url", "https://centurygames.feishu.cn/docx/TestScript"],
                    ["plan", "--request", "absent.json", "--snapshot", "absent.xlsx"],
                    ["prepare", "--plan", "absent.json", "--snapshot", "absent.xlsx", "--workspace", str(self.root)],
                    ["append", "--batch", str(self.root), "--receipt", "absent.json"],
                    ["probe", "--receipt", str(self.root / "receipt.json")]]
        with patch.object(api, "OFFICIAL_API_ENABLED", False), patch.object(api.subprocess, "run") as runner:
            for args in commands:
                with self.subTest(command=args[0]), redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(api.main(args), 2)
                    result = json.loads(output.getvalue())
                    self.assertEqual(result["status"], "blocked")
                    self.assertEqual(result["reason"], api.DISABLED_REASON)
            cli = api.Cli()
            with self.assertRaisesRegex(batch.Blocked, "已停用"):
                cli.doctor()
            with self.assertRaisesRegex(batch.Blocked, "已停用"):
                cli.api_read("/open-apis/wiki/v2/spaces/get_node")
            runner.assert_not_called()
        self.assertFalse((self.root / "export.xlsx").exists())
        self.assertFalse((self.root / "receipt.json").exists())

    def test_default_cli_enabled_and_user_scopes_checked_in_isolated_profile(self):
        self.assertTrue(api.OFFICIAL_API_ENABLED)
        calls = []
        def runner(args, **kwargs):
            calls.append((args, kwargs))
            if "--version" in args:
                return subprocess.CompletedProcess(args, 0, "lark-cli version 1.0.98", "")
            if "status" in args:
                value = {"brand": "feishu", "identity": "user", "verified": True, "identities": {"user": {}}}
            else:
                value = {"ok": True, "granted": list(api.SCOPES), "missing": []}
            return subprocess.CompletedProcess(args, 0, json.dumps(value), "")
        self.assertTrue(api.Cli("unit-cli", runner).doctor()["logged_in"])
        self.assertEqual(len(calls), 3)
        self.assertIn("gof-requirement", calls[1][0])
        self.assertTrue(calls[1][1]["env"]["LARKSUITE_CLI_CONFIG_DIR"].endswith(".state\\feishu-cli"))
        missing = api.Cli("unit-cli", lambda *a, **k: subprocess.CompletedProcess(a[0], 1,
                         json.dumps({"ok": False, "error": "no_token", "missing": list(api.SCOPES)}), ""))
        with self.assertRaises(batch.Blocked):
            missing.check_scopes(api.SCOPES)

    def test_api_batch_cannot_authorize_resending_after_empty_unknown_result(self):
        path = self.prepare(True)
        batch.record(path, "append_started")
        batch.record(path, "blocked", evidence={"reason": "unknown result"})
        with self.assertRaisesRegex(batch.Blocked, "只能回读"):
            batch.record(path, "resumed", evidence={"confirmed": True, "reason": "retry", "retry_append": True,
                                                   "sync_confirmed": True}, fresh=self.snapshot)

    def test_api_receipt_claims_and_missing_readback_cannot_replace_screenshot(self):
        evidence = {"transport": "cls_api", "confirmed": True, "unpublished": True,
                    "url": "https://creative.centurygames.cn/requirement/10224/edit-outer",
                    "draft_id": 10224, "receipt": str(self.root / "missing.json")}
        with self.assertRaises((batch.Blocked, OSError)):
            batch.cls_evidence(evidence)
        ui = {k: v for k, v in evidence.items() if k != "transport"}
        with self.assertRaisesRegex(batch.Blocked, "截图"):
            batch.cls_evidence(ui)


if __name__ == "__main__":
    unittest.main()
