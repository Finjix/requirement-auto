# Data contract and batch commands

`gof batch …` is offline: no network, no online writes, never modifies the input XLSX (read by the plugin's own read-only parser). A refusal prints JSON `status=blocked` and exits non-zero. New batches are created through `gof feishu` (which adds the immutable `api-plan.json`) and never through `gof batch prepare`; `gof batch plan/prepare` exist only for offline work and old batches and cannot replace the bridge's real `api_plan`. CLS is in [api-workflow.md](api-workflow.md). `--current-sheet`, `--workspace`, `--ui`, `append.tsv` and screenshot-based UI evidence exist for old UI batches only; do not use them for new ones.

## Request (`request.json`)

The default full flow needs every field below except the optional ones. Values are placeholders; the links are format examples only, never real requirement links.

```json
{
  "worksheet": "26年1月-GOFCN",
  "groups": [{
    "supplier": "丁杰",
    "reviewer": "张天伟",
    "script_url": "https://centurygames.feishu.cn/wiki/CurrentScript123?sheet=abc123",
    "primary_tag": "AI生成",
    "creative_form": "2D",
    "items": [
      { "quantity": 3, "secondary_tag": "设定3.0" },
      { "quantity": 1, "secondary_tag": "设定2.0" },
      { "quantity": 10, "secondary_tag": "设定3.0" }
    ],
    "cls": { "direction": "<direction>", "task_type": "<task type>" }
  }, {
    "supplier": "杨燃",
    "reviewer": "雷佳威",
    "script_url": "https://centurygames.feishu.cn/docx/CurrentScript456",
    "quantity": 15,
    "primary_tag": "AI迭代",
    "secondary_tag": "题材片头",
    "creative_form": "2D",
    "keyword": "关键词",
    "cls": { "direction": "<direction>", "task_type": "<task type>", "supplier": "<CLS supplier name, only when needed>" }
  }]
}
```

- `worksheet` is optional: default is the latest year-month GOFCN sheet with valid columns; ambiguity fails. The bridge never reads the browser's current tab; tell the user the sheet name and `api_plan.sheet_id`.
- A **group** is one CSV and one CLS ticket: one supplier, one reviewer, one script link, one set of CLS fields. One requirement document is normally one group; several documents in one request are several groups (in the order of the links), appended in one range with the material numbers running on from group to group, one CLS ticket each, one group message for all.
- `label` (optional, on the group, 1-20 characters, no brackets or stars): the short name of this kind of requirement in the group message ("素人剧情"). Without it the message uses the group's 一级标签, counted per tag when the rows differ. `gof feishu plan` prints it as `message_kind` (e.g. "素人剧情*25").
- A group's rows are either all alike (`quantity` plus the fields below on the group) or listed as `items`, runs of rows in order, each with its own `quantity` and whatever differs (`primary_tag`, `secondary_tag`, `creative_form`, `keyword`; the group's values are the defaults). With `items`, the group has no `material_name`; a group `quantity` is allowed only as the items' sum (as in a normalized request). One item is the same as a group without `items`.
- Per row: `primary_tag`, `secondary_tag`, `creative_form` (required, non-empty), `keyword` (提炼词, default `关键词`). The material name is built from them as `<一级>_<二级>_<创意形式>_<提炼词>` and the sheet's naming formula must produce exactly `GOFCN<number>_<that>`. Instead of the tags, an older request may give `material_name` (a body, or a sample with an old number, which is stripped); it must end with `_<creative_form>_<keyword>`, and unless given, the tags come from the part before it, split at the first underscore. `topic` (`<一级>_<二级>`) is derived; if given, it must match.
- `quantity`: positive integer.
- `supplier`, `reviewer`, `script_url` are required. `script_url` is the user's requirement link as given (a `wiki`, `docx` or `sheets` link on the company host, a `?sheet=` tab included; CSV only, no progress column, never a historical link). `cls.direction` and `cls.task_type` are required in the full flow. `cls.requirement_name` must not appear in the request (rejected): `gof cls` builds it from the group's real names as `GOFCN<first>-GOFCN<last>` (one item: `GOFCN<number>`), and receipt validation checks the draft name against it. All of it is settled before the plan, never after the sheet append. Only when the user excluded the ticket may `cls` be omitted; a non-empty `cls` requires its two required fields. The program accepts such partial requests but validates only static fields; the agent still checks the live pages and must never skip the ticket or ask about scope because the program allows it.
- Optional CLS keys: `subject`, `department`, `market_contact`, `currency`, `quotation`, `expected_completion`, `storyboard_time`, `first_draft_time`, `final_cut_time` (dates `YYYY-MM-DD`; fill from what the user said, otherwise blank; never guess, never ask during execution). `supplier` and `creator` give the CLS spelling of the group's supplier and reviewer when the program cannot match them itself; they must be exact CLS names.
- CLS matching of `supplier` / `reviewer` without those keys: the exact name, else the one CLS name whose bracket or dash part is the name ("北京柒曦文化传媒有限公司（丁杰）", "…（个体工商户）-杨燃"), else the one CLS name containing it ("冯彦蓉-实习生"). Several at that level, or none: refused before the plan.
- `reviewer` is the one person field; `creator` defaults to `reviewer` and can never differ. It fills the progress column, the CLS import creator and the message creator.
- `client`, `creative_expression`, `creative_batch`, `head_reference`, `creative_reference` must be empty (non-empty input is rejected); no other progress fields are filled.
- After the approved plan completes, a later ticket request is a new task: clarify everything, approve a separate ticket plan, reuse the original CSV; do not re-run `prepare` or append the original batch again.

## CSV

