---
name: gof-creative-upload
description: "Upload GOFCN creative materials (素材上传 / 上传创意 / 传素材到 CLS) the user sends or names (videos, pictures, folders, zips) to CLS 我的创意 > 创意列表 > 上传创意: one creative per file, named exactly as the 素材名称 of its row in the creative progress sheet (files named otherwise, e.g. 01.mp4 or g56890_a_v15.mp4, are matched to their row from the requirement / script / delivery documents and go up renamed), 上传目录 默认 双端共用-视频, 创意人 = 创意者脚本审核人, 制作人 = 设计师供应商 (from the message, this conversation or the file's row), 素材类型 by file kind, no 创意标签. Materials whose rows do not exist yet (new pieces, or files already named the sheet's way with the number still open, GOFCNxxxxx_<一级>_<二级>_[<创意形式>_]<提炼词>) are registered first from the files themselves: rows appended to the progress sheet and a CLS ticket made (the gof-requirement flow), then uploaded, all under one plan and one approval. Confirms one plan, uploads, saves, and hands back a screenshot of the creative list."
---

# GOFCN creative material upload

Talk to the user in their language (Chinese unless they write otherwise). CLS field names stay Chinese.

`gof` = `node <skill>/../../server/dist/gof.mjs` (`<skill>` = this skill's directory; Node.js 24+). Every command prints one JSON line; a refusal is `status: blocked` with the reason.

## Flow

1. **Plan:** check logins, collect the files, work out which progress-sheet row each file is (its name), 上传目录 / 创意人 / 制作人 / 素材类型, ask only what is left, show one plan, wait for the go-ahead.
2. **Execute:** upload, save the annotation, read back, screenshot the creative list, hand over. Do not ask again unless the plan itself would change (files, names, people) or only the user can act (login scan).

The order is not fixed. Files whose rows are already in the sheet (appended earlier in this conversation, or by anyone before) are only uploaded. Files whose rows do not exist yet are new materials: register them first (rows and CLS ticket, from the files), then upload them; see [section 3](#3-new-materials-register-then-upload). One request can be both.

Messages the user sends while you work reach you in the same turn (lark-agent steers them in; a zip sent after the text arrives this way): take them as corrections or more material. A go-ahead counts only for a plan you have already shown; one that arrives before the plan does approves nothing.

The page's two steps are one command here: `gof creative run` puts the files up, creates the creatives (= 下一步) and saves 创意人/制作人/素材类型 (= 保存), then reads them back. It never creates twice; running it again on the same plan goes on from where it stopped.

## Talking to the user

Short and plain: what will be uploaded, what happened, what they must do. Leave out internals (IDs, hashes, batches, plan files) unless asked. When something stops: what is done, what is not, and the concrete reason with CLS's code (e.g. "HTTP 200，业务码 403，以下创意已存在: …").

## Local files

Requests and plans go to `<LARK_AGENT_USER_DIR>/requirement-auto/tmp` (zips are unpacked there too), never the working directory (lark-agent sends the user every new file there when a task ends). Only the screenshot and QR images go to the working directory. Never move, rename or edit the user's files: renaming is done by the upload itself (the plan puts each file up under its new name).

## 0. Logins

`gof login check` at the start, after approval before the upload, and when a command reports a lost login. `ok`: go on. `login_required`: do what `todo` says, one login at a time, Feishu first: `gof feishu login start` (keep its link to yourself), `gof feishu authorize --qr feishu-login.png` in the working directory, tell the user to scan it with the Feishu app (it expires in minutes; the same scan logs in CLS); after their reply `gof feishu authorize`, `gof feishu login poll`, `gof login check`. If CLS alone is missing: `gof cls login --qr cls-login.png`, then `gof cls session` after the scan. `blocked`: relay the reason. `unknown`: Feishu is briefly unreachable; check again. Run `login check`, `feishu authorize`, `cls`/`creative` commands one after another, never in parallel: they share the user's one browser, and a second command waits for the first (up to 2 minutes, then refuses with "正被另一个命令使用").

## 1. Work out the upload and plan

**Files:** what the user attached (the host lists them: "Files the user attached to this message … - <path>") and local files or folders they name. A folder is read one level deep; each file is one creative (named as its progress-sheet row, below). **A zip is a folder:** Feishu cannot hand a dragged-in folder to the bot, so users send the folder zipped; give the zip's path in `files` and the plan unpacks it (the files at its top, or in the one folder it holds; deeper folders are listed as skipped). Accepted: mp4 mov avi m4v, jpg jpeg png gif webp bmp, html mp3 wav. The plan lists everything else with the reason (rar/7z, txt, mkv, nested folders…). If the user says they sent a folder and nothing arrived, ask them to zip it (right-click → 压缩) and send the zip; lark-agent takes up to 10 attachments per message, 2 GB each.

**Names: each file is one row of the progress sheet.** A creative is named exactly as the 素材名称 of its row in the creative progress sheet (the plugin's sheet, or the progress-sheet link the user gives: `"progress": "<link>"`). The plan takes the name from the sheet and puts the file up under it, creative and uploaded file alike; you never type a name. Suppliers rarely send files named that way (`01.mp4`, `g56890_a_v15.mp4`), so work out each file's row first:
- A file named the sheet's way with the number still open (`GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版.mp4`; any run of x, X, * or none) is the row named `GOFCN<number>_<the rest>`: the plan finds it by itself (`row_from: name`) and puts the file up with the number filled in. No such row yet: the file is new, register it first (section 3). Two rows of that name: `items[].number` picks one.
- Only a file already named exactly as its 素材名称 needs nothing else. Every other file needs `items[].number`, also one whose name carries a GOFCN number (`GOFCN67680_成片.mp4`): that number can be the original the piece builds on (the 终稿库 heading `GOFCN56890 企鹅保龄球 V15` is a new piece made from GOFCN56890), so check it against the requirement and write the number even when it is the one in the name. The plan refuses to place such a file by its name, and refuses a row whose creative CLS already has.
- Otherwise judge from what you have: rows appended earlier in this conversation (numbers, names, the requirement link), and the documents the user sends or names, or that the requirement used: requirement sheet or doc, script content, a delivery list that names each file under its heading (终稿库). Read them with `gof feishu document --url <link>` (`--full` for whole scripts). Compare each file's name, order, version, duration, size and kind with each row's 提炼词, tags, script and place in the requirement.
- Candidate rows: `gof creative rows --numbers 67680-67683` (numbers from this conversation, from the user, or the CLS requirement name `GOFCN67680-GOFCN67683`) or `--find 企鹅保龄球,冻鱼飞盘` (text in 素材名称 or 提炼词, newest first); `--progress <link>` for another sheet. It only reads (about a minute).
- Rows named alike but for the number (`…_3D_围炉煮冰` twice, e.g. a piece and its 国风配乐 version) are taken in the order the requirement lists them; say so in the plan.
- Write each decision as `items[].number`, one file per row. `items[].file` is the file name; for files of the same name in two zips, `<zip name>：<file name>` as the plan lists them (`供应商B.zip：01.mp4`). Ask the user only about the files you cannot place with confidence (one message, with their candidate rows).
- Rows the sheet cannot name, as the plan says: a number on rows of several tabs that say different things takes the tab in `items[].sheet` (the tab `rows` shows under `where`); a row whose 素材名称 is empty, cannot be worked out or contains / or \ needs the user: they fix the sheet, or confirm a name you then give in `items[].name` (only such a row takes one).
- Only for materials the user says are on no progress sheet: `"progress": false`; the files keep their names (or `items[].name`), and the plan says so.

**Fields** (first source that answers wins):
- **上传目录:** `双端共用-视频` unless the user names another; `gof creative options --find <text>` finds a directory by name. A path ending (`常规素材/图片`) picks one of two with the same name.
- **创意人** (one person) is the requirement's 创意者脚本审核人; **制作人** (one or more) its 设计师供应商. Sources, in order: the user's message; this conversation (a requirement handled earlier in it names its reviewer and supplier); the file's row in the progress sheet; otherwise ask. A row whose 设计师供应商 is empty gets the 制作人 `待定供应商` by itself (as its CLS ticket has). Short names are fine (丁杰 → 北京柒曦文化传媒有限公司（丁杰）); for two people with the same name give the CLS user ID the plan error lists, or ask. The sheet's names are not always CLS's (its 廿十一 is 长沙廿拾一文化传媒有限公司 in CLS): when the plan refuses one, give the CLS name in that file's `items[].producers` / `items[].creator` (the requirement's CLS supplier, or the clearly same name `gof creative options` lists). Top-level `producers` / `creator` only when they hold for every file: they replace every file's people from its own row.
- **素材类型:** by the file: picture → 图片, video → 视频, anything else → 其他. Another type only when the user states it (`items[].type`, e.g. `AI生成`).
- **创意标签:** not filled.

Write `request.json` (paths absolute; `items` only for what differs per file):

```json
{
  "files": ["D:/…/workspace/input/玩法AI迭代素材.zip", "D:/…/workspace/input/GOFCN67471_成片.mp4"],
  "directory": "双端共用-视频",
  "producers": ["长沙廿拾一文化传媒有限公司"],
  "items": [
    { "file": "g56890_a_v15.mp4", "number": 67680 },
    { "file": "封面.png", "number": 67690, "type": "图片", "creator": "雷佳威", "producers": ["杨燃"], "directory": "常规素材/图片" },
    { "file": "说明.mp4", "skip": true }
  ]
}
```

`creator`/`producers` at the top apply to every file; files without them take their row's. Then `gof creative plan --request <tmp>/request.json --output <tmp>/upload-plan-<time>.json`. It only reads: the files (hashed), what CLS offers, the progress sheet (about a minute), and whether a name already exists in CLS (CLS refuses a whole batch for one taken name). A refusal lists everything unsettled at once: fix what you can (a file without a row: work out its `items[].number`), ask the user the rest in one short message. The result says how many files go up `renamed`, and per file its `name`, `renamed`, `progress_row` and `row_from` (`request`: your `items[].number`; `file_name`: the number in its name; `name`: a `GOFCNxxxxx_…` name found in the sheet). A refusal "要先登记" means those files have no rows yet: section 3.

Show the plan in plain language, about 5-10 lines: how many files and of which kinds ("共 4 个视频"); each renamed file as `原文件名 → 素材名称` with why that row (「终稿库：企鹅保龄球 V15」「需求第 3 条」「文件名里的编号」) when there are only a few, else the count and two examples; "其余 N 个名称已和进度表一致"; 上传目录 (its path); 创意人 and 制作人 as CLS names and where they came from ("来自进度表那一行" / "来自本次对话的需求" / "你指定的"); 素材类型; "创意标签不填"; files that will not be uploaded and why; and that CLS syncs the materials to AdsDesk in that directory by itself. End with "确认后我就开始上传". A correction (another row for a file): plan again and show it again.

## 2. Execute

1. `gof login check`.
2. `gof creative run --plan <the approved plan>`. It checks the files are unchanged and that the people, directory and types are still on offer, then uploads (each file under its planned name), creates, annotates and reads back. Results:
   - `uploaded`: every file is a creative with its annotation (`uploaded[]`: name, type, 创意人, 制作人, `adsdesk` 同步中/已同步).
   - `partial`: some files did not become creatives (`not_created`, each with its reason: CLS already has the same file (MD5), or CLS refused) or an annotation is missing (`annotate_error`, `uploaded[].problems`). Report which.
   - `unknown`: a create's answer was lost and some creatives are not found yet (`missing`). Run the same command again a little later: it only looks, it never creates again. Still missing: tell the user which files, and that they can check the list.
   - `blocked`: relay `reason`. Before anything was created, a fixed request means a new plan (and approval); after a create, never make a second plan for the same files without asking.
3. `gof creative screenshot --output creatives-<time>.png --rows <number uploaded, max 12>` in the working directory: 我的创意 > 创意列表 of this account, newest first (the image goes to the user with the reply).
4. Hand over: how many went up under their 素材名称 (names when few, `原文件名 → 素材名称` for the renamed), 上传目录, 创意人/制作人, 素材类型, AdsDesk sync state, what failed and why, the link `https://creative.centurygames.cn/creativities`, and the screenshot as an attachment only. Never add a text link to the screenshot (no "上传结果截图" link, no local path or URL for the image): the attachment already carries it and such a link does not open.

## 3. New materials: register, then upload

Files can come before their rows: finished pieces of a requirement that is not in the sheet yet, or files the user already named the sheet's way with the number left open (`GOFCNxxxxx_…`). Signs: such names; `creative plan` refusing with "要先登记"; `creative rows` finding nothing for them; the user calling them new ("新素材", "登记/建单后上传"). Then the task is the requirement flow with the files as its source, followed by the upload: one plan, one approval, run to the end. [gof-requirement](../gof-requirement/SKILL.md) gives the logins, commands, fields, execute and handover; read it and do as it says, except:

1. **Files:** `gof creative files <path> [<path> …]` lists what the files, folders and zips hold (zips unpacked into tmp; reads only): per file `file`, `name`, `kind`, and `name_without_number` for a name with the number open. Each file is one row, in the order listed. A file whose row is already in the sheet is only uploaded, never appended again.
2. **Rows:** `gof feishu snapshot`, `gof feishu context` (`naming`: `GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>`; the 创意形式 options). Materials are named `编号_一级标签_二级标签_[创意形式_]提炼词`; `creative files` reads each name into `parts`: `primary_tag`, `secondary_tag`, and `rest`, everything after them. Each file gives its row: the tags from `parts`; `rest` is the 提炼词, `_竖版` / `_横版` and version words included, unless it starts with a 创意形式: then that first part is `creative_form` and the rest after it the `keyword`. Judge that from the whole batch: a first part that is a 创意形式 option (`3D`, `2D`, `解说`…) or that the user calls one is; a first part several files share with different endings is the piece's name, not a form (`…_兵临城下塔防_冻鱼_竖版`, `…_兵临城下塔防_企鹅_竖版`: 提炼词 `兵临城下塔防_冻鱼_竖版`, `兵临城下塔防_企鹅_竖版`); when in doubt, it is 提炼词 (the name is the same either way). Some files with a 创意形式 and some without: leave it in the 提炼词 for all. The file's name goes into `material_name`, which the plan checks comes out exactly. `unclear` (fewer than three parts) is asked about, with the other open points. Values the dropdowns lack (tags, 创意形式) are taken as the file names them: the plan lists them in `new_options`, added after approval. Files named otherwise: judge each row as the requirement flow does (documents, scripts, delivery list) or ask. Each file is an item of `quantity` 1, in file order.
3. **Requirement fields:** 设计师供应商, 创意者脚本审核人, CLS 创意方向 and 任务类型 as the requirement flow finds them (message, this conversation, documents, the folder or zip name), else ask; only 设计师供应商 may stay empty (CLS `待定供应商`, also as the files' 制作人). 脚本内容 (`script_url`) must be a company Feishu document of this requirement (requirement, script or delivery doc); with none in the conversation, ask for it together with the other open points ("这批素材的需求/脚本文档链接发我一下，CLS 脚本内容要填"). `label`: the name the user or the files give the batch (`AI玩法优化`).
4. **Plan:** `gof feishu plan` and `gof cls --preview` as usual. `same_name_rows` lists rows already in the sheet under a file's name: that file was most likely registered before; leave it out of the append and upload it against that row, unless the user says it is a new piece. Show one plan: the requirement part as gof-requirement shows it (rows with 预计编号, each as `文件名 → GOFCN<预计编号>_…` when few, new dropdown options, supplier and reviewer, the CLS ticket), then the upload part (上传目录, 创意人/制作人 as CLS names, 素材类型, 创意标签不填, AdsDesk sync), ending with "确认后我就开始执行".
5. **Execute:** the requirement flow's execute, CLS and screenshot steps. If `prepare` says numbers or names changed (colleagues appended meanwhile), show the new numbers and wait. Then the upload with the same files: files named `GOFCNxxxxx_…` are found by name (no `items` needed), the others take `items[].number` from the appended rows; when the sheet's names are not CLS's, top-level `producers` / `creator` are the CLS names `gof cls --preview` matched (`cls_names`). `gof creative plan`: it needs no second approval when it puts up the approved files under the approved names with the approved people, directory and types; otherwise show what differs and wait. Then `gof creative run` and the creative-list screenshot (section 2).
6. **Handover:** in one reply, the requirement's (numbers, links, the progress and draft screenshots, the copyable group message and what is left for the user) and the upload's (section 2, step 4).
