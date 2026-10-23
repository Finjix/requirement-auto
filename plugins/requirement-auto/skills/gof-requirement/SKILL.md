---
name: gof-requirement
description: "Publish GOFCN creative-material requirements (发布需求 / 素材需求 / 建单 / 创意进度表 / CLS 草稿) to suppliers from one or more Feishu requirement documents (sheet tab or doc links): work out rows, tags, 创意形式, 提炼词, supplier, reviewer and CLS fields from the documents, append the rows to the Feishu creative progress sheet and verify them, build the CSV, save an unpublished CLS requirement draft with the CSV imported, hand back screenshots of the progress sheet and the CLS draft, and hand over one copyable group message. Only for materials still to be made: finished materials the user sends to upload are gof-creative-upload (rows, no ticket). Asks only what cannot be worked out; runs everything once the plan is approved."
---

# GOFCN 发布需求 (publish a requirement)

Talk to the user in their language (Chinese unless they write otherwise). Field names, sheet columns and group messages stay Chinese.

`gof` = `node <skill>/../../server/dist/gof.mjs` (`<skill>` = this skill's directory; Node.js 24+).

## Flow

The user gives the requirement documents; a CLS ticket asks a supplier to make the materials. A request is the **full flow** unless the user narrows it ("只要 CSV"): append progress rows -> verify -> CSV -> unpublished CLS draft -> import the CSV into it -> screenshots of the progress sheet and the draft -> copyable group message. Publishing the draft and sending the message are the user's.

**Finished materials are not a requirement.** When the user sends the materials themselves (videos, pictures, folders, zips) to put into CLS, they are already made and need no ticket: that is [gof-creative-upload](../gof-creative-upload/SKILL.md) (rows appended for the files, then uploaded), not this skill.

**Several links in one message are one request:** one plan, one approval, one append of all rows, one CLS draft per document, one group message for all.

1. **Plan:** check logins, read the links and the progress sheet, work out every field, ask only what is left, show one plan, wait for the user's go-ahead.
2. **Execute:** run the approved plan to the end without asking again. Use your judgement on errors: retry read-only commands, re-login, re-export, fix and re-run what the tools refused. Ask the user only when the plan itself would have to change (rows, numbers, names) or something only they can do (login scan, permissions).

Messages the user sends while you work reach you in the same turn (lark-agent steers them in): take them as corrections or more material. A go-ahead counts only for a plan you have already shown; one that arrives before the plan does approves nothing.

The tools enforce the data rules themselves (append only into empty rows with `allow_overwrite:false`, each write sent once, drafts only); when one refuses, read its reason and act on it rather than working around it.

## Talking to the user

Short and plain, business language only: what will be done, what happened, what they must do. One line per stage ("正在追加进度表", "正在创建 CLS 草稿"). Leave out internals (IDs, revisions, receipts, snapshots, batches, files, checks) unless asked. When something stops: what is done, what is not, what they must do, and the concrete reason with the system's code (e.g. "HTTP 200，业务错误码 403，创意需求名称已存在"; Feishu: error kind and code), naming the conflicting value.

**No padding.** Ask only for what is missing, as plain questions ("制作人和创意人分别是谁？"). Never add conditions, defaults or instructions to a question ("如果是同一人，请说明", "未提供则留空", "如不需要请告知"): work such cases out from the answer itself (one name given for both, "都是 X" = the same person). Do not name the skill or describe how you are going to work ("我会按…技能处理"), do not repeat what an earlier message already said, and do not report a step that changes nothing for the user. Before sending, cut every sentence the user could do without.

If `append` rejects the overwrite receipt, tell the user "写入功能暂时不可用，请联系维护人员" (re-probing is the maintainers' job).

## Local files

Intermediate files (catalog, snapshots, requests, plans, observations) go to `<LARK_AGENT_USER_DIR>/requirement-auto/tmp`, not the working directory: lark-agent sends the user every new file in the working directory when a task ends, so only QR images, the two screenshots of the handover and files meant for the user go there. The CSV is an intermediate file too: it stays in the batch directory, is never copied to the working directory, and is not linked or mentioned in replies, unless the user asked for the CSV itself ("只要 CSV"); then copy that group's CSV to the working directory and link it. After `prepare`, keep everything in the batch directory and remember its path for the session; to resume, use the original batch. `gof` removes batches and tmp files untouched for 7 days.

## 0. Logins

Run `gof login check` at the start of every task, after approval before the first write, before the CLS stage, and whenever a command reports a lost login. It checks Feishu first (renewing the token), then CLS. Result `status`:

- `ok`: continue.
- `login_required`: do what `todo` says (one login at a time, Feishu first).
- `blocked`: relay `feishu.reason` / `cls.reason` to the user.
- `unknown`: Feishu temporarily unreachable; recheck shortly, the login is not lost.

**Feishu login:** `gof feishu login start` (keep the link to yourself), then `gof feishu authorize --qr feishu-login.png` in the working directory. `qr_ready`: tell the user to scan the image with the Feishu app and confirm on the phone (it expires in a few minutes; this scan also logs in CLS). `approved`: no scan needed. No browser installed: send the link and code from `login start` instead. After the user replies: `gof feishu authorize` (no `--qr`), `gof feishu login poll`, `gof login check`. `login_required` from `authorize` means the QR expired or nobody scanned: run it again with `--qr`.

**CLS login** (only if still needed after Feishu): `gof cls login --qr cls-login.png`, same message to the user; `logged_in` = no QR needed; `no_qr` = run `gof cls session` first. After the scan: `gof cls session` (~25 s; it presses the `dsc_admin` consent itself), then `gof login check`. Run the commands that use the browser (`login check`, `feishu authorize`, `cls …`, both screenshots) one after another, never in parallel: there is one browser per user, and a second command waits for the first (up to 2 minutes, then refuses with "正被另一个命令使用"). If it returns `expected_account`, tell the user to scan with that account; changing the bound account needs an admin to clear `cls/account.json` and `cls/browser-profile`.

## 1. Work out the request and plan

References: [feishu-sdk-workflow.md](references/feishu-sdk-workflow.md), [api-workflow.md](references/api-workflow.md), [data-contract.md](references/data-contract.md). Run `gof feishu doctor` once (Node, bridge, user, scopes); a missing permission goes to the user.

The user gives one or more Feishu requirement links (sheet tab or doc, usually one per supplier); without a link, ask for it. Each link is its own group, handled in the order given.

Gather:
1. `gof feishu document --url <link>` per link: `title` (usually names the supplier: 杨燃对接文档, 丁杰AI), wiki `path`, and the tab (linked, else newest: `sheet.chosen_by`) with header and rows, or the doc text. Add `--full` to read whole scripts.
2. `gof feishu snapshot --output <tmp>/<new>.xlsx`, then `gof feishu context --snapshot <it>`: target sheet, `next_number`, `naming` (how a new row is named: `GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>`, an empty 创意形式 dropping out with its `_`) and the dropdown `options` of 一级标签/二级标签/创意形式/设计师供应商/创意者脚本审核人.
3. `gof cls catalog --output <tmp>/catalog.json`: CLS account, permissions, and `choices` (GOFCN directions, task types, suppliers, people).

Fields (first source that answers wins):
- **条数:** sheet tab: one per requirement row (rows with a brief or script). Doc: what the newest dated entry (or the one the user names) asks for ("产出44条"). A count in the message wins.
- **设计师供应商** (required, one per document): message or doc, else the doc title, spelled as in `options`. Nothing names one: ask (with the other open points); never leave it empty on your own. Only when the user says the supplier is not decided yet ("供应商待定"): leave `supplier` empty; the sheet's cell stays empty, CLS takes `待定供应商` and the group message says `供应商：待定供应商`. When the supplier is the 创意者脚本审核人 too, still give `supplier` as that person: the sheet's cell stays empty (`supplier_cell_empty` in the plan; say "供应商与审核人同为 X，进度表供应商留空"), while CLS and the group message name the person. Within one request either every document's cell is filled or none is (else two requests).
- **一级标签 / 二级标签**, per row: stated tags or naming in the message/doc ("标签：多明星04_2min") first; otherwise judge from the row's script and other columns which existing option fits best (direction / selling point or theme). Doc column labels are hints, not a mapping. Ask only if no script or two options fit equally. Rows that differ become separate `items`, in doc order. A tag is one part of the name and never holds `_`.
- **创意形式** (制作形式, optional): only what the message or doc states for the rows (a 创意形式 column, "3D 制作", a name that holds it); never guessed from the script. Not stated: leave it empty. It is filled for all rows of the request or for none; when only some rows state it, leave it empty for all and put it in front of their 提炼词 (`3D_围炉`), which gives the same name.
- **提炼词** (the end of the material name; unless it is `关键词`, usually different for every row): what the message or doc states, for all rows or for each (a 提炼词 / 关键字 column, a naming rule: "命名加入关键字【ZJJC】" → ZJJC). When nothing states it, look for the pattern by which the doc names each material and take the part that tells them apart: a heading per piece like `GOFCN56890 企鹅保龄球 V15` → 企鹅保龄球 (not the number of the material it builds on, not the version), a title / 名称 / 主题 column, the names of the delivered files. Layouts vary: judge from the whole doc, keep the words as the doc writes them (one with / or  cannot be: the name is also the creative's CLS name, so ask the user how to write it), never make one up, and use one rule for all rows of a doc; a row it does not fit is asked about. A variant listed under a piece (同一条的国风配乐备用版) is another row of that piece, with its 提炼词 unless the doc names it. Rows with different 提炼词 are separate `items` (`quantity` 1 each, in doc order). Only when the doc names none: `关键词`, which the user confirms (see below), unless they already said so.
- **创意者脚本审核人:** message or doc; else a name in the wiki `path` (张天伟) or initials in the title (…-TW → 张天伟), when it matches exactly one `reviewer` option or CLS person. The plan says where it came from ("审核人：张天伟（来自文档所在目录）"). The reviewer is also the CLS creator and the message's 创意人.
- **CLS 创意方向 / 任务类型:** stated, else the best fit in `choices` (混剪 → 2D剪辑 / 视频; AI 视频 → AI视频 / AI生成).
- **CLS 供应商 / 创意人:** the program matches the supplier and reviewer to CLS names; if the preview cannot, set `cls.supplier` / `cls.creator` to the `choices` name that is clearly the same.
- **脚本内容:** the user's link as given.
- **`label` (optional):** the short name the user or doc gives the requirement ("迭代", "素人剧情"); the plan shows it as `message_kind` ("素人剧情*25") and the user can correct it there.
- **Dropdown values:** prefer an existing option that means the same (same spelling as in `options`). 一级/二级标签: add a new one only when the message or doc states it. 创意形式, 设计师供应商 and 创意者脚本审核人: a value the dropdown lacks is simply added. Either way the plan lists it (`new_options`: "新增创意形式 X"), and the user's go-ahead covers it.

Fixed by the program, not asked: CLS requirement name (`GOFCN<first>-GOFCN<last>` from the real numbers; never put it in `request.json`), material numbers (continue the sheet, running on across groups in link order), material name (`GOFCN<编号>_<一级>_<二级>_<创意形式>_<提炼词>` as `naming` shows it, the formula written by the plan; a row may also give the name it must get as `material_name`, when the doc names its rows so, and the plan checks it comes out exactly), CSV tag `玩法卖点（单选，必选）/展示向/展示向`. One document is one group (one CSV, one CLS ticket); documents are never merged. Other progress fields (客户端、创意表达、创意批次、参考…) stay blank. Unspecified quote/currency are CLS defaults 0 / cny. Sheet: user-named, else the newest year-month GOFCN sheet; if `plan` reports a tie or an unusable header, ask.

Collect all open points and ask them **once, in one short message**, at the end of the turn ("这批 44 条混剪的一级/二级标签填什么？"). Only the missing information, no plan preview. A 提炼词 the doc does not give is one of them ("文档里没找到提炼词，这 14 条都填「关键词」吗？"); when it is the only one, ask it in the plan instead.

Then:
1. Write `request.json` ([data-contract.md](references/data-contract.md)); run `gof feishu plan --request … --snapshot … --output <tmp>/plan-<date>.json` and `gof cls --preview --request … --catalog …`. A refusal: fix the request, or ask if it shows something cannot be worked out.
2. Show the plan in plain language, about 6-10 lines for one document (with several: shared lines once, then 3-4 lines each): the tab read (if the link named none), progress sheet name, row count and 预计 material numbers, names by kind with counts ("12 条 AI生成_设定3.0_关键词"), rows with 提炼词 of their own one by one when few ("GOFCN67680 企鹅保龄球"), with the rule they came from and one example ("提炼词取自每条标题中间那段：GOFCN56890 企鹅保龄球 V15 → 企鹅保龄球"), and for the group's `default_keyword_rows`, unless the user already confirmed it, the question "这 N 条文档里没找到提炼词，先填「关键词」可以吗？", 供应商 ("待定，CLS 选待定供应商" only when the user said so) and 审核人/创意者, 创意形式 when filled, dropdown values to add (`new_options`), "客户端、创意表达、创意批次及参考等其他字段留空", per CLS group the requirement name, 创意方向, 任务类型, CLS 供应商, quantity and script link, that the draft is saved unpublished with the scripts imported, and the group message's `message_kind` (需求编号 filled in after publishing), and any `same_name_rows` (rows already in the sheet under a name the request gives: most likely registered before; leave them out unless the user says they are new). End with "确认后我就开始执行". A correction from the user: plan again and show it again.

## 2. Execute: append and CSV

1. `gof login check`.
2. Each `new_options` entry: `gof feishu dropdown-add --field primary|secondary|form|supplier|reviewer --option <value> --sheet <sheet name>` (safe to re-run).
3. Fresh `gof feishu snapshot`, then `gof feishu prepare --plan <tmp>/plan-….json --snapshot <fresh>.xlsx` (creates the batch). If rows, numbers or names changed, show the updated plan and wait.
4. `gof feishu append --batch …`: one write of the approved range, then a full re-export and verification; success records `append_verified`. `foreign_changes` lists edits colleagues made elsewhere in the workbook meanwhile: they do not concern the append; mention them in one line only if asked. A refusal **without** `write_sent` came before anything was sent (the sheet changed): snapshot and `prepare` again. A refusal **with** `write_sent: true` means the rows may already be in the sheet: never `prepare` or append that request again; go to step 5.
5. Interrupted, `write_sent` or unclear result: `gof batch status`, then `gof feishu reconcile --batch …` ([Interruption recovery](references/feishu-sdk-workflow.md#interruption-recovery)). Complete: continue with the existing CSV. Not applied (nothing of it is in the sheet): tell the user; with their go-ahead plan again. Partial or conflicting: report what exists to the user (`rule_issue` says when the new rows lack their dropdowns). After `blocked`, once the cause is fixed, `record --step resumed` and continue. `prepare` itself refuses a request whose earlier unverified batch already has rows in the sheet.

## 3. Execute: CLS unpublished draft

`gof login check`, then per group, one after another in plan order: save the draft (`status=-2`), import that group's CSV with the reviewer as creator, read back. The exact command sequence is in [api-workflow.md](references/api-workflow.md). An unknown save result: read back (`cls read-draft` / `cls verify`) instead of creating again. If a group fails, report which groups have a ticket and which do not.

## 4. Handover

`gof batch message --batch …` builds the group message; hand it over exactly as returned, once for all documents. It has no @ (a pasted @ does not turn into a mention in Feishu), so introduce it with: `草稿已导入全部脚本，尚未发布。请发布后将以下消息粘贴到群里，@李聪（Cici） 后发送：`. `【发布后补填需求编号】` marks groups without an official number (`missing_numbers`): tell the user to fill it in after publishing. Groups without a ticket are left out (`skipped_groups`): say which. If the user later gives the real number, `record --step requirement_number` and regenerate.

`gof batch report --batch …` (it prints the report with its `links`; no `--output` needed, and a saved copy can only go inside the batch directory).

**Screenshots** (after the report, in the working directory; they go to the user with the reply): the progress sheet on the appended rows, `gof feishu screenshot --batch … --output progress-<time>.png`, and each group's CLS draft, `gof cls screenshot --batch … --group <group> --output cls-draft-<group>-<time>.png` (for a single document `--group` can be left out). Both only look at the pages in this user's own browser: the sheet opens as the user (the Feishu scan logs in the web page too), the draft in the CLS app. Take what the run produced: no progress picture when nothing was appended, no draft picture for a group without a draft. Then look at each picture yourself (open the PNG) before it goes out: a sign-in page, a "no permission" page, an empty sheet or a sheet that does not show the new GOFCN numbers is not handed over. A refused or poor picture never fails the task: say in one line which picture is missing and why (the command's `reason`, e.g. a lost Feishu web login: `gof login check`, then once more), and keep the links.

Give the user: appended numbers, the links from the report's `links` (only those; not the CSV or other local files) ("创意进度表：<link>", "CLS 草稿：<link>", or with several documents "CLS 草稿（<供应商>·<类型名>）：<link>"), the copyable message and what is left for them (publish, fill in 需求编号, paste into the group, @李聪（Cici）, send). The screenshots go as attachments only: no text link to them, no local path or URL for the image (such a link does not open); the links above stay. Give the links for whatever exists also when the run stopped part-way.
