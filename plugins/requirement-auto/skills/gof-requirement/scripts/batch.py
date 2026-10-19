#!/usr/bin/env python3
"""Local GOFCN planning, append verification and artifact generation. No network/UI writes."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree.ElementTree import fromstring, tostring

import openpyxl
from openpyxl.formula.translate import Translator
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.cell_range import CellRange

NODE = "YFyywzwLsiT07EkpBaecr8nIncn"
TARGET = f"https://centurygames.feishu.cn/wiki/{NODE}"
FIXED_TAG = "玩法卖点（单选，必选）/展示向/展示向"
CSV_HEADERS = ["脚本名称", "脚本内容", "创意标签"]
FIELD_HEADERS = {
    "number": "素材编号", "keyword": "提炼词", "name": "素材名称",
    "primary_tag": "一级标签", "secondary_tag": "二级标签",
    "creative_form": "创意形式", "client": "客户端", "supplier": "供应商",
    "creator": "创意者", "creative_expression": "创意表达",
    "creative_batch": "创意批次", "head_reference": "片头引用",
    "creative_reference": "创意引用",
}
REQUIRED_HEADERS = {"number", "keyword", "name", "primary_tag", "secondary_tag",
                    "creative_form", "client", "supplier", "creator"}
REQUIRED_TEXT = {"material_name", "keyword", "creative_form", "supplier", "reviewer", "script_url"}
OPTIONAL_FIELDS = {"creative_expression", "creative_batch", "head_reference", "creative_reference"}
CLS_REQUIRED = {"direction", "task_type", "requirement_name"}
CLS_OPTIONAL = {"subject", "department", "market_contact", "currency", "quotation",
                "expected_completion", "storyboard_time", "first_draft_time", "final_cut_time"}


class Blocked(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Blocked(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def default_batch_root():
    """Where batches go unless told otherwise.

    The host (lark-agent) names the user this process serves in LARK_AGENT_USER_DIR: batches then live in that user's own
    directory, never in a folder shared with other users. Without it (a single local user) the system temp folder is used.
    """
    user_dir = os.environ.get("LARK_AGENT_USER_DIR", "").strip()
    if not user_dir:
        return Path(tempfile.gettempdir()) / "gof-requirement"
    path = Path(user_dir)
    require(path.is_absolute() and "\0" not in user_dir, "LARK_AGENT_USER_DIR 必须是绝对路径")
    path = path.resolve()
    require(path.parent != path, "LARK_AGENT_USER_DIR 不能是磁盘根目录")
    return path / "requirement-auto" / "batches"


def read_json(path):
    with Path(path).open(encoding="utf-8-sig") as handle:
        return json.load(handle)


def write_json_new(path, data):
    with Path(path).open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def check_target(url):
    p = urlsplit(url)
    require(p.scheme == "https" and p.hostname == "centurygames.feishu.cn"
            and p.port in (None, 443) and not p.username and not p.password
            and p.path.rstrip("/") == f"/wiki/{NODE}", "实际页面不是获准的测试进度表节点")


def check_cls_url(url):
    p = urlsplit(url)
    require(p.scheme == "https" and p.hostname == "creative.centurygames.cn"
            and p.port in (None, 443) and not p.username and not p.password,
            "草稿 URL 必须是实际 CLS 页面")


def cell_text(value, label):
    require(isinstance(value, str), f"{label} 必须是文本")
    require(not any(ch in value for ch in "\t\r\n\x00"), f"{label} 不能包含表格分隔符或换行")
    require(not value.lstrip().startswith("="), f"{label} 不能作为公式粘贴")
    return value


def normalize_request(request):
    require(isinstance(request, dict) and set(request) <= {"worksheet", "groups"}, "请求有未知字段/目标覆盖")
    groups = request.get("groups")
    require(isinstance(groups, list) and groups, "需要至少一个供应商/题材组")
    normalized = []
    allowed = REQUIRED_TEXT | OPTIONAL_FIELDS | {"quantity", "topic", "primary_tag", "secondary_tag",
                                                "creator", "client", "brief", "cls"}
    for index, raw in enumerate(groups, 1):
        require(isinstance(raw, dict) and set(raw) <= allowed, f"第 {index} 组有未知字段")
        q = raw.get("quantity")
        require(type(q) is int and q > 0, "quantity 必须是正整数")
        require(REQUIRED_TEXT <= raw.keys(), f"第 {index} 组缺少需求字段：提炼词、素材名称、创意形式、供应商、审核人、脚本内容链接")
        g = {"quantity": q}
        for key in REQUIRED_TEXT:
            require(isinstance(raw[key], str) and raw[key].strip(), f"缺少 {key}")
            g[key] = cell_text(raw[key], key)
        # A user-supplied historical number is a naming example, never a new ID.
        g["material_name"] = re.sub(r"^GOFCN\d+_", "", g["material_name"])
        suffix = f"_{g['creative_form']}_{g['keyword']}"
        require(g["material_name"].endswith(suffix), "素材名称与创意形式/提炼词不一致，请澄清")
        topic = g["material_name"][:-len(suffix)]
        g["topic"] = cell_text(raw.get("topic", topic), "topic")
        require(g["topic"] == topic, "题材与素材名称不一致")
        inferred = topic.split("_", 1)
        for index_tag, key in enumerate(("primary_tag", "secondary_tag")):
            value = raw.get(key, inferred[index_tag] if len(inferred) == 2 else "")
            g[key] = cell_text(value, key)
            require(g[key].strip(), "无法从素材名称确定一二级标签，需先根据名称推理")
        g["creator"] = g["reviewer"]  # Same person for progress reviewer, CLS creator and message.
        require(raw.get("creator", g["reviewer"]) == g["reviewer"], "审核人与进度表创意者字段不一致")
        for key in {"client"} | OPTIONAL_FIELDS:
            require(raw.get(key, "") == "", f"进度表阶段 {key} 应留空")
            g[key] = ""
        g["brief"] = raw.get("brief", "")
        require(isinstance(g["brief"], str), "brief 必须是文本")
        p = urlsplit(g["script_url"])
        require(p.scheme == "https" and p.hostname == "centurygames.feishu.cn"
                and not p.username and not p.password and p.port in (None, 443)
                and re.fullmatch(r"/(wiki|docx)/[A-Za-z0-9]+/?", p.path), "脚本链接必须是当前确认的飞书文档")
        cls = raw.get("cls", {})
        require(isinstance(cls, dict) and set(cls) <= CLS_REQUIRED | CLS_OPTIONAL, "CLS 字段未知")
        if cls:
            for key in CLS_REQUIRED:
                require(isinstance(cls.get(key), str) and cls[key].strip(), f"缺少 CLS {key}")
        for value in cls.values():
            require(isinstance(value, (str, int, float)) and not isinstance(value, bool), "CLS 字段必须是明确的文本/数值")
        g["cls"] = dict(cls)
        normalized.append(g)
    result = {"groups": normalized}
    if "worksheet" in request:
        require(isinstance(request["worksheet"], str) and request["worksheet"].strip(), "工作表名称不能为空")
        result["worksheet"] = request["worksheet"]
    return result


def columns(ws):
    result = {}
    for cell in ws[1]:
        text = re.sub(r"\s+", "", str(cell.value or ""))
        for field, stem in FIELD_HEADERS.items():
            matched = stem in text if field == "supplier" else text.startswith(stem)
            if field == "creator":
                matched = any(text.startswith(header) for header in (stem, "审核人", "脚本审核人"))
            if matched:
                require(field not in result, f"{ws.title} 的 {stem} 表头不唯一")
                result[field] = cell.column
    require(REQUIRED_HEADERS <= result.keys(), f"{ws.title} 不是完整创意进度表")
    return result


def xml_signature(obj):
    return tostring(obj.to_tree(), encoding="unicode")


def style_signature(cell):
    return digest([xml_signature(cell.font), xml_signature(cell.fill), xml_signature(cell.border),
                   xml_signature(cell.alignment), xml_signature(cell.protection), cell.number_format])


def content(cell):
    return cell.value is not None or cell.comment is not None or cell.hyperlink is not None


class Snapshot:
    def __init__(self, path):
        self.path = Path(path)
        require(self.path.suffix.lower() == ".xlsx", "保护检查必须使用 XLSX（包含公式），不是 CSV")
        self.book = openpyxl.load_workbook(self.path, data_only=False, keep_links=True)
        self.cells = {}
        self.last = {}
        self.meta = {}
        self._styles = {}
        for ws in self.book:
            require(ws.max_row * ws.max_column <= 4_000_000, f"{ws.title} 的扫描范围过大，不能证明安全")
            data = {}
            last = 1
            for row in ws.iter_rows():
                for c in row:
                    if content(c):
                        last = max(last, c.row)
                    if content(c) or c.has_style:
                        style = self._styles.setdefault(c.style_id, style_signature(c)) if c.style_id not in self._styles else self._styles[c.style_id]
                        data[c.coordinate] = {
                            "value": c.value, "type": c.data_type if c.value is not None else None,
                            "style": style,
                            "comment": [c.comment.author, c.comment.text] if c.comment else None,
                            "link": [c.hyperlink.target, c.hyperlink.location] if c.hyperlink else None,
                        }
            self.cells[ws.title] = data
            self.last[ws.title] = last
            self.meta[ws.title] = {
                "state": ws.sheet_state,
                "merges": sorted(str(r) for r in ws.merged_cells.ranges),
                "rows": {str(k): [v.height, v.hidden, v.outlineLevel, v.collapsed,
                                    style_signature(v) if v.has_style else None]
                         for k, v in ws.row_dimensions.items()},
                "columns": {k: [v.min, v.max, v.width, v.hidden, v.outlineLevel, v.collapsed,
                                 style_signature(v) if v.has_style else None]
                            for k, v in ws.column_dimensions.items()},
                "filter": xml_signature(ws.auto_filter), "protection": xml_signature(ws.protection),
            }
        self.rules = validation_projection(self)
        self.fingerprint = digest({"cells": self.cells, "meta": self.meta,
                                   "rules": self.rules, "order": self.book.sheetnames})

    def close(self):
        self.book.close()


def validation_projection(snapshot, allowed=None):
    """Compare per-column union intervals, independent of rule splitting/order."""
    result = []
    for ws in snapshot.book:
        buckets = defaultdict(list)
        for rule in ws.data_validations.dataValidation:
            tree = rule.to_tree()
            tree.attrib.pop("sqref", None)
            signature = tostring(tree, encoding="unicode")
            for rect in rule.sqref.ranges:
                for col in range(rect.min_col, rect.max_col + 1):
                    ranges = [(rect.min_row, rect.max_row)]
                    if allowed and allowed[0] == ws.title and allowed[1].min_col <= col <= allowed[1].max_col:
                        a = allowed[1]
                        ranges = []
                        if rect.min_row < a.min_row:
                            ranges.append((rect.min_row, min(rect.max_row, a.min_row - 1)))
                        if rect.max_row > a.max_row:
                            ranges.append((max(rect.min_row, a.max_row + 1), rect.max_row))
                    buckets[(col, signature)].extend((lo, hi) for lo, hi in ranges if lo <= hi)
        for (col, signature), ranges in sorted(buckets.items()):
            if not ranges:
                continue
            merged = []
            for lo, hi in sorted(ranges):
                if merged and lo <= merged[-1][1] + 1:
                    merged[-1][1] = max(hi, merged[-1][1])
                else:
                    merged.append([lo, hi])
            result.append([ws.title, col, signature, merged])
    return result


def candidates(snapshot):
    result = {}
    for ws in snapshot.book:
        if "GOFCN" not in ws.title.upper():
            continue
        try:
            result[ws.title] = columns(ws)
        except Blocked:
            continue
    require(result, "找不到完整 GOFCN 进度工作表")
    return result


def sheet_period(name):
    m = re.search(r"(\d{2,4})年(\d{1,2})月(?:\s*[-至]\s*(\d{1,2})月)?", name)
    if not m:
        return None
    year, month = int(m[1]), int(m[3] or m[2])
    if year < 100:
        year += 2000
    return (year, month) if 1 <= month <= 12 else None


def choose_sheet(snapshot, request, current):
    tables = candidates(snapshot)
    explicit = request.get("worksheet") or current
    if explicit:
        require(explicit in tables, "指定/当前工作表不存在或列结构不匹配，请澄清")
        return explicit, tables
    dated = [(sheet_period(name), name) for name in tables if sheet_period(name)]
    require(dated, "没有可识别年月的工作表，请指定")
    latest = max(p for p, _ in dated)
    names = [name for p, name in dated if p == latest]
    require(len(names) == 1, "最新工作表有并列，请指定")
    return names[0], tables


def collect_ids(snapshot, tables, warnings=None):
    identifiers = {}
    warnings = warnings if warnings is not None else []
    for name, cols in tables.items():
        ws = snapshot.book[name]
        for r in range(2, snapshot.last[name] + 1):
            raw = ws.cell(r, cols["number"]).value
            existing_name = ws.cell(r, cols["name"]).value
            number = None
            if raw not in (None, ""):
                require(not isinstance(raw, bool) and re.fullmatch(r"\d+", str(raw)), f"{name}!{r} 有非法素材编号")
                number = int(raw)
                require(number > 0, "现有素材编号必须为正数")
            literal = re.match(r"^GOFCN(\d+)(?:_|$)", existing_name or "") if isinstance(existing_name, str) else None
            if literal:
                named = int(literal[1])
                if number is not None and named != number:
                    warnings.append(f"历史编号与名称不一致：{name}!{r}，两者均保留并参与避让")
                    identifiers.setdefault(named, [name, r])
                else:
                    number = named
            if isinstance(existing_name, str) and existing_name.startswith("=") and raw in (None, ""):
                # An existing naming formula without a number cannot be assigned safely.
                require('"GOFCN"' not in existing_name.upper(), f"{name}!{r} 有缺失编号的命名公式")
            if number is not None:
                if number in identifiers:
                    warnings.append(f"历史编号重复：{number}，{identifiers[number][0]}!{identifiers[number][1]} / {name}!{r}；不修改")
                else:
                    identifiers[number] = [name, r]
    require(identifiers, "没有可继续的 GOFCN 编号，请澄清起始编号")
    return identifiers


def concatenate(formula, row_values):
    m = re.fullmatch(r"=(?:CONCATENATE|CONCAT)\((.*)\)", formula, re.I)
    require(m is not None, "命名公式不是受支持的 CONCATENATE/CONCAT，不能推测")
    tokens = re.findall(r'"(?:[^"]|"")*"|\$?[A-Z]+\$?\d+|,', m[1], re.I)
    cleaned = re.sub(r'"(?:[^"]|"")*"|\s+', lambda match: "" if match[0].isspace() else match[0], m[1])
    require("".join(tokens) == cleaned, "命名公式含未支持的表达式")
    require(tokens and len(tokens) % 2 == 1 and all(t == "," for t in tokens[1::2]), "命名公式参数格式不支持")
    output = []
    for token in tokens[::2]:
        if token.startswith('"'):
            output.append(token[1:-1].replace('""', '"'))
        else:
            coord = token.replace("$", "").upper()
            require(coord in row_values, "命名公式引用本批未批准的字段或跨行引用")
            value = row_values[coord]
            output.append("" if value is None else str(value))
    return "".join(output)


def inline_options(rule):
    f = rule.formula1 or ""
    require(rule.type == "list" and f.startswith('"') and f.endswith('"'), "下拉选项来源不是可可靠保留的自定义列表")
    return f[1:-1].replace('""', '"').split(",")


def options_for(ws, col, last):
    found = []
    for rule in ws.data_validations.dataValidation:
        for area in rule.sqref.ranges:
            if area.min_col <= col <= area.max_col and area.min_row <= last:
                found.append((min(last, area.max_row), rule))
    if not found:
        return []
    nearest = max(end for end, _ in found)
    options = []
    for end, rule in found:
        if end == nearest:
            for value in inline_options(rule):
                if value not in options:
                    options.append(value)
    return options


def safe_filename(value):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" .")[:80]


def make_plan(snapshot, request, current=None):
    request = normalize_request(request)
    sheet, tables = choose_sheet(snapshot, request, current)
    ws, cols = snapshot.book[sheet], tables[sheet]
    require(not ws.protection.sheet, "导出工作表受保护，请核对实际编辑权限")
    warnings = []
    identifiers = collect_ids(snapshot, tables, warnings)
    start_number = max(identifiers) + 1
    start_row = snapshot.last[sheet] + 1
    total = sum(g["quantity"] for g in request["groups"])
    end_row = start_row + total - 1
    require(end_row <= 1048576, "追加超出工作表行数")
    optional_used = {k for g in request["groups"] for k in OPTIONAL_FIELDS if g[k] != ""}
    require(optional_used <= cols.keys(), "本批可选字段在工作表中没有对应列")
    used = REQUIRED_HEADERS | optional_used
    left, right = min(cols[k] for k in used), max(cols[k] for k in used)
    area = CellRange(min_col=left, max_col=right, min_row=start_row, max_row=end_row)
    for merged in ws.merged_cells.ranges:
        require(merged.max_row < area.min_row or merged.min_row > area.max_row
                or merged.max_col < area.min_col or merged.min_col > area.max_col, "追加范围与合并单元格相交")
    formula_cell = next((ws.cell(r, cols["name"]) for r in range(start_row - 1, 1, -1)
                         if ws.cell(r, cols["name"]).data_type == "f"), None)
    require(formula_cell is not None, "没有可继承的命名公式")
    rows, groups = [], []
    cursor = 0
    for index, g in enumerate(request["groups"], 1):
        names, group_rows = [], []
        for _ in range(g["quantity"]):
            r, number = start_row + cursor, start_number + cursor
            values = {f"{get_column_letter(c)}{r}": None for c in range(left, right + 1)}
            for field in used - {"name"}:
                values[f"{get_column_letter(cols[field])}{r}"] = number if field == "number" else (g[field] if g[field] != "" else None)
            name_coord = f"{get_column_letter(cols['name'])}{r}"
            formula = Translator(formula_cell.value, origin=formula_cell.coordinate).translate_formula(name_coord)
            name = concatenate(formula, values)
            require(name.startswith(f"GOFCN{number}_"), "命名公式未产生正确 GOFCN 编号")
            require(name == f"GOFCN{number}_{g['material_name']}", "命名公式/推理标签与用户素材名称不一致，请澄清")
            values[name_coord] = formula
            rows.append({"row": r, "number": number, "name": name, "values": values, "group": f"{index:02d}"})
            names.append(name)
            group_rows.append(r)
            cursor += 1
        filename = f"创意脚本_{index:02d}_{safe_filename(g['topic'])}_{safe_filename(g['creative_form'])}_{safe_filename(g['supplier'])}.csv"
        groups.append({"id": f"{index:02d}", "csv": filename, "names": names,
                       "rows": group_rows, "request": g})
    dropdowns = []
    fields = ["primary_tag", "secondary_tag", "creative_form", "client", "supplier", "creator", "creative_expression"]
    for field in fields:
        wanted = list(dict.fromkeys(g[field] for g in request["groups"] if g[field]))
        if not wanted or field not in cols:
            continue
        existing = options_for(ws, cols[field], start_row - 1)
        require(all("," not in value and '"' not in value for value in wanted), "下拉标签含逗号/引号，需人工核对规则")
        combined = existing + [value for value in wanted if value not in existing]
        letter = get_column_letter(cols[field])
        dropdowns.append({"field": field, "range": f"{letter}{start_row}:{letter}{end_row}",
                          "options": combined, "missing": [v for v in wanted if v not in existing],
                          "mode": "multiple" if field == "creative_expression" else "single"})
    plan = {"schema": 1, "target": TARGET, "worksheet": sheet, "current_sheet": current,
            "request": request, "baseline_digest": snapshot.fingerprint, "columns": cols,
            "range": str(area), "quantity": total, "first_number": start_number,
            "last_number": start_number + total - 1, "rows": rows, "groups": groups, "dropdowns": dropdowns,
            "history_warnings": warnings}
    plan["plan_id"] = digest(plan)[:24]
    return plan


def load_batch(path):
    path = Path(path).resolve()
    manifest = read_json(path / "manifest.json")
    plan = manifest["plan"]
    unsealed = dict(plan)
    token = unsealed.pop("plan_id")
    require(digest(unsealed)[:24] == token and path.name == token, "批次清单损坏或目录与计划不匹配")
    require(manifest["baseline_sha256"] == hashlib.sha256((path / "baseline.xlsx").read_bytes()).hexdigest(), "基线文件发生变化")
    for name, expected in manifest["artifacts"].items():
        require(Path(name).name == name and hashlib.sha256((path / name).read_bytes()).hexdigest() == expected,
                f"批次文件发生变化：{name}")
    return path, manifest


def clipboard_tsv(plan):
    area = CellRange(plan["range"])
    lines = []
    for row in plan["rows"]:
        cells = []
        for col in range(area.min_col, area.max_col + 1):
            value = row["values"][f"{get_column_letter(col)}{row['row']}"]
            value = "" if value is None else str(value)
            require(not any(ch in value for ch in "\t\r\n"), "剪贴板单元格包含分隔符，不能生成原始 TSV")
            cells.append(value)
        lines.append("\t".join(cells))
    return "\r\n".join(lines) + "\r\n"


def prepare(plan, snapshot, workspace=None, api_plan=None, *, output_root=None):
    require(plan == make_plan(snapshot, plan["request"], plan.get("current_sheet")), "当前快照与获批计划不同，需更新计划并重新确认")
    if api_plan is not None:
        from feishu_api import check_seal
        check_seal(api_plan, "api_plan_id")
        check_target(api_plan.get("target", ""))
        require(api_plan.get("batch_plan_id") == plan["plan_id"]
                and api_plan.get("baseline_digest") == snapshot.fingerprint, "接口计划与本批快照不匹配")
    tsv = clipboard_tsv(plan)
    require(not (workspace is not None and output_root is not None), "--workspace 与 --output-root 不能同时使用")
    base = (Path(output_root).resolve() if output_root is not None else
            Path(workspace).resolve() / "outputs" / "gof-requirement" if workspace is not None else
            default_batch_root())
    base.mkdir(parents=True, exist_ok=True)
    path = base / plan["plan_id"]
    path.mkdir(exist_ok=False)
    # No in-place rewrite or rollback of a partially generated batch.
    with snapshot.path.open("rb") as source, (path / "baseline.xlsx").open("xb") as output:
        shutil.copyfileobj(source, output)
    with (path / "append.tsv").open("x", encoding="utf-8", newline="") as handle:
        # Browser clipboard TSV is not CSV: quoting formulas makes them literal text.
        handle.write(tsv)
    for group in plan["groups"]:
        with (path / group["csv"]).open("x", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\r\n")
            writer.writerow(CSV_HEADERS)
            for index, name in enumerate(group["names"]):
                link = group["request"]["script_url"]
                writer.writerow([name, link if index == 0 else "同上", FIXED_TAG])
    files = ["append.tsv"] + [g["csv"] for g in plan["groups"]]
    if api_plan is not None:
        write_json_new(path / "api-plan.json", api_plan)
        files.append("api-plan.json")
    manifest = {"plan": plan, "baseline_sha256": hashlib.sha256((path / "baseline.xlsx").read_bytes()).hexdigest(),
                "artifacts": {name: hashlib.sha256((path / name).read_bytes()).hexdigest() for name in files}}
    write_json_new(path / "manifest.json", manifest)
    (path / "events").mkdir()
    return {"status": "prepared", "batch": str(path), "range": plan["range"], "csv": [g["csv"] for g in plan["groups"]]}


def events(path):
    records = []
    previous = ""
    for index, file in enumerate(sorted((path / "events").glob("*.json")), 1):
        require(file.name == f"{index:06d}.json", "批次事件缺失/排序异常")
        event = read_json(file)
        require(event.get("previous") == previous, "批次事件链损坏")
        token = event.pop("event_id")
        require(digest(event) == token, "批次事件被修改")
        event["event_id"] = token
        records.append(event)
        previous = token
    return records


def status(path):
    path, manifest = load_batch(path)
    records = events(path)
    blocked = False
    for event in records:
        if event["step"] in {"blocked", "resumed"}:
            blocked = event["step"] == "blocked"
    return {"status": "recorded", "plan_id": manifest["plan"]["plan_id"], "events": records,
            "append_verified": any(e["step"] == "append_verified" for e in records),
            "blocked": blocked,
            "groups": {g["id"]: [e["step"] for e in records if e.get("group") == g["id"]]
                       for g in manifest["plan"]["groups"]}}


def filter_extends_only_into_append(before, after, area):
    if not before or not after:
        return False
    try:
        old, new = fromstring(before), fromstring(after)
        old_range, new_range = CellRange(old.attrib["ref"]), CellRange(new.attrib["ref"])
        if not (old_range.min_col == new_range.min_col and old_range.max_col == new_range.max_col
                and old_range.min_row == new_range.min_row and old_range.max_row < new_range.max_row
                and old_range.max_row + 1 >= area.min_row and new_range.max_row == area.max_row):
            return False
        new.set("ref", old.attrib["ref"])
        return tostring(old) == tostring(new)
    except (ValueError, KeyError):
        return False


def ui_validates_omitted_dropdown(spec, evidence, fresh, sheet, value):
    if not isinstance(evidence, list):
        return False
    matches = [item for item in evidence if isinstance(item, dict)
               and item.get("worksheet") == sheet and item.get("range") == spec["range"]]
    if len(matches) != 1:
        return False
    item = matches[0]
    options = item.get("options")
    if not (item.get("confirmed") is True and item.get("saved") is True
            and item.get("source") == "custom" and item.get("reason") == "xlsx_omits_inline_rule"
            and item.get("snapshot_digest") == fresh.fingerprint
            and item.get("mode") in {"single", "multiple"}
            and isinstance(options, list) and all(isinstance(o, str) and o for o in options)
            and value in options and set(spec["options"]) <= set(options)):
        return False
    try:
        check_target(item.get("url", ""))
        screenshot = Path(item.get("screenshot", ""))
        return screenshot.is_absolute() and screenshot.is_file()
    except (Blocked, TypeError, ValueError):
        return False


def verify(path, fresh, validation_evidence=None):
    path, manifest = load_batch(path)
    plan = manifest["plan"]
    api_dropdowns = None
    if "api-plan.json" in manifest["artifacts"]:
        from feishu_api import validate_rule_evidence
        # API rules are checked even when the XLSX happens to include validations.
        # A pre-write or zero-applied snapshot can still be inspected without post-write proof.
        if isinstance(validation_evidence, dict) and validation_evidence.get("transport") == "feishu_api":
            api_dropdowns = validate_rule_evidence(path, fresh, validation_evidence)
    baseline = Snapshot(path / "baseline.xlsx")
    try:
        require(baseline.fingerprint == plan["baseline_digest"], "基线语义摘要与计划不一致")
        sheet, area = plan["worksheet"], CellRange(plan["range"])
        issues = []
        if fresh.book.sheetnames != baseline.book.sheetnames:
            issues.append("工作表列表/顺序发生变化")
        expected = {coord: value for row in plan["rows"] for coord, value in row["values"].items()}

        def owned(name, coord):
            return name == sheet and coord in area

        for name in set(baseline.cells) | set(fresh.cells):
            before, after = baseline.cells.get(name, {}), fresh.cells.get(name, {})
            for coord in before.keys() | after.keys():
                if not owned(name, coord) and before.get(coord) != after.get(coord):
                    issues.append(f"计划外修改：{name}!{coord}")
                    if len(issues) >= 20:
                        break
        before_meta, after_meta = json.loads(canonical(baseline.meta)), json.loads(canonical(fresh.meta))
        for data in (before_meta, after_meta):
            if sheet in data:
                data[sheet]["rows"] = {r: v for r, v in data[sheet]["rows"].items()
                                      if not area.min_row <= int(r) <= area.max_row}
        if sheet in before_meta and sheet in after_meta and filter_extends_only_into_append(
                before_meta[sheet]["filter"], after_meta[sheet]["filter"], area):
            after_meta[sheet]["filter"] = before_meta[sheet]["filter"]
        if before_meta != after_meta:
            issues.append("历史布局/合并/隐藏/保护/筛选发生变化")
        if validation_projection(baseline, (sheet, area)) != validation_projection(fresh, (sheet, area)):
            issues.append("追加范围外的下拉验证发生变化")
        require(sheet in fresh.book.sheetnames, "目标工作表已不存在")
        ws = fresh.book[sheet]
        matches, blanks = 0, 0
        meaningful = 0
        for coord, value in expected.items():
            actual = ws[coord].value
            if value is not None:
                meaningful += 1
                if actual == value:
                    matches += 1
                elif actual is None:
                    blanks += 1
                else:
                    issues.append(f"追加值不符：{coord}")
            elif actual is not None:
                issues.append(f"应为空的新增字段被占用：{coord}")
        state = "conflict" if issues else "not_applied" if matches == 0 else "partial" if blanks else "complete"
        ui_validated = []
        if state == "complete":
            require("api-plan.json" not in manifest["artifacts"] or api_dropdowns is not None,
                    "接口追加需要当前快照对应的完整 API 规则回读")
            for dropdown in plan["dropdowns"]:
                r = CellRange(dropdown["range"])
                for row in range(r.min_row, r.max_row + 1):
                    coord = f"{get_column_letter(r.min_col)}{row}"
                    value = ws[coord].value
                    matching = [v for v in ws.data_validations.dataValidation if coord in v.sqref]
                    if api_dropdowns is not None and not matching:
                        spec = next((d for d in api_dropdowns if d["range"] == dropdown["range"]), None)
                        if spec and value in spec["options"]:
                            continue
                    if not matching and ui_validates_omitted_dropdown(
                            dropdown, validation_evidence, fresh, sheet, value):
                        if dropdown["range"] not in ui_validated:
                            ui_validated.append(dropdown["range"])
                        continue
                    if not matching or not any(value in inline_options(v)
                                               and set(dropdown["options"]) <= set(inline_options(v)) for v in matching):
                        issues.append(f"新增下拉未包含实际值/原有选项：{coord}")
                        break
            if issues:
                state = "conflict"
        result = {"status": state, "matched_cells": matches, "expected_cells": meaningful, "issues": issues[:20]}
        if ui_validated:
            result["ui_validated_ranges"] = ui_validated
        if api_dropdowns is not None:
            result["api_validated_ranges"] = [d["range"] for d in api_dropdowns]
        return result
    finally:
        baseline.close()


def can_start_append(records):
    if all(e["step"] in {"blocked", "resumed"} for e in records):
        return True
    # A user-authorized retry is consumed by the next append_started event.
    return (bool(records) and records[-1]["step"] == "resumed"
            and records[-1]["evidence"].get("retry_append") is True
            and records[-1]["evidence"].get("sync_confirmed") is True
            and all(e["step"] in {"append_started", "blocked", "resumed"} for e in records))


def preflight(path, fresh):
    path, manifest = load_batch(path)
    records = events(path)
    require(not status(path)["blocked"] and can_start_append(records),
            "本批已有执行尝试/阻塞，必须先核对现状，不能自动重贴")
    require(fresh.fingerprint == manifest["plan"]["baseline_digest"], "快照变化或目标被占用，需更新计划并确认")
    area = CellRange(manifest["plan"]["range"])
    ws = fresh.book[manifest["plan"]["worksheet"]]
    for row in ws.iter_rows(min_row=area.min_row, max_row=area.max_row):
        require(not any(content(c) for c in row), "目标行已有值、公式或附件元数据")
    return {"status": "ready_to_append", "range": str(area)}


def group_for(plan, group_id):
    found = [g for g in plan["groups"] if g["id"] == group_id]
    require(len(found) == 1, "分组编号不存在")
    return found[0]


def cls_check(path, group_id, action, ui):
    require(action in {"fill", "save_draft", "import_scripts"}, "发布/删除/更新脚本及未知动作均不允许")
    state = status(path)
    require(state["append_verified"] and not state["blocked"], "进度表尚未验证或批次已阻塞")
    require(group_id in state["groups"], "组不存在")
    stages = state["groups"][group_id]
    attempted = [e for e in state["events"] if e.get("group") == group_id and e["step"] == "cls_api_attempt"
                 and e["evidence"].get("action") == action]
    require(not attempted, "本组接口动作已有尝试；必须回读核对，不能自动重发")
    require("cls_started" in stages and "handoff" not in stages, "需先记录 CLS 尝试，已移交的组不可自动继续")
    require(ui.get("logged_in") is True, "CLS 未登录")
    require(ui.get("can_create") is True, "未证明 CLS 有建单权限")
    require(ui.get("unpublished") is True, "未证明当前是未发布的新需求/草稿")
    require(ui.get("save_result") not in {"failure", "unknown"}, "草稿保存失败/结果未知，先核对现状")
    if action == "save_draft":
        require("draft_saved" not in stages, "已有草稿，不能按新工单重复保存")
        require(ui.get("required_complete") is True, "CLS 必填未齐全")
    if action == "import_scripts":
        require("draft_saved" in stages and "scripts_imported" not in stages, "未保存草稿或本组已导入，不能重复")
        require(ui.get("draft_saved") is True and ui.get("unpublished") is True, "需确认当前未发布草稿")
        require(ui.get("import_enabled") is True and ui.get("import_would_publish") is False,
                "脚本导入禁用/需要发布/后果未知，保留内部记录并说明具体阻碍")
    return {"status": "allowed", "action": action, "group": group_id}


def cls_evidence(evidence):
    require(evidence.get("confirmed") is True and evidence.get("unpublished") is True,
            "没有确认成功及未发布状态")
    check_cls_url(evidence.get("url", ""))
    if evidence.get("transport") == "cls_api":
        from cls_api import validate_receipt
        validate_receipt(evidence)
    else:
        # Historical UI receipts retain their original evidence requirements.
        file = Path(evidence.get("screenshot", ""))
        require(file.is_absolute() and file.is_file(), "需已存在的截图绝对路径")


def record(path, step, group_id=None, evidence=None, fresh=None):
    path, manifest = load_batch(path)
    records = events(path)
    evidence = evidence or {}
    from feishu_api import reject_secrets
    reject_secrets(evidence)
    state = status(path)
    require(not state["blocked"] or step == "resumed", "已阻塞批次不能继续自动化；保留现场等待用户处理")
    if step == "resumed":
        require(state["blocked"] and fresh is not None and group_id is None, "恢复需阻塞记录及最新快照")
        require(evidence.get("confirmed") is True and isinstance(evidence.get("reason"), str)
                and evidence["reason"].strip(), "恢复需用户明确决定及原因")
        result = verify(path, fresh, evidence.get("validations"))
        never_attempted = not any(e["step"] == "append_started" for e in records)
        retry_append = evidence.get("retry_append") is True
        if retry_append:
            require("api-plan.json" not in manifest["artifacts"], "接口批次已尝试写入后只能回读，不授权重发")
            require(evidence.get("sync_confirmed") is True and not state["append_verified"]
                    and all(e["step"] in {"append_started", "blocked", "resumed"} for e in records),
                    "重试需确认同步完成，且不能已验证追加或开始 CLS")
            require(result["status"] == "not_applied"
                    and fresh.fingerprint == manifest["plan"]["baseline_digest"],
                    "重试仅允许全批为空且完整快照与基线一致；部分写入/冲突不能重试")
        else:
            require(result["status"] == "complete" or (never_attempted and result["status"] == "not_applied"
                    and fresh.fingerprint == manifest["plan"]["baseline_digest"]), "部分写入/冲突/未确认的写入尝试不能恢复")
        if any(e["step"] == "cls_started" for e in records):
            require(evidence.get("cls_reconciled") is True, "需先核对现有草稿/导入结果，避免重复工单")
        evidence = {**evidence, "verified_snapshot_digest": fresh.fingerprint}
    elif step == "append_started":
        require(can_start_append(records) and group_id is None,
                "已有写入尝试，禁止重复记录/自动重贴")
    elif step == "append_verified":
        require(any(e["step"] == "append_started" for e in records) and not state["append_verified"], "追加验证顺序不正确")
        require(fresh is not None and verify(path, fresh, evidence.get("validations"))["status"] == "complete",
                "追加未完整通过校验")
    elif step == "blocked":
        require(isinstance(evidence.get("reason"), str) and evidence["reason"].strip(), "需阻塞原因")
    else:
        require(state["append_verified"], "进度表必须先验证")
        group = group_for(manifest["plan"], group_id)
        stages = state["groups"][group_id]
        require("handoff" not in stages or step == "requirement_number", "本组已移交，不自动继续")
        if step == "cls_started":
            require(not stages, "已有 CLS 尝试，先查草稿，不能重复新建")
        elif step == "cls_api_attempt":
            action = evidence.get("action")
            require(action in {"save_draft", "import_scripts"} and isinstance(evidence.get("operation_id"), str)
                    and re.fullmatch(r"[0-9a-f]{64}", evidence["operation_id"]), "接口尝试动作/摘要无效")
            cls_check(path, group_id, action, evidence.get("observations", {}))
        elif step == "draft_saved":
            require([s for s in stages if s != "cls_api_attempt"] == ["cls_started"], "已有草稿或记录顺序错误")
            cls_evidence(evidence)
            if evidence.get("transport") == "cls_api":
                from cls_api import validate_batch_receipt
                validate_batch_receipt(path, group_id, evidence, "draft_saved")
        elif step == "scripts_imported":
            require("draft_saved" in stages and "scripts_imported" not in stages, "导入顺序不正确或重复")
            cls_evidence(evidence)
            if evidence.get("transport") == "cls_api":
                from cls_api import validate_batch_receipt
                validate_batch_receipt(path, group_id, evidence, "scripts_imported")
            require(type(evidence.get("quantity")) is int and evidence["quantity"] == group["request"]["quantity"]
                    and evidence.get("names") == group["names"], "导入数量/名称不符")
        elif step == "handoff":
            require(isinstance(evidence.get("reason"), str) and evidence["reason"].strip(), "需明确人工接手事项")
        elif step == "requirement_number":
            require("draft_saved" in stages or "handoff" in stages, "尚无可补充编号的工单")
            require(evidence.get("confirmed") is True, "正式编号必须来自用户/实际页面或接口回读")
        else:
            raise Blocked("事件步骤不受支持")
    number = evidence.get("requirement_number")
    if number is not None:
        require(isinstance(number, str) and re.fullmatch(r"GOFCN\d{11}", number), "不是正式需求编号；不能使用素材编号/草稿 ID")
    if step == "requirement_number":
        require(number is not None, "缺少实际需求编号")
    event = {"step": step, "group": group_id, "evidence": evidence,
             "time": datetime.now(timezone.utc).isoformat(),
             "previous": records[-1]["event_id"] if records else ""}
    event["event_id"] = digest(event)
    write_json_new(path / "events" / f"{len(records) + 1:06d}.json", event)
    return {"status": "recorded", "step": step, "group": group_id}


def report(path):
    """Local audit report, derived from immutable events and validated receipts; no network."""
    path, manifest = load_batch(path)
    records, plan = events(path), manifest["plan"]
    state = status(path)
    groups = []
    for group in plan["groups"]:
        result = {"group": group["id"], "quantity": group["request"]["quantity"],
                  "csv": str(path / group["csv"]), "steps": state["groups"][group["id"]]}
        for event in records:
            if event.get("group") == group["id"] and event["step"] in {"draft_saved", "scripts_imported"}:
                evidence = event["evidence"]
                if evidence.get("transport") == "cls_api":
                    from cls_api import validate_batch_receipt
                    validate_batch_receipt(path, group["id"], evidence, event["step"])
                    result[event["step"]] = {"receipt": evidence["receipt"], "verified_at": event["time"],
                                              "draft_id": evidence["draft_id"], "url": evidence["url"]}
        groups.append(result)
    context = read_json(path / "api-plan.json") if "api-plan.json" in manifest["artifacts"] else {}
    verified = next((e for e in reversed(records) if e["step"] == "append_verified"), None)
    result = {"schema": 1, "status": "report_ready", "plan_id": plan["plan_id"], "target": TARGET,
              "worksheet": plan["worksheet"], "sheet_id": context.get("sheet_id"), "range": plan["range"],
              "state": state, "groups": groups, "message": message(path)["message"],
              "evidence_time": "各阶段保存的回读时间；本报告不重新查询线上当前状态"}
    if verified:
        evidence = verified["evidence"]
        if evidence.get("transport") == "feishu_api" and evidence.get("snapshot"):
            snapshot_path = Path(evidence["snapshot"]).resolve()
            require(path in snapshot_path.parents, "报告快照必须位于本批目录")
            snapshot = Snapshot(snapshot_path)
            try:
                require(snapshot.fingerprint == evidence.get("snapshot_digest")
                        and verify(path, snapshot, evidence.get("validations"))["status"] == "complete",
                        "报告对应的本地快照/规则证明已变化")
            finally:
                snapshot.close()
        result["append_verified"] = {"verified_at": verified["time"], "evidence": verified["evidence"]}
    return result


def message(path):
    path, manifest = load_batch(path)
    records = events(path)
    lines = ["请在正式发布后核对并补齐需求编号，再复制到无尽冬日-素材外包结算群发送。", "", "@cici cici老师好，本批需求如下："]
    for group in manifest["plan"]["groups"]:
        number = next((e["evidence"]["requirement_number"] for e in reversed(records)
                       if e.get("group") == group["id"] and e["evidence"].get("requirement_number")), "【发布后补填需求编号】")
        g = group["request"]
        lines.extend([f"需求编号：{number}（{g['topic']} · {g['creative_form']} * {g['quantity']}）",
                      f"供应商：{g['supplier']}", f"创意人：{g['creator']}", f"需求说明：{g['brief']}", ""])
    lines.append("辛苦安排一下~")
    return {"status": "message_ready", "message": "\n".join(lines)}


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "prepare", "preflight", "verify"):
        cmd = commands.add_parser(name)
        cmd.add_argument("--snapshot", required=True)
        cmd.add_argument("--observed-url", required=True)
        if name == "plan":
            cmd.add_argument("--request", required=True)
            cmd.add_argument("--current-sheet")
        elif name == "prepare":
            cmd.add_argument("--plan", required=True)
            destination = cmd.add_mutually_exclusive_group()
            destination.add_argument("--output-root", help="内部批次根目录；默认使用系统 temp")
            destination.add_argument("--workspace", help="历史兼容：使用 <工作区>/outputs/gof-requirement")
        else:
            cmd.add_argument("--batch", required=True)
            if name == "verify":
                cmd.add_argument("--validation-evidence")
    for name in ("record", "status", "cls-check", "message", "report"):
        cmd = commands.add_parser(name)
        cmd.add_argument("--batch", required=True)
        if name == "report":
            cmd.add_argument("--output", help="可选，独占创建本批目录内的新 JSON 报告")
        if name == "record":
            cmd.add_argument("--step", required=True)
            cmd.add_argument("--group")
            cmd.add_argument("--evidence")
            cmd.add_argument("--snapshot")
            cmd.add_argument("--observed-url")
        if name == "cls-check":
            cmd.add_argument("--group", required=True)
            cmd.add_argument("--action", required=True)
            observe = cmd.add_mutually_exclusive_group(required=True)
            observe.add_argument("--ui")
            observe.add_argument("--observations", help="API/页面实际观察的相同条件，兼容原 --ui")
    args = parser.parse_args(argv)
    snap = None
    try:
        if getattr(args, "snapshot", None):
            check_target(args.observed_url or "")
            snap = Snapshot(args.snapshot)
        if args.command == "plan":
            result = make_plan(snap, read_json(args.request), args.current_sheet)
        elif args.command == "prepare":
            result = prepare(read_json(args.plan), snap, args.workspace, output_root=args.output_root)
        elif args.command == "preflight":
            result = preflight(args.batch, snap)
        elif args.command == "verify":
            result = verify(args.batch, snap, read_json(args.validation_evidence)
                            if args.validation_evidence else None)
        elif args.command == "record":
            result = record(args.batch, args.step, args.group,
                            read_json(args.evidence) if args.evidence else None, snap)
        elif args.command == "status":
            result = status(args.batch)
        elif args.command == "cls-check":
            result = cls_check(args.batch, args.group, args.action, read_json(args.ui or args.observations))
        elif args.command == "report":
            result = report(args.batch)
            if args.output:
                output = Path(args.output).resolve()
                require(Path(args.batch).resolve() in output.parents, "报告必须位于本批目录")
                write_json_new(output, result)
                result = {"status": "report_saved", "report": str(output)}
        else:
            result = message(args.batch)
        print(canonical(result))
        return 0 if result.get("status") not in {"conflict", "partial"} else 2
    except (Blocked, OSError, ValueError, KeyError, TypeError) as exc:
        print(canonical({"status": "blocked", "reason": str(exc)}))
        return 2
    finally:
        if snap:
            snap.close()


if __name__ == "__main__":
    raise SystemExit(main())
