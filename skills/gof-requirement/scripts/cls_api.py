#!/usr/bin/env python3
"""Offline CLS operation builder and receipt validator. Never stores credentials or sends HTTP."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

import batch
from feishu_api import seal, check_seal, reject_secrets

TAG_NAMES = {batch.FIXED_TAG, "玩法卖点（单选必选）/展示向/展示向"}
PARENT_FIELDS = {"game_id", "direct_id", "asset_data", "name", "type", "company", "departments",
                 "marketing_user_id", "third_user_id", "currency", "price", "price_reason",
                 "expect_end_date", "storyboard_end_date", "storyboard_attaches", "draft_end_date",
                 "draft_attaches", "film_end_date", "film_attaches", "status"}


def unique(items, predicate, label):
    found = [item for item in items if predicate(item)]
    batch.require(len(found) == 1, f"{label} 不存在或匹配不唯一，需在计划前澄清")
    return found[0]


def user_match(user, wanted):
    return user["name"] == wanted or wanted in re.findall(r"[（(]([^（）()]+)[）)]", user["name"])


def date_value(value):
    batch.require(value == "" or isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value),
                  "日期需先明确为 YYYY-MM-DD；不猜测日期")
    return value


def build_payload(group, catalog):
    cls = group["cls"]
    batch.require(cls and group["brief"].strip(), "全流程 CLS 字段/备注未收齐")
    game = unique(catalog["games"], lambda x: x["code"] == "GOFCN", "GOFCN 项目")
    user_games = catalog["account"].get("game_ids")
    batch.require(isinstance(user_games, list) and game["id"] in user_games, "当前账号未证明有 GOFCN 权限")
    direction = unique(catalog["directions"], lambda x: x["game_id"] == game["id"] and x["name"] == cls["direction"], "创意方向")
    supplier = unique(catalog["users"], lambda x: x["status"] == 1 and "outsource" in x["roles"]
                      and user_match(x, group["supplier"]), "供应商")
    creator = unique(catalog["users"], lambda x: x["status"] == 1 and x["name"] == group["reviewer"], "创意人")
    task = unique(catalog["types"], lambda x: x["type"] == "creative" and x["key"] == cls["task_type"], "任务类型")
    payload = {"game_id": game["id"], "direct_id": direction["id"], "asset_data": "", "name": cls["requirement_name"],
               "type": task["value"], "company": "", "departments": [], "marketing_user_id": "",
               "third_user_id": supplier["id"], "currency": "cny", "price": 0, "price_reason": group["brief"],
               "expect_end_date": "", "storyboard_end_date": "", "storyboard_attaches": [],
               "draft_end_date": "", "draft_attaches": [], "film_end_date": "", "film_attaches": [], "status": -2}
    if cls.get("currency"):
        payload["currency"] = unique(catalog["currencies"], lambda x: cls["currency"] in (x["key"], x["value"]), "货币")["value"]
    if cls.get("quotation", "") != "":
        try:
            price = Decimal(str(cls["quotation"]))
        except InvalidOperation:
            raise batch.Blocked("报价必须是已确认的金额") from None
        batch.require(price.is_finite() and price >= 0, "报价无效")
        payload["price"] = int(price) if price == price.to_integral_value() else float(price)
    for key, options, field in [("subject", "companies", "company"), ("department", "departments", "departments")]:
        if cls.get(key):
            value = unique(catalog[options], lambda x: cls[key] in (x["key"], x["value"]), key)["value"]
            payload[field] = [value] if key == "department" else value
    if cls.get("market_contact"):
        payload["marketing_user_id"] = unique(catalog["users"], lambda x: x["status"] == 1 and x["name"] == cls["market_contact"], "市场媒介")["id"]
    for key, field in [("expected_completion", "expect_end_date"), ("storyboard_time", "storyboard_end_date"),
                       ("first_draft_time", "draft_end_date"), ("final_cut_time", "film_end_date")]:
        payload[field] = date_value(cls.get(key, ""))
    defaults = {k: payload[k] for k, source in [("currency", "currency"), ("price", "quotation")]
                if cls.get(source, "") == ""}
    return payload, creator["id"], defaults


def csv_data(path, group):
    raw = (path / group["csv"]).read_bytes()
    batch.require(raw.startswith(b"\xef\xbb\xbf") and b"\r\n" in raw, "CSV 编码或换行不符")
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    expected = [batch.CSV_HEADERS] + [[name, group["request"]["script_url"] if i == 0 else "同上", batch.FIXED_TAG]
                                    for i, name in enumerate(group["names"])]
    batch.require(rows == expected, "CSV 与获批组不一致，禁止导入")
    return {"filename": group["csv"], "sha256": hashlib.sha256(raw).hexdigest(),
            "base64": base64.b64encode(raw).decode("ascii")}


def operation(path, group_id, action, catalog, observations):
    path, manifest = batch.load_batch(path)
    reject_secrets(catalog)
    batch.require(action in {"save_draft", "import_scripts"}, "只允许草稿创建和脚本导入")
    group = batch.group_for(manifest["plan"], group_id)
    batch.require(catalog.get("can_create") is True and catalog["account"].get("status") == 1,
                  "未证明当前 CLS 登录及建单权限")
    batch.cls_check(path, group_id, action, observations)
    payload, creator_id, defaults = build_payload(group["request"], catalog)
    expected = {"names": group["names"], "quantity": group["request"]["quantity"], "creator_id": creator_id,
                "link": group["request"]["script_url"], "tag_names": sorted(TAG_NAMES)}
    result = {"schema": 1, "action": action, "plan_id": manifest["plan"]["plan_id"], "group": group_id,
              "account_id": catalog["account"]["id"], "payload": payload, "native_defaults": defaults, "expected": expected}
    if action == "import_scripts":
        saved = [e for e in batch.events(path) if e.get("group") == group_id and e["step"] == "draft_saved"]
        batch.require(len(saved) == 1 and saved[0]["evidence"].get("draft_id"), "原批次没有可核对的草稿 ID；先核对旧工单")
        result["draft_id"] = saved[0]["evidence"]["draft_id"]
        result["csv"] = csv_data(path, group)
    return seal(result, "operation_id")


def validate_receipt(evidence):
    receipt = batch.read_json(evidence.get("receipt", ""))
    reject_secrets(receipt)
    batch.require(receipt.get("schema") == 1 and receipt.get("transport") == "cls_api"
                  and receipt.get("status") == "verified" and receipt.get("unpublished") is True,
                  "缺少已回读验证的 CLS 接口记录")
    parent = receipt.get("parent", {})
    batch.require(type(parent.get("id")) is int and parent["id"] > 0 and parent.get("status") == -2,
                  "CLS 需求未证明为草稿")
    batch.require(evidence.get("draft_id") == parent["id"] and evidence.get("url") ==
                  f"https://creative.centurygames.cn/requirement/{parent['id']}/edit-outer", "草稿入口与接口 ID 不匹配")
    if evidence.get("requirement_number") is not None:
        batch.require(evidence["requirement_number"] == parent.get("number"), "需求编号不是实际接口返回值")
    for call in receipt.get("calls", []):
        allowed = {(c[0], c[1]) for c in [("POST", "/api/workflow/script/save"), ("POST", "/api/workflow/sub-script/multiple-add")]}
        allowed.update({("GET", f"/api/workflow/script/{parent['id']}")})
        batch.require((call.get("method"), call.get("path")) in allowed and call.get("business_code") == 0
                      and 200 <= call.get("http_status", 0) < 300, "接口调用记录包含失败或未许可动作")
    batch.require(receipt.get("calls"), "接口记录没有回读证据")
    last = receipt["calls"][-1]
    batch.require(last.get("method") == "GET" and last.get("path") == f"/api/workflow/script/{parent['id']}",
                  "接口记录必须以完整草稿回读结束")
    batch.require(sum(c.get("method") == "POST" for c in receipt["calls"]) <= 1, "接口记录包含重复写请求")
    return receipt


def validate_parent(parent, payload):
    for key, expected in payload.items():
        if key == "asset_data":
            continue  # This field belongs to the separate asset object; always blank in this skill.
        actual = parent.get(key)
        if key == "price":
            try:
                equal = Decimal(str(actual)) == Decimal(str(expected))
            except InvalidOperation:
                equal = False
        elif expected == "" and actual is None:
            equal = True  # Backend persists unfilled dates/optional IDs as null.
        else:
            equal = actual == expected
        batch.require(equal, f"CLS 回读字段不符：{key}")


def validate_batch_receipt(path, group_id, evidence, step):
    path, manifest = batch.load_batch(path)
    receipt_path = Path(evidence.get("receipt", "")).resolve()
    operation_path = Path(evidence.get("operation", "")).resolve()
    batch.require(path in receipt_path.parents and path in operation_path.parents, "CLS 记录必须位于本批目录")
    op = batch.read_json(operation_path)
    check_seal(op, "operation_id")
    batch.require(op["plan_id"] == manifest["plan"]["plan_id"] and op["group"] == group_id,
                  "接口记录不属于本批/本组")
    receipt = validate_receipt(evidence)
    batch.require(receipt["parent"].get("user_id") == op["account_id"]
                  and receipt["parent"].get("for_internal") in (0, False), "草稿账号/外包归属不符")
    batch.require(receipt.get("operation_id") == op["operation_id"] and receipt.get("action") == op["action"], "接口请求摘要不匹配")
    attempts = [e for e in batch.events(path) if e.get("group") == group_id and e["step"] == "cls_api_attempt"
                and e["evidence"].get("operation_id") == op["operation_id"]]
    batch.require(len(attempts) == 1, "必须先记录本次接口尝试；不可重复请求")
    group = batch.group_for(manifest["plan"], group_id)
    batch.require(op["payload"]["name"] == group["request"]["cls"]["requirement_name"]
                  and op["payload"]["price_reason"] == group["request"]["brief"], "需求名称/备注与获批需求不符")
    batch.require(op["expected"]["names"] == group["names"] and op["expected"]["creator_id"] > 0
                  and op["expected"]["link"] == group["request"]["script_url"], "请求与获批需求不匹配")
    validate_parent(receipt["parent"], op["payload"])
    scripts = receipt["parent"].get("sub_scripts", [])
    if step == "draft_saved":
        batch.require(op["action"] == "save_draft" and not scripts, "新建草稿存在计划外脚本")
    else:
        batch.require(op["action"] == "import_scripts" and receipt["parent"]["id"] == op["draft_id"]
                      and len(scripts) == len(group["names"]), "导入数量/草稿不符")
        batch.require(len({s["id"] for s in scripts}) == len(scripts), "返回脚本 ID 重复")
        for index, (script, name) in enumerate(zip(scripts, group["names"])):
            batch.require(script["name"] == name and script["user_id"] == op["expected"]["creator_id"]
                          and script["data"] == (op["expected"]["link"] if index == 0 else "同上")
                          and any(t.get("full_name") in TAG_NAMES for t in script.get("tags", [])), "脚本名称/创意人/链接/标签不符")


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true", help="只读匹配完整计划中的 CLS 字段")
    parser.add_argument("--request")
    parser.add_argument("--batch")
    parser.add_argument("--group")
    parser.add_argument("--action", choices=["save_draft", "import_scripts"])
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--observations")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    try:
        if args.preview:
            batch.require(args.request and not any((args.batch, args.group, args.action, args.output, args.observations)), "preview 只接受 request/catalog")
            cat = batch.read_json(args.catalog)
            reject_secrets(cat)
            batch.require(cat.get("can_create") is True, "没有建单权限")
            req = batch.normalize_request(batch.read_json(args.request))
            result = []
            for index, group in enumerate(req["groups"], 1):
                payload, creator, defaults = build_payload(group, cat)
                result.append({"group": f"{index:02d}", "payload": payload, "creator_id": creator, "native_defaults": defaults})
            print(batch.canonical({"status": "cls_plan", "groups": result}))
            return 0
        batch.require(all((args.batch, args.group, args.action, args.observations, args.output)), "需本批、组、动作、观察和新输出路径")
        path = Path(args.batch).resolve()
        output = Path(args.output).resolve()
        batch.require(path in output.parents and not output.exists(), "操作文件须新建于本批目录内")
        op = operation(path, args.group, args.action, batch.read_json(args.catalog), batch.read_json(args.observations))
        batch.write_json_new(output, op)
        print(batch.canonical({"status": "operation_ready", "operation": str(output), "operation_id": op["operation_id"],
                               "native_defaults": op["native_defaults"]}))
        return 0
    except (batch.Blocked, OSError, ValueError, KeyError, TypeError) as exc:
        print(batch.canonical({"status": "blocked", "reason": str(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
