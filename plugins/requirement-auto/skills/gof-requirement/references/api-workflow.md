# CLS API operations

Feishu work goes through the [Feishu bridge](feishu-sdk-workflow.md). This file covers CLS only; login is in [cls-session.md](cls-session.md). After login everything is an HTTP request sent by `gof cls …` to `creative.centurygames.cn` (no open-material API key, no UI, no screenshots, no video upload, no publishing). Business writes still need an approved full plan.

## Status

- Feishu: the in-plugin bridge only; local tests are not server-side overwrite proof. Without a passed isolation probe, no business append and no UI fallback.
- CLS create-draft, multipart CSV import and GET read-back worked earlier from inside a browser page (draft 10224, since revoked: status 7, unusable). The Node version sends the same requests with only an `Authorization` header and is **not yet tested against the real CLS**: the first `cls login` / `cls session` confirms via `/api/userinfo` that the token works outside the browser, and stops if not, before any write. Run the first real write only as a user-approved trial on a new independent test draft.
- A bridge success response, a logged-in front end or a hand-set boolean in a receipt never replaces verification.

## Commands

`gof` = `node <skill>/../../server/dist/gof.mjs`. The token exists only in the command's memory.

| Command | Purpose |
|---|---|
| `cls login --qr <png>` / `cls session` | log in / check or take the session |
| `cls catalog --output catalog.json` | read projects, people, directions, task types, currencies; saves a redacted catalog (no emails, tokens, full user list) and prints `choices`: the GOFCN directions, creative task types, active suppliers and active people by name |
| `cls observe --action save_draft\|import_scripts [--draft ID] --output observations.json` | facts read from CLS now: account, create/import permission, draft unpublished + editable + no scripts. Never hand-written |
| `cls --batch … --group … --action … --catalog … --observations … --output …` | offline: build and seal this group's save/import operation file (in the batch dir, new file) |
| `cls --preview --request request.json --catalog catalog.json` | offline: show each group's planned fields, IDs, creator, native defaults and `cls_names` (the direction, task type, supplier and creator as matched in CLS); creates nothing |
| `cls run --batch <batch> --operation <op> --output <new receipt>` | send the operation's write, read back, write the receipt |
| `cls read-draft --id N` | read a draft |
| `cls verify --batch … --operation … --draft N --output …` | read back an existing draft into a receipt (recovery after an unknown result) |

Matching: read `cls catalog` first. Project code is GOFCN; direction by project and name; task type by the real options. Supplier (active, outsource role) and creator (active) are the progress sheet's supplier and reviewer, which CLS spells in full: the exact name, else the one CLS name whose bracket or dash part is that name ("北京柒曦文化传媒有限公司（丁杰）", "…（个体工商户）-杨燃"), else the one CLS name containing it ("冯彦蓉-实习生"); several or none at that level is refused. When the spelling differs more ("廿十一" / "长沙廿拾一文化传媒有限公司"), the request names the CLS user exactly in `cls.supplier` / `cls.creator`. Never hardcode earlier IDs (94/390/663/653). Quote/currency default to the observed native 0/cny, labelled "system default" in the plan; other optional fields are blank unless the user set them. Preview before the plan; optional fields, ambiguous matches and quote/date issues are settled there, not during execution.

## Per group

1. After the sheet is verified: `gof batch record --batch B --step cls_started --group 01`.
2. `cls observe --action save_draft`, then build the save operation to `B/save-operation.json`.
3. `gof batch record --step cls_api_attempt --group 01 --evidence attempt.json` (action, operation_id, observations). It forbids repeating the same action across sessions; `cls run` refuses without it.
4. `cls run --batch B --operation B/save-operation.json --output B/save-receipt.json`: re-checks account and permission, POST `/api/workflow/script/save` with `status=-2` and no existing ID, GET read-back, receipt, real entry URL from the draft ID. It writes a `cls-sent-*.json` marker before sending, so the same operation file is never sent twice.
5. `record --step draft_saved` with evidence: `confirmed`, `unpublished`, `transport=cls_api`, `draft_id`, real URL, operation and receipt files, and the returned `requirement_number` if any. The script re-verifies every field and the attempt order; a success boolean is not enough.
6. `cls observe --action import_scripts --draft ID`, build the import operation from the same CSV and the recorded draft ID, record a new `cls_api_attempt`, `cls run` (multipart `script_id`/`file`/`user_id`).
7. Check the whole group: count, order, names, creator, first-row link and "同上" for the rest, fixed tag, `parent.status=-2`. Save the receipt, then `record --step scripts_imported` with `quantity` and `names`, and the real script IDs. Then `message` and `report`.

The adapter returns only the summary and needed fields of successful business responses (HTTP 200 still needs `code=0`), never auth headers. It has no publish, status change, delete, edit-old-script, attachment or upload method; paths outside the allow-list are rejected before sending. Before import the draft must belong to the current account, be an outsourced requirement and have no scripts; if not, or if unsure, verify first and do not import.

## Recovery

Writes are never retried automatically; `cls_api_attempt` plus the `cls-sent-*.json` marker block a second send. An unknown write result comes back as `unknown_result:true` with `draft_id` and `operation_id` when known. Read back with `cls read-draft --id N` for a known ID. If creation timed out with no ID, the user gives a draft entry/ID that can be uniquely matched (or an approved read-only query finds it); never guess an ID, click through lists, or create again. `cls verify` produces a read-only receipt that reuses the original operation and events. After `blocked`, the user must fix the cause and ask to resume before `record resumed`. Partial import stays as is; if the draft cannot be uniquely found, stop. Never redo an API stage through the UI. Old UI batches keep their screenshot evidence; new API receipts need no screenshots.

## Handover

Deliver the progress range, the real draft URL and the copyable message. CSV, read-backs and reports stay internal (system temp), no auto cleanup, shown only on request. Use the official GOFCN number the system returned; without it keep the placeholder and say so. Never say "published". Reports carry evidence times and do not claim a fresh online check. Do not claim speed from mock tests; mark unapproved or untested steps as such.
