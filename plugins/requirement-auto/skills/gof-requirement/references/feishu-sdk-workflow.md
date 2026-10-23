# Feishu SDK bridge

Everything Feishu goes through `gof feishu …` (`gof` = `node <skill>/../../server/dist/gof.mjs`), which calls the in-plugin bridge (official `@larksuiteoapi/node-sdk`) in the same process.

## Runtime

- Node.js 24+. The host sets `LARK_AGENT_USER_DIR` (absolute user dir), optionally `LARK_AGENT_USER_OPEN_ID`, and `FEISHU_APP_ID` / `FEISHU_APP_SECRET`. User data is under `<user dir>/requirement-auto/{feishu,batches,cls,tmp}`.
- Standalone: data goes to `PLUGIN_DATA`, else `~/.requirement-auto/default`; app credentials may be in that dir's `app.json`.

```text
gof feishu doctor      # Node, bridge, current user's login and required scopes
```

## Login (device authorization)

```text
gof feishu login start [--probe-scope]   # link and code; the same request while an unexpired one exists
gof feishu login poll [--wait 40]        # after the user confirms: authorized / pending / denied / expired
gof feishu login status                  # local record only, no network
gof feishu login logout                  # log out or switch accounts
```

No output contains a token. The QR path (`gof feishu authorize --qr`) is in SKILL.md section 0.

If the host declares the user's Open ID, another authorized account is rejected.

## Commands

```text
gof feishu document --url <requirement link> [--sheet <tab id or title>] [--full]
gof feishu snapshot --output <new>.xlsx
gof feishu context --snapshot <snapshot>.xlsx [--supplier <name>] [--worksheet <name>]
gof feishu plan --request request.json --snapshot <snapshot>.xlsx [--output <new plan>.json]
gof feishu dropdown-add --field primary|secondary|form|supplier|reviewer --option <value> --sheet <sheet name>
gof feishu prepare --plan <approved plan>.json --snapshot <fresh>.xlsx
gof feishu append --batch <batch>                  # uses the shipped assets/overwrite-receipt.json; --receipt <file> to override
gof feishu reconcile --batch <batch>
```

The target is the test Wiki node `GH7cwIxzZi3gVdk2s3tc1dDbnQc`; the bridge resolves the real spreadsheet.

- `document` reads a company `wiki`, `docx` or `sheets` link: `title`, wiki `path` (folders above, outermost first), and for a sheet the `?sheet=` tab (else the last visible tab, `chosen_by: last`; `--sheet` picks another), `tabs`, `columns`, `header`, non-empty `rows` (`row` = sheet row; attachments `[附件:<name>]`, images `[图片]`), cells clipped at 300 characters unless `--full`, up to 300 rows (`more_rows`). For a docx: `text` (clipped at 30,000 characters unless `--full`).
- `context`: target sheet and its ID, `next_number`, `naming` (the naming formula of the rows above the next one, in header words: `GOFCN<素材编号>_<一级标签>_<二级标签>_<提炼词>`), current dropdown `options` of the five fields (read from the API rules; the XLSX's lists are unreliable).
- `snapshot` exports the full XLSX (formulas included) and checks the revision did not move during export.
- `plan` builds `batch_plan` and `api_plan`; names come from the sheet's own naming formula (`CONCATENATE`/`CONCAT`, also inside `SUBSTITUTE(…,"__","_")`). With `--output` it saves both and prints a summary: sheet, range, numbers, `naming`, `same_name_rows` (rows already in the sheet under a `material_name` the request gives; absent when none), per group requirement name, supplier, reviewer, link, first and last item name, `message_kind`, `default_keyword_rows` (how many of the group's rows have the default 提炼词 `关键词`; absent when none), and `new_options` (`field`, `option`) the dropdowns lack.
- `dropdown-add` adds the option to every dropdown rule of that column (each rule keeps its options, colors and mode; cell values untouched; ranges that already have it are skipped). Re-running is harmless.
- `prepare` re-makes the approved plan on the fresh snapshot and creates the batch; it refuses if rows, numbers, values, names or groups differ from the approved plan. Revision changes elsewhere are fine.
- `append` runs the preflight (receipt, user, revision, fresh XLSX, hidden columns, formulas, merges, numbers, rules), then one `invoke_write` with `allow_overwrite:false`. This batch's rows get the dropdown of the rows above. Then a full export and rule read-back; success records `append_verified`. Writes are not retried by the tool: an unknown result is resolved by `reconcile`.

## Interruption recovery

`gof batch status`, then `gof feishu reconcile --batch …`: read-only; re-exports, reads back all rules and builds a new rule proof and verification report against the original `api_plan`. Its `snapshot` and `validation_evidence` feed `batch verify` and `record resumed`.

- Complete: reuse the original CSV; if `append_verified` is not yet recorded, record it with the reconcile evidence, then continue to CLS (check existing drafts first if CLS had started).
- An attempted write is never re-sent (the tool refuses), even when everything reads back empty. Partial, occupied or conflicting results are reported to the user. When the new rows lack their planned dropdowns, reconcile still gives the values' verdict (`not_applied`, `partial`, `conflict`) with the rule problem in `rule_issue`.
- Every refusal of `append` after the write went out carries `write_sent: true`. A request whose earlier batch was sent but never verified is planned again only when none of that batch's rows are in the sheet (`prepare` refuses otherwise).
- Verification of an API batch is strict on the appended rows (every column) and on the appended columns' dropdown rules. Edits colleagues make elsewhere in the shared workbook while it runs (other cells, other tabs, filters, sizes, hidden rows, rules of other columns) are listed in `foreign_changes` and do not fail it.
- A never-attempted batch can continue if baseline, rules and approved revision are unchanged.
- Batches from the lark-cli era (`cli_version` in `api-plan`) cannot be read back with this bridge.

## Overwrite probe (maintainers)

The receipt of the 2026-10-20 probe ships as `assets/overwrite-receipt.json`, bound to `feishu-sdk-bridge/1`. After a bridge version change: `gof feishu login start --probe-scope`, `login poll`, `gof feishu probe --receipt <new>.json` (creates a new `GOFCN_API_SAFETY_*` workbook and tries occupied writes), then replace the shipped file and record the server's "non-empty write refused" code in `OCCUPIED` in `dev/feishu-sdk/src/api.ts`.
