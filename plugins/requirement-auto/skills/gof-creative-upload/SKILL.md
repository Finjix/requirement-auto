---
name: gof-creative-upload
description: "Upload finished GOFCN creative materials (上传素材 / 素材上传 / 上传创意 / 传素材到 CLS) the user sends or names (videos, pictures, folders, zips): fill the Feishu creative progress sheet first (append and verify a row per file that has none yet: from file names like GOFCNxxxxx_<一级>_<二级>_[<创意形式>_]<提炼词>, or from the documents the user gives; files whose rows are already there are not appended again), then upload each file to CLS 我的创意 > 创意列表 > 上传创意 as one creative named exactly as its row's 素材名称 (上传目录 默认 双端共用-视频, 创意人 = 创意者脚本审核人, 制作人 = 设计师供应商, 素材类型 by file kind, no 创意标签). No CLS requirement ticket, no CSV, no group message: the materials are already made (a ticket asks a supplier to make them; that is gof-requirement). Confirms one plan, then appends, uploads, saves, and hands back screenshots of the progress sheet and the creative list."
---

# GOFCN 上传素材 (upload finished materials)

Talk to the user in their language (Chinese unless they write otherwise). Field names, sheet columns and CLS fields stay Chinese.

`gof` = `node <skill>/../../server/dist/gof.mjs` (`<skill>` = this skill's directory; Node.js 24+). Every command prints one JSON line; a refusal is `status: blocked` with the reason.

## Flow

The user gives materials that are made. A request is the **whole flow** unless the user narrows it ("只登记进度表" / "只上传"): append a progress-sheet row for each file that has none yet -> verify -> upload the files to CLS 创意列表 under their rows' 素材名称 -> save the annotation and read it back -> screenshots of the progress sheet and the creative list. **No CLS requirement ticket**: a ticket asks a supplier to make materials ([gof-requirement](../gof-requirement/SKILL.md)); these need none, so there is no CSV, CLS draft or group message either.

1. **Plan:** check logins, collect the files, work out each file's row (already in the sheet, or new: tags, 创意形式, 提炼词) and people, the upload fields, ask only what is left, show one plan, wait for the user's go-ahead.
2. **Execute:** run the approved plan to the end without asking again. Use your judgement on errors: retry read-only commands, re-login, re-export, fix and re-run what the tools refused. Ask the user only when the plan itself would have to change (files, rows, numbers, names, people) or something only they can do (login scan, permissions).

Messages the user sends while you work reach you in the same turn (lark-agent steers them in; a zip sent after the text arrives this way): take them as corrections or more material. A go-ahead counts only for a plan you have already shown; one that arrives before the plan does approves nothing.

The tools enforce the data rules themselves (append only into empty rows with `allow_overwrite:false`, each write sent once, each creative created once); when one refuses, read its reason and act on it rather than working around it.

## Talking to the user

Short and plain, business language only: what will be done, what happened, what they must do. One line per stage ("正在追加进度表", "正在上传素材"). Leave out internals (IDs, hashes, revisions, batches, plan files, checks) unless asked. When something stops: what is done, what is not, what they must do, and the concrete reason with the system's code (e.g. "HTTP 200，业务码 403，以下创意已存在: …"; Feishu: error kind and code).

**No padding.** Ask only for what is missing, as plain questions ("制作人和创意人分别是谁？"). Never add conditions, defaults or instructions to a question ("如果是同一人，请说明", "未提供则留空", "如不需要请告知"): work such cases out from the answer itself (one name given for both, "都是 X" = the same person). Do not name the skill or describe how you are going to work ("我会按…技能处理"), do not repeat what an earlier message already said, and do not report a step that changes nothing for the user. Before sending, cut every sentence the user could do without.

If `append` rejects the overwrite receipt, tell the user "写入功能暂时不可用，请联系维护人员" (re-probing is the maintainers' job).

## Local files

Requests, snapshots and plans go to `<LARK_AGENT_USER_DIR>/requirement-auto/tmp` (zips are unpacked there too), never the working directory: lark-agent sends the user every new file there when a task ends, so only QR images and the two screenshots go there. Never move, rename or edit the user's files: renaming is done by the upload itself (each file goes up under its new name). After `prepare`, remember the batch path for the session; to resume, use the original batch. `gof` removes batches and tmp files untouched for 7 days.

## 0. Logins

`gof login check` at the start, after approval before the first write, before the upload, and when a command reports a lost login. `ok`: go on. `login_required`: do what `todo` says, one login at a time, Feishu first: `gof feishu login start` (keep its link to yourself), `gof feishu authorize --qr feishu-login.png` in the working directory, tell the user to scan it with the Feishu app and confirm on the phone (it expires in minutes; the same scan logs in CLS); `approved` means no scan is needed; after their reply `gof feishu authorize`, `gof feishu login poll`, `gof login check`. If CLS alone is missing: `gof cls login --qr cls-login.png`, then `gof cls session` after the scan. `blocked`: relay the reason. `unknown`: Feishu is briefly unreachable; check again. Run `login check`, `feishu authorize`, `cls`/`creative` commands and both screenshots one after another, never in parallel: they share the user's one browser, and a second command waits for the first (up to 2 minutes, then refuses with "正被另一个命令使用").

## 1. Files and their rows

References: [feishu-sdk-workflow.md](../gof-requirement/references/feishu-sdk-workflow.md), [data-contract.md](../gof-requirement/references/data-contract.md). Run `gof feishu doctor` once; a missing permission goes to the user.

**Files:** what the user attached (the host lists them: "Files the user attached to this message … - <path>") and local files or folders they name. `gof creative files <path> [<path> …]` lists what they hold (zips unpacked into tmp; reads only): per file `file`, `name`, `kind`, `number` (a GOFCN number in the name), and for a name with the number open (`GOFCNxxxxx_…`; any run of x, X, * or none) `name_without_number` and `parts`. Each file is one creative and one row, in the order listed. A folder is read one level deep. **A zip is a folder:** Feishu cannot hand a dragged-in folder to the bot, so users send it zipped (the files at its top, or in the one folder it holds; deeper folders are listed as skipped). Accepted: mp4 mov avi m4v, jpg jpeg png gif webp bmp, html mp3 wav; everything else is listed with the reason (rar/7z, txt, mkv, nested folders…). If the user says they sent a folder and nothing arrived, ask them to zip it (right-click → 压缩) and send the zip; lark-agent takes up to 10 attachments per message, 2 GB each.

**Each file is one row of the progress sheet** (the plugin's sheet, or the progress-sheet link the user gives), named `GOFCN<素材编号>_<一级标签>_<二级标签>_[<创意形式>_]<提炼词>`, and the creative gets exactly that 素材名称. Most files are new and get a new row. A file whose row is already in the sheet is only uploaded, never appended again:
- named exactly as a row's 素材名称 (`GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球.mp4`; `gof creative rows --numbers 67680` shows the row);
- named `GOFCNxxxxx_…` and listed in the rows plan's `same_name_rows` (registered before);
- the user says whose materials they are (made for a requirement published earlier: "这是 GOFCN67680-67683 的成片"): `gof creative rows --numbers 67680-67683` or `--find 企鹅保龄球,冻鱼飞盘` (text in 素材名称 or 提炼词, newest first; about a minute, reads only) lists the rows; match each file to its row from what the user says and the requirement or delivery documents (`gof feishu document --url <link>`, `--full` for whole scripts): name, order, version, duration, size and kind against each row's 提炼词, tags, script and place. Rows named alike but for the number are taken in the order the requirement lists them; say so in the plan.

A GOFCN number in a file name that is not its row's 素材名称 (`GOFCN67680_成片.mp4`, or the 终稿库 heading `GOFCN56890 企鹅保龄球 V15`: a new piece made from GOFCN56890) does not make the file that row: it is new, unless the user or a document says which row it is.

**New rows.** `gof feishu snapshot --output <tmp>/<new>.xlsx`, then `gof feishu context --snapshot <it>`: target sheet, `next_number`, `naming` and the dropdown `options` of 一级标签/二级标签/创意形式/设计师供应商/创意者脚本审核人. Each new file is one item of `quantity` 1, in file order:
- **Named the sheet's way** (`parts`): 一级标签 = `primary_tag`, 二级标签 = `secondary_tag`; `rest` is the 提炼词, `_竖版` / `_横版` and version words included, unless it starts with a 创意形式: then that first part is `creative_form` and the rest after it the `keyword`. Judge that from the whole batch: a first part that is a 创意形式 option (`3D`, `2D`, `解说`…) or that the user calls one is; a first part several files share with different endings is the piece's name, not a form (`…_兵临城下塔防_冻鱼_竖版`, `…_兵临城下塔防_企鹅_竖版`: 提炼词 `兵临城下塔防_冻鱼_竖版`, `兵临城下塔防_企鹅_竖版`); when in doubt, it is 提炼词 (the name is the same either way). Some files with a 创意形式 and some without: leave it in the 提炼词 for all. The file's name goes into `material_name`, which the plan checks comes out exactly. `unclear` (fewer than three parts) is asked about.
- **Named otherwise** (`01.mp4`, `企鹅保龄球_v15.mp4`): the tags, 创意形式 and 提炼词 come from what the user says or the documents they give (requirement, script or delivery doc): prefer existing dropdown options for the tags, take the 提炼词 as the document writes the part that tells the pieces apart (企鹅保龄球, not the number of the piece it builds on, not the version). What cannot be worked out is asked; never made up.
- A tag or 创意形式 is one part of the name and never holds `_`; a 提炼词 may hold `_` (not at its ends or twice in a row) but not `/` or `\` (the name is also the creative's CLS name).
- Values the dropdowns lack (tags, 创意形式, supplier, reviewer) are taken as the files or the user name them: the plan lists them in `new_options`, added after approval.

**People** (first source that answers wins: the user's message; this conversation; the documents, the folder or zip name; else ask):
- **设计师供应商** (who made the materials) is also the uploads' **制作人**. **Required**: finished materials were made by someone, so it is always named; when the message, conversation, documents or folder/zip name do not say who, ask (with the other open points). Never leave it empty and never use `待定供应商` (that is only for a requirement whose supplier is not decided yet). Spelled as in `options`.
- **创意者脚本审核人** is also the uploads' **创意人**. Required.
- **Same person** (the reviewer made the materials; judge it from what the user says, never ask whether they are the same): give `supplier` as that person anyway; the plan leaves the sheet's 设计师供应商 cell empty (`supplier_cell_empty`), and the 制作人 is still that person, so give it at the top-level `producers` of the upload request (its CLS name). An existing row whose 设计师供应商 is empty is often this case: ask who made it ("GOFCN67680 是谁做的？"), and give the answer in `items[].producers`.
- The sheet spells people short, CLS in full: `gof creative options --creator <审核人> --producers <供应商>[,<供应商>…]` matches them as the upload will (`people`: each name's CLS name, or the problem). One it cannot match: the name in its `creators` / `producers` lists that is clearly the same (廿十一 → 长沙廿拾一文化传媒有限公司), or ask; two people of one name: their CLS user ID, or ask.

**Upload fields:**
- **上传目录:** `双端共用-视频` unless the user names another; `gof creative options --find <text>` finds a directory by name. A path ending (`常规素材/图片`) picks one of two with the same name.
- **素材类型:** by the file: picture → 图片, video → 视频, anything else → 其他. Another type only when the user states it (`items[].type`, e.g. `AI生成`).
- **创意标签:** not filled.

Collect all open points and ask them **once, in one short message** ("这 3 个文件是谁做的、脚本审核人是谁？").

## 2. Plan

1. **Rows:** write `request.json` for the new files ([data-contract.md](../gof-requirement/references/data-contract.md#rows-for-finished-materials)): one group with `supplier`, `reviewer` and one item per file; **no `script_url` and no `cls`** (no ticket). Run `gof feishu plan --request … --snapshot … --output <tmp>/plan-<time>.json`. A refusal: fix the request, or ask if it shows something cannot be worked out. A file in `same_name_rows` is most likely registered before: leave it out of the request and upload it against that row, unless the user says it is a new piece.
2. **Files already in the sheet** (if any): check them now with `gof creative plan` (section 4, step 1) on a request of only those files; it says a row whose creative CLS already has (already uploaded).
3. Show the plan in plain language, about 6-10 lines: how many files and of which kinds ("共 5 个视频"); the rows to append: progress sheet name, count and 预计 material numbers, each as `文件名 → GOFCN<预计编号>_…` when few (else the count and two examples), with where the tags and 提炼词 came from when not from the file names; the files already in the sheet ("2 个已在进度表（GOFCN67680、GOFCN67681），只上传"); 创意形式 when filled; dropdown values to add (`new_options`: "新增二级标签 X"); 设计师供应商 and 创意者脚本审核人, with where they came from (the same person: "供应商与审核人同为 X，进度表供应商留空"); "客户端、创意表达、创意批次及参考等其他字段留空"; then the upload: 上传目录 (its path), 创意人 and 制作人 as CLS names, 素材类型, "创意标签不填", files that will not be uploaded and why, that CLS syncs them to AdsDesk in that directory by itself, and "不建 CLS 需求单（素材已做好）". End with "确认后我就开始执行". A correction from the user: plan again and show it again.

When every file is already in the sheet, there are no rows: the plan is the upload part, from `gof creative plan`.

## 3. Execute: append the rows

1. `gof login check`.
2. Each `new_options` entry: `gof feishu dropdown-add --field primary|secondary|form|supplier|reviewer --option <value> --sheet <sheet name>` (safe to re-run).
3. Fresh `gof feishu snapshot`, then `gof feishu prepare --plan <tmp>/plan-….json --snapshot <fresh>.xlsx` (creates the batch). If rows, numbers or names changed (colleagues appended meanwhile), show the new numbers and wait.
4. `gof feishu append --batch …`: one write of the approved range, then a full re-export and verification; success records `append_verified`. `foreign_changes` lists colleagues' edits elsewhere in the workbook: they do not concern the append; mention them only if asked. A refusal **without** `write_sent` came before anything was sent: snapshot and `prepare` again. A refusal **with** `write_sent: true` means the rows may already be in the sheet: never `prepare` or append these files again; go to step 5.
5. Interrupted, `write_sent` or unclear result: `gof batch status`, then `gof feishu reconcile --batch …` ([Interruption recovery](../gof-requirement/references/feishu-sdk-workflow.md#interruption-recovery)). Complete: continue with the upload. Not applied (nothing of it is in the sheet): tell the user; with their go-ahead plan again. Partial or conflicting: report what exists to the user (`rule_issue` says when the new rows lack their dropdowns) and upload nothing for those files. After `blocked`, once the cause is fixed, `record --step resumed` and continue. `prepare` itself refuses files whose earlier unverified batch already has rows in the sheet.

## 4. Execute: upload

1. Write the upload `request.json` (paths absolute; `items` only for what differs per file) and run `gof creative plan --request <tmp>/request.json --output <tmp>/upload-plan-<time>.json`:

```json
{
  "files": ["D:/…/workspace/input/玩法AI迭代素材.zip", "D:/…/workspace/input/01.mp4"],
  "directory": "双端共用-视频",
  "producers": ["长沙廿拾一文化传媒有限公司"],
  "items": [
    { "file": "01.mp4", "number": 67742 },
    { "file": "封面.png", "number": 67690, "type": "图片", "directory": "常规素材/图片" },
    { "file": "说明.mp4", "skip": true }
  ]
}
```

   - Files named `GOFCNxxxxx_…` are found by their name (`row_from: name`) and go up with the number filled in. A file named exactly as its 素材名称 needs nothing. Every other file takes `items[].number`: its new row's number (the batch's rows are in file order) or the existing row you matched. `items[].file` is the file name; for files of the same name in two zips, `<zip name>：<file name>` as `creative files` lists them.
   - `creator` / `producers` at the top replace every file's people from its own row: give them (the CLS names matched in section 1) only when they hold for every file; for one file, `items[].creator` / `items[].producers`. Files without them take their row's 创意者脚本审核人 and 设计师供应商; an existing row whose 设计师供应商 is empty makes the plan refuse (制作人未定): ask the user who made the file and give it in `items[].producers`.
   - Rows the sheet cannot name, as the plan says: a number on rows of several tabs that say different things takes the tab in `items[].sheet`; a row whose 素材名称 is empty, cannot be worked out or contains / or \ needs the user: they fix the sheet, or confirm a name you then give in `items[].name` (only such a row takes one). Only for materials the user says are on no progress sheet: `"progress": false` (nothing appended; the files keep their names or `items[].name`).
   - It only reads: the files (hashed), what CLS offers, the progress sheet (about a minute), and whether a name already exists in CLS (CLS refuses a whole batch for one taken name). A refusal lists everything unsettled at once: fix what you can, ask the user the rest in one short message. The result gives per file its `name`, `renamed`, `progress_row` and `row_from`. It needs no second approval when it puts up the approved files under the approved names (the appended rows' 素材名称) with the approved people, directory and types; otherwise show what differs and wait.
2. `gof login check`, then `gof creative run --plan <the upload plan>`. It checks the files are unchanged and that the people, directory and types are still on offer, then uploads (each file under its planned name), creates the creatives (= 下一步), saves 创意人/制作人/素材类型 (= 保存) and reads them back. It never creates twice; running it again on the same plan goes on from where it stopped. Results:
   - `uploaded`: every file is a creative with its annotation (`uploaded[]`: name, type, 创意人, 制作人, `adsdesk` 同步中/已同步).
   - `partial`: some files did not become creatives (`not_created`, each with its reason: CLS already has the same file (MD5), or CLS refused) or an annotation is missing (`annotate_error`, `uploaded[].problems`). Report which.
   - `unknown`: a create's answer was lost and some creatives are not found yet (`missing`). Run the same command again a little later: it only looks, it never creates again. Still missing: tell the user which files, and that they can check the list.
   - `blocked`: relay `reason`. Before anything was created, a fixed request means a new upload plan (and approval if it differs); after a create, never make a second plan for the same files without asking.

## 5. Handover

1. When rows were appended: `gof batch report --batch …` (prints the report with its `links`; no `--output` needed).
2. **Screenshots** in the working directory (they go to the user with the reply): the progress sheet on the appended rows, `gof feishu screenshot --batch … --output progress-<time>.png` (only when rows were appended), and 我的创意 > 创意列表 of this account, newest first, `gof creative screenshot --output creatives-<time>.png --rows <number uploaded, max 12>`. Look at each picture yourself (open the PNG) before it goes out: a sign-in page, a "no permission" page, an empty sheet or one that does not show the new GOFCN numbers, or a list without the new creatives is not handed over. A refused or poor picture never fails the task: say in one line which picture is missing and why (the command's `reason`, e.g. a lost Feishu web login: `gof login check`, then once more), and keep the links.
3. Give the user, in one reply: the appended numbers and the progress-sheet link from the report's `links.progress_sheet` ("创意进度表：<link>"); how many files went up under their 素材名称 (names when few, `原文件名 → 素材名称` for the renamed), 上传目录, 创意人/制作人, 素材类型, the AdsDesk sync state, what failed and why, and "创意列表：https://creative.centurygames.cn/creativities". The screenshots go as attachments only: no text link to them, no local path or URL for the image (such a link does not open). Give the links for whatever exists also when the run stopped part-way. There is no group message and nothing for the user to publish.