UTF-8 with BOM, CRLF, header exactly `脚本名称,脚本内容,创意标签`. Each group's first row has the confirmed script link, the rest `同上`. Tag is always `玩法卖点（单选，必选）/展示向/展示向`. No link: stop before plan and CSV; ask; never borrow a historical link. `assets/csv-template.csv` is a reference only and must never be uploaded; do not depend on template paths from other machines.

## Commands

Replace placeholders with absolute paths; `gof` = `node <skill>/../../server/dist/gof.mjs`.

```text
gof batch plan --request request.json --snapshot downloaded.xlsx --observed-url <real URL>
gof batch prepare --plan approved-plan.json --snapshot fresh.xlsx --observed-url <real URL> [--output-root <dir>]
gof batch preflight --batch <batch> --snapshot fresh.xlsx --observed-url <real URL>
gof batch verify --batch <batch> --snapshot after.xlsx --observed-url <real URL>
gof batch record --batch <batch> --step <step> [--group 01] [--evidence file.json] [--snapshot fresh.xlsx --observed-url <real URL>]
gof batch cls-check --batch <batch> --group 01 --action save_draft|import_scripts --observations observations.json
gof batch status --batch <batch>
gof batch message --batch <batch>
gof batch report --batch <batch> --output <new report>.json
```

- `plan` prints only the plan JSON (plan_id, baseline digest, sheet/column mapping, append range, row values/formulas, names, dropdown options); it writes no file. Save it as `approved-plan.json` only after the user approves. Historical duplicate numbers and number/name mismatches become `history_warnings`; old data is never changed, and every readable number takes part in the max-number rule. If an existing number is unreadable and non-collision cannot be proven, stop.
- `prepare` recomputes the approved plan and refuses if it changed. Default output `<system temp>/gof-requirement/<plan_id>`; an existing directory is refused. It creates `baseline.xlsx`, `manifest.json`, grouped CSVs and append-only `events/*.json`. These paths are internal. The script stores no "user authorized" flag and cannot replace real approval in the conversation.
- `preflight` passes only when no write has been attempted.
- `verify` returns `complete` (whole batch present, history unchanged, dropdowns valid), `not_applied` (nothing appeared; does not mean auto-retry is safe), `partial` (stop) or `conflict` (history changed, wrong field or unplanned addition; stop). XLSX cannot show collaboration locks or all dropdown colors, so API batches also need the current API rule proof; UI checks never substitute.
- Filters: Feishu may extend an existing filter's last row to the batch's last row; new filter rows must lie entirely within the appended rows, and column range, start row, conditions and sort stay unchanged. Any other filter change is `conflict`. This does not authorize the agent to edit old filters.
- Valid `record` steps: `append_started`, `append_verified`, `cls_started`, `cls_api_attempt`, `draft_saved`, `scripts_imported`, `handoff`, `blocked`, `resumed`, `requirement_number`. Events are created exclusively and never overwritten. A group's `handoff` ends its automation. Any evidence containing credentials is rejected.
- Feishu API evidence for `append_verified` / `resumed` goes in `evidence.validations` as `{ "transport": "feishu_api", "proof": "<absolute path of this batch's rule proof>" }`, never a self-declared success boolean.
- `cls_api_attempt` evidence: `action` (`save_draft` / `import_scripts`), `operation_id`, `observations`. A second attempt of the same action for a group is refused.
- `observations.json` is produced by `cls observe` and holds observed booleans: `logged_in`, `can_create`, `unpublished` must be true; saving also needs `required_complete=true`; import also needs `draft_saved=true`, `import_enabled=true`, `import_would_publish=false`. `save_result` of `failure`/`unknown` stops. Publishing and unlisted actions are always refused. The guard never manipulates pages or enables disabled controls.
- `draft_saved` evidence: `confirmed=true`, `unpublished=true`, real CLS `url`, `transport=cls_api`, `draft_id`, absolute paths of operation and receipt in this batch; it passes only after a full read-back. Optional `requirement_number` must be an official `GOFCN` number actually read. `scripts_imported` adds `quantity` and `names` that must match the group exactly. `handoff` and `blocked` need a `reason`. An unknown save result can never carry `confirmed=true`. `requirement_number` step: `confirmed=true` and a real official number (from the user or a read-back), never a material number or draft ID; then regenerate the message.
- `resumed` evidence (`resume.json`): `confirmed=true`, `reason`; plus `cls_reconciled=true` if CLS had started (existing drafts/imports checked by API read-back, not assumed). Run it with `--snapshot fresh.xlsx` after the user resolved the block and asked to resume. Resume is normally allowed only for a complete append, or a batch with no append attempt and an unchanged baseline. Partial writes, occupied cells, changed history and unknown results are never re-sent. API batches never retry an attempted write.
- `report` writes a local JSON report (sheet, ID, range, stage states, CLS receipts, message); it re-verifies existing operations/receipts against the original request, makes no network call, states the evidence time and never overwrites an older report.
- `message` is the one group message of the whole batch, ready to copy and nothing else: `@李聪（Cici）老师好 刚刚发了新的工单`, then per group (plan order) `需求编号：<number>（<label>*<quantity>）` and `供应商：<supplier>`, then `创意人：<reviewers, each once, joined by "/">` and `辛苦安排一下~`. Only groups with a ticket (a saved draft, an imported CSV, a hand-over or an official number) are in it; the others are named in `skipped_groups` (no ticket at all: `status` is `message_not_ready` and `message` is null). A group without an official number shows `【发布后补填需求编号】` and is listed in `missing_numbers`; the agent says to fill it in after publishing. Material numbers, `plan_id` and draft IDs are never numbers.
