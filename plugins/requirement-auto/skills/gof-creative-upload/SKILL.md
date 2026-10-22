---
name: gof-creative-upload
description: "Upload GOFCN creative materials (素材上传 / 上传创意 / 传素材到 CLS) the user sends or names (videos, pictures, folders, zips) to CLS 我的创意 > 创意列表 > 上传创意: one creative per file, named exactly as the 素材名称 of its row in the creative progress sheet (files named otherwise, e.g. 01.mp4 or g56890_a_v15.mp4, are matched to their row from the requirement / script / delivery documents and go up renamed), 上传目录 默认 双端共用-视频, 创意人 = 创意者脚本审核人, 制作人 = 设计师供应商 (from the message, this conversation or the file's row), 素材类型 by file kind, no 创意标签. Confirms one plan, uploads, saves, and hands back a screenshot of the creative list."
---

# GOFCN creative material upload

Talk to the user in their language (Chinese unless they write otherwise). CLS field names stay Chinese.

`gof` = `node <skill>/../../server/dist/gof.mjs` (`<skill>` = this skill's directory; Node.js 24+). Every command prints one JSON line; a refusal is `status: blocked` with the reason.

## Flow

1. **Plan:** check logins, collect the files, work out which progress-sheet row each file is (its name), 上传目录 / 创意人 / 制作人 / 素材类型, ask only what is left, show one plan, wait for the go-ahead.
2. **Execute:** upload, save the annotation, read back, screenshot the creative list, hand over. Do not ask again unless the plan itself would change (files, names, people) or only the user can act (login scan).

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
- Only a file already named exactly as its 素材名称 needs nothing. Every other file needs `items[].number`, also one whose name carries a GOFCN number (`GOFCN67680_成片.mp4`): that number can be the original the piece builds on (the 终稿库 heading `GOFCN56890 企鹅保龄球 V15` is a new piece made from GOFCN56890), so check it against the requirement and write the number even when it is the one in the name. The plan refuses to place such a file by its name, and refuses a row whose creative CLS already has.
- Otherwise judge from what you have: rows appended earlier in this conversation (numbers, names, the requirement link), and the documents the user sends or names, or that the requirement used: requirement sheet or doc, script content, a delivery list that names each file under its heading (终稿库). Read them with `gof feishu document --url <link>` (`--full` for whole scripts). Compare each file's name, order, version, duration, size and kind with each row's 提炼词, tags, script and place in the requirement.
- Candidate rows: `gof creative rows --numbers 67680-67683` (numbers from this conversation, from the user, or the CLS requirement name `GOFCN67680-GOFCN67683`) or `--find 企鹅保龄球,冻鱼飞盘` (text in 素材名称 or 提炼词, newest first); `--progress <link>` for another sheet. It only reads (about a minute).
- Rows named alike but for the number (`…_3D_围炉煮冰` twice, e.g. a piece and its 国风配乐 version) are taken in the order the requirement lists them; say so in the plan.
- Write each decision as `items[].number`, one file per row. `items[].file` is the file name; for files of the same name in two zips, `<zip name>：<file name>` as the plan lists them (`供应商B.zip：01.mp4`). Ask the user only about the files you cannot place with confidence (one message, with their candidate rows).
- Rows the sheet cannot name, as the plan says: a number on rows of several tabs that say different things takes the tab in `items[].sheet` (the tab `rows` shows under `where`); a row whose 素材名称 is empty, cannot be worked out or contains / or \ needs the user: they fix the sheet, or confirm a name you then give in `items[].name` (only such a row takes one).
- Only for materials the user says are on no progress sheet: `"progress": false`; the files keep their names (or `items[].name`), and the plan says so.

**Fields** (first source that answers wins):
- **上传目录:** `双端共用-视频` unless the user names another; `gof creative options --find <text>` finds a directory by name. A path ending (`常规素材/图片`) picks one of two with the same name.
- **创意人** (one person) is the requirement's 创意者脚本审核人; **制作人** (one or more) its 设计师供应商. Sources, in order: the user's message; this conversation (a requirement handled earlier in it names its reviewer and supplier); the file's row in the progress sheet; otherwise ask. Short names are fine (丁杰 → 北京柒曦文化传媒有限公司（丁杰）); for two people with the same name give the CLS user ID the plan error lists, or ask. The sheet's names are not always CLS's (its 廿十一 is 长沙廿拾一文化传媒有限公司 in CLS): when the plan refuses one, give the CLS name in that file's `items[].producers` / `items[].creator` (the requirement's CLS supplier, or the clearly same name `gof creative options` lists). Top-level `producers` / `creator` only when they hold for every file: they replace every file's people from its own row.
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

`creator`/`producers` at the top apply to every file; files without them take their row's. Then `gof creative plan --request <tmp>/request.json --output <tmp>/upload-plan-<time>.json`. It only reads: the files (hashed), what CLS offers, the progress sheet (about a minute), and whether a name already exists in CLS (CLS refuses a whole batch for one taken name). A refusal lists everything unsettled at once: fix what you can (a file without a row: work out its `items[].number`), ask the user the rest in one short message. The result says how many files go up `renamed`, and per file its `name`, `renamed`, `progress_row` and `row_from` (`request`: your `items[].number`; `file_name`: the number in its name).

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
