# Feishu SDK bridge

Covers reading requirement documents, the progress sheet's context, exporting the full test progress sheet, approved dropdown additions and appends, and dropdown-rule verification. All of it goes through `gof feishu …` (`gof` = `node <skill>/../../server/dist/gof.mjs`), which calls the in-plugin bridge (official `@larksuiteoapi/node-sdk`, allow-listed operations only) in the same process. No generic write API, browser fallback or lark-cli.

## Runtime

- Node.js 24+ only. If the bridge file is missing or Node is older: stop; no npm install, download or auto-update.
- The host sets `LARK_AGENT_USER_DIR` (absolute user dir), optionally `LARK_AGENT_USER_OPEN_ID`, and `FEISHU_APP_ID` / `FEISHU_APP_SECRET`. User data is under `<user dir>/requirement-auto/{feishu,batches,cls}`.
- Standalone: data goes to `PLUGIN_DATA`, else `~/.requirement-auto/default`; app credentials may be in that dir's `app.json`. With a host, `app.json` is never read.

```text
gof feishu doctor      # Node, bridge, current user's login and required scopes
```

## Login (device authorization)

Prefer the MCP tools of the plugin's `feishu-auth` server: `feishu_auth_status` -> `feishu_auth_login` -> send the link and code to the user verbatim and end the turn -> after the user replies, `feishu_auth_poll`. `feishu_auth_logout` only when the user asks to log out or switch accounts. Script equivalents:

```text
gof feishu login start [--probe-scope]
gof feishu login poll [--wait 40]
gof feishu login status
gof feishu login logout
```

`--probe-scope` adds `sheets:spreadsheet:create`; use it only before an approved isolation probe.

- Tokens live only in bridge memory and `feishu/auth.json` in the user dir. They never appear in tool results, output, logs or batch records.
- Refresh tokens are single-use; renewal runs under a file lock.
- If the host declares the user's Open ID, any other authorized account is rejected and nothing is stored.
- Denied, expired, missing scope or approval needed: report it and leave it to the user/admin. No bot identity, no borrowed login.

## Requirement, context, snapshot, plan, append

```text
gof feishu document --url <requirement link> [--sheet <tab id or title>] [--full]
gof feishu snapshot --output <new>.xlsx
gof feishu context --snapshot <snapshot>.xlsx [--supplier <name>] [--worksheet <name>]
gof feishu plan --request request.json --snapshot <snapshot>.xlsx [--output <new plan>.json]
gof feishu dropdown-add --field primary|secondary|form|supplier|reviewer --option <value> --sheet <sheet name>
gof feishu prepare --plan <approved plan>.json --snapshot <fresh>.xlsx
gof feishu append --batch <batch>                  # uses the shipped assets/overwrite-receipt.json; --receipt <file> only to override
gof feishu reconcile --batch <batch>
```

The target is fixed: test Wiki node `YFyywzwLsiT07EkpBaecr8nIncn`. The bridge resolves the real spreadsheet token; sheet metadata and the order/names in the full XLSX must agree. Sheet choice and the "state name + sheet ID in the plan" rule are in SKILL.md.

| Operation | API |
|---|---|
| Read | Wiki `get_node`; sheets v3 spreadsheet info, `sheets/query`; sheets v2 `dataValidation`, `values_batch_get`, `metainfo`; docx `raw_content` |
| Export | `drive/v1/export_tasks`: create, poll, download to a new XLSX file |
| Write | `sheet_ai/v2/spreadsheets/{token}/tools/invoke_write`, `batch_update` + `set_cell_range`, each range `allow_overwrite:false`; sheets v2 `dataValidation` (only `dropdown-add`) |
| Create | isolation probe only: `sheets/v3/spreadsheets` |

