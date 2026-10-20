# Feishu SDK bridge

Covers reading Feishu docs, exporting the full test progress sheet, approved appends and dropdown-rule verification. All of it goes through `gof feishu …` (`gof` = `node <skill>/../../server/dist/gof.mjs`), which calls the in-plugin bridge (official `@larksuiteoapi/node-sdk`, allow-listed operations only) in the same process. No generic write API, browser fallback or lark-cli.

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

## Snapshot, plan, append

```text
gof feishu snapshot --output <new>.xlsx
gof feishu document --url <script doc link>
gof feishu plan --request request.json --snapshot <snapshot>.xlsx
gof feishu prepare --plan approved-api-plan.json --snapshot <fresh>.xlsx
gof feishu append --batch <batch> --receipt <probe receipt>.json
gof feishu reconcile --batch <batch>
```

The target is fixed: test Wiki node `YFyywzwLsiT07EkpBaecr8nIncn`. The bridge resolves the real spreadsheet token; sheet metadata and the order/names in the full XLSX must agree. Sheet choice and the "state name + sheet ID in the plan" rule are in SKILL.md.

| Operation | API |
|---|---|
| Read | Wiki `get_node`; sheets v3 `sheets/query`; sheets v2 `dataValidation`, `values_batch_get`, `metainfo`; docx `raw_content` |
| Export | `drive/v1/export_tasks`: create, poll, download to a new XLSX file |
| Write | `sheet_ai/v2/spreadsheets/{token}/tools/invoke_write`, `batch_update` + `set_cell_range`, each range `allow_overwrite:false` |
| Create | isolation probe only: `sheets/v3/spreadsheets` |

- `snapshot` exports the full XLSX and compares `metainfo.revision` before and after. Export not finished: stop, no CSV substitute, no blind re-submit. In system plan mode only read existing snapshots; do not export.
- `plan` prints JSON only: `batch_plan` and `api_plan` (real target, sheet ID, revision, whole-workbook rules, final dropdown options/colors/modes for this batch). Save the complete JSON only after approval. `prepare` recomputes both and writes the immutable `api-plan.json`; any change stops it, never silent renumbering.
- `append` checks the probe receipt, user identity, revision, fresh XLSX, hidden columns, empty formulas, merges, numbers and whole-workbook rules, then makes a **single** `invoke_write`: `formula` for formulas, `multiple_values` for multi-select, no null for blank fields. Writes are never retried: no result = "unknown result": read back, never resend. Dropdowns are written only for this batch's range and keep every original option, color, highlight and mode; reference-type or incomplete rules that cannot be preserved reliably stop the run.
- After the write: full export + whole-workbook rule read-back; `rule-proof.json` binds `api_plan` to the current snapshot. Verification protects old values, formulas, styles and rules; a wrong rule present in the XLSX cannot be proven away. On success it records `append_verified` and writes `api-attempt-*/verification-report.json`. Reports and receipts are evidence from the time of collection, not an atomic web+API transaction.

## First overwrite probe

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