- `document` reads any company `wiki`, `docx` or `sheets` link (read-only, never the progress sheet's rules): `title` (a wiki node's or spreadsheet's title, a docx's first line), and for a sheet the tab of the link's `?sheet=` (else the last visible tab, `chosen_by: last`; `--sheet` picks another), `tabs`, `columns`, `header` and the non-empty `rows` (`row` is the sheet row) as text: attachments as `[附件:<file name>]`, images as `[图片]`, cells clipped at 300 characters unless `--full`; up to 300 rows (`more_rows` when there are more). For a docx: `text` (clipped at 30,000 characters unless `--full`). Other document kinds are refused.
- `context` (read-only): the target sheet (as `plan` picks it), its sheet ID, `next_number`, the current dropdown `options` of 一级标签, 二级标签, 创意形式, 设计师供应商 and 创意者脚本审核人 (from the rules through the API: the options the XLSX lists are not reliable), `recent` runs of rows newest first (consecutive rows filled alike: sheet, rows, count, numbers, supplier, tags, form, reviewer, `keywords`; `--supplier` keeps that supplier's), and `past_requests`, this user's earlier batches newest first (supplier, reviewer, script link, CLS fields, requirement name, items, steps reached).
- `snapshot` exports the full XLSX and compares `metainfo.revision` before and after. Export not finished: stop, no CSV substitute, no blind re-submit. In system plan mode only read existing snapshots; do not export.
- `plan` builds `batch_plan` and `api_plan` (real target, sheet ID, revision, whole-workbook rules, final dropdown options/colors/modes for this batch). Without `--output` it prints both; with it, it saves both to a new file and prints a summary: sheet, sheet ID, range, numbers, per group the requirement name, supplier, reviewer, link and each item's first and last name, and `new_options` (`field` as `dropdown-add` takes it, `option`): values this request needs that the column's dropdown lacks.
- `dropdown-add` (only for an approved `new_options` entry): finds the field's column by its header and adds the option to every dropdown rule of that whole column, 5,000 rows at a time; each rule keeps its own options, colors and single/multiple mode, cell values are not touched, ranges that already have the option are skipped, and no dropdown is created where there is none. Running it again is harmless.
- `prepare` makes the approved plan again on the fresh snapshot and writes the immutable `api-plan.json`. The rows, numbers, values, names and groups must be exactly the approved ones (otherwise it stops: plan again and get a new approval; never silent renumbering); the revision and rules are those read now, so the approved dropdown additions and edits elsewhere in the workbook do not stop it.
- `append` checks the probe receipt, user identity, revision, fresh XLSX, hidden columns, empty formulas, merges, numbers and whole-workbook rules, then makes a **single** `invoke_write`: `formula` for formulas, `multiple_values` for multi-select, no null for blank fields. Writes are never retried: no result = "unknown result": read back, never resend. Dropdowns are written only for this batch's range and keep every original option, color, highlight and mode; reference-type or incomplete rules that cannot be preserved reliably stop the run.
- After the write: full export + whole-workbook rule read-back; `rule-proof.json` binds `api_plan` to the current snapshot. Verification protects old values, formulas, styles and rules; a wrong rule present in the XLSX cannot be proven away. On success it records `append_verified` and writes `api-attempt-*/verification-report.json`. Reports and receipts are evidence from the time of collection, not an atomic web+API transaction.

## First overwrite probe (maintainers only, never part of a user task)

The receipt of the 2026-10-20 probe ships as `assets/overwrite-receipt.json`, bound to `feishu-sdk-bridge/1`. Re-run the probe only after a bridge version change, then replace that file.

Receipts from the lark-cli era (`cli_version`, schema 1) are void. A probe needs its own approved online-verification plan: create one new `GOFCN_API_SAFETY_*` workbook, write a sentinel and a formula returning an empty string, try three occupied writes and read back. Never use old progress cells; never delete the probe sheet.

```text
gof feishu login start --probe-scope        # then login poll after the user confirms
gof feishu probe --receipt <new receipt>.json
```

The receipt (bound to bridge `feishu-sdk-bridge/1`) is written only if the server clearly refuses each occupied write (`kind: occupied`) and the original value/formula is unchanged every time. Network or permission failures do not count as success; never hand-write a receipt. Record the real "non-empty write refused" error code and text in the `OCCUPIED` check in `dev/feishu-sdk/src/api.ts` and its test. Without a verified probe, read-only plans work and appends stay blocked.

## Interruption recovery

Read `gof batch status`, then `gof feishu reconcile --batch …`: it re-checks the real target read-only, exports a fresh XLSX, reads back revision and all rules, and builds a new rule proof and verification report from the original `api_plan`. Its `snapshot` and `validation_evidence` feed `batch verify` and `record resumed`; it writes nothing.

- Complete: reuse the original CSV. If `append_verified` was not yet recorded, record it with the same snapshot, rule evidence and collection path, then continue to CLS (check existing drafts/imports first if CLS had started). `record resumed` only after the user resolved a block and explicitly asks to resume.
- An attempted write is never re-sent, even when everything reads back empty (the client cannot know the earlier request ended). Partial writes, occupied cells, changed history and unknown results stay as they are and are handed over: no rollback, no completion, no UI.
- A never-attempted batch may continue only if baseline, rules and approved revision are all unchanged.
- Old UI batches keep their events and evidence; never remove `api-plan` or edit the manifest to get past a guard. Batches from the lark-cli era (`cli_version` in `api-plan`) cannot be read back with this bridge and need the old skill package.
