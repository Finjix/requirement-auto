---
name: gof-creative-upload
description: "Upload GOFCN creative materials (素材上传 / 上传创意 / 传素材到 CLS) the user sends or names (videos, pictures, folders) to CLS 我的创意 > 创意列表 > 上传创意: one creative per file, 上传目录 默认 双端共用-视频, 创意人 = 创意者脚本审核人, 制作人 = 设计师供应商 (from the message, this conversation or the progress sheet row of the file's GOFCN number), 素材类型 by file kind, no 创意标签. Confirms one plan, uploads, saves, and hands back a screenshot of the creative list."
---

# GOFCN creative material upload

Talk to the user in their language (Chinese unless they write otherwise). CLS field names stay Chinese.

`gof` = `node <skill>/../../server/dist/gof.mjs` (`<skill>` = this skill's directory; Node.js 24+). Every command prints one JSON line; a refusal is `status: blocked` with the reason.

## Flow

1. **Plan:** check logins, collect the files, work out 上传目录 / 创意人 / 制作人 / 素材类型, ask only what is left, show one plan, wait for the go-ahead.
2. **Execute:** upload, save the annotation, read back, screenshot the creative list, hand over. Do not ask again unless the plan itself would change (files, names, people) or only the user can act (login scan).

The page's two steps are one command here: `gof creative run` puts the files up, creates the creatives (= 下一步) and saves 创意人/制作人/素材类型 (= 保存), then reads them back. It never creates twice; running it again on the same plan goes on from where it stopped.

## Talking to the user

Short and plain: what will be uploaded, what happened, what they must do. Leave out internals (IDs, hashes, batches, plan files) unless asked. When something stops: what is done, what is not, and the concrete reason with CLS's code (e.g. "HTTP 200，业务码 403，以下创意已存在: …").

## Local files

Requests and plans go to `<LARK_AGENT_USER_DIR>/requirement-auto/tmp` (zips are unpacked there too), never the working directory (lark-agent sends the user every new file there when a task ends). Only the screenshot and QR images go to the working directory. Never move, rename or edit the user's files.

## 0. Logins

`gof login check` at the start, after approval before the upload, and when a command reports a lost login. `ok`: go on. `login_required`: do what `todo` says, one login at a time, Feishu first: `gof feishu login start` (keep its link to yourself), `gof feishu authorize --qr feishu-login.png` in the working directory, tell the user to scan it with the Feishu app (it expires in minutes; the same scan logs in CLS); after their reply `gof feishu authorize`, `gof feishu login poll`, `gof login check`. If CLS alone is missing: `gof cls login --qr cls-login.png`, then `gof cls session` after the scan. `blocked`: relay the reason. `unknown`: Feishu is briefly unreachable; check again. Run `cls`/`creative` commands one at a time.

## 1. Work out the upload and plan

**Files:** what the user attached (the host lists them: "Files the user attached to this message … - <path>") and local files or folders they name. A folder is read one level deep; each file is one creative named like the file without its extension. **A zip is a folder:** Feishu cannot hand a dragged-in folder to the bot, so users send the folder zipped; give the zip's path in `files` and the plan unpacks it (the files at its top, or in the one folder it holds; deeper folders are listed as skipped). Accepted: mp4 mov avi m4v, jpg jpeg png gif webp bmp, html mp3 wav. The plan lists everything else with the reason (rar/7z, txt, mkv, nested folders…). If the user says they sent a folder and nothing arrived, ask them to zip it (right-click → 压缩) and send the zip; lark-agent takes up to 10 attachments per message, 2 GB each.

**Fields** (first source that answers wins):
- **上传目录:** `双端共用-视频` unless the user names another; `gof creative options --find <text>` finds a directory by name. A path ending (`常规素材/图片`) picks one of two with the same name.
- **创意人** (one person) is the requirement's 创意者脚本审核人; **制作人** (one or more) its 设计师供应商. Sources, in order: the user's message; this conversation (a requirement handled earlier in it names its reviewer and supplier, e.g. materials whose GOFCN numbers were appended there); the progress sheet row of each file's GOFCN number (`"progress": true` for the plugin's progress sheet, or the progress-sheet link the user gave); otherwise ask. Short names are fine (丁杰 → 北京柒曦文化传媒有限公司（丁杰）); for two people with the same name give the CLS user ID the plan error lists, or ask.
- **素材类型:** by the file: picture → 图片, video → 视频, anything else → 其他. Another type only when the user states it (`items[].type`, e.g. `AI生成`).
- **创意标签:** not filled.

Write `request.json` (paths absolute; `items` only for what differs per file):

```json
{
  "files": ["D:/…/workspace/input/GOFCN67471_成片.mp4", "D:/…/素材文件夹"],
  "directory": "双端共用-视频",
  "creator": "张天伟",
  "producers": ["丁杰"],
  "progress": true,
  "items": [{ "file": "封面.png", "type": "图片", "creator": "雷佳威", "producers": ["杨燃"], "name": "新名称", "directory": "常规素材/图片", "skip": false }]
}
```

`creator`/`producers` at the top apply to every file; with `"progress": true` files without them take their sheet row (reading the sheet takes about a minute). Then `gof creative plan --request <tmp>/request.json --output <tmp>/upload-plan-<time>.json`. It only reads: the files (hashed), what CLS offers, the progress sheet when asked, and whether a name already exists in CLS (CLS refuses a whole batch for one taken name). A refusal lists everything unsettled at once: fix what you can, ask the user the rest in one short message.

Show the plan in plain language, about 5-8 lines: how many files and of which kinds ("共 12 个：视频 10、图片 2"), 上传目录 (its path), 创意人 and 制作人 as CLS names, where they came from ("来自进度表 GOFCN67471 那一行" / "来自本次对话的需求" / "你指定的"), 素材类型, "创意标签不填", files that will not be uploaded and why, and that CLS syncs the materials to AdsDesk in that directory by itself. List the files when there are only a few. End with "确认后我就开始上传". A correction: plan again and show it again.

## 2. Execute

1. `gof login check`.
2. `gof creative run --plan <the approved plan>`. It checks the files are unchanged and that the people, directory and types are still on offer, then uploads, creates, annotates and reads back. Results:
   - `uploaded`: every file is a creative with its annotation (`uploaded[]`: name, type, 创意人, 制作人, `adsdesk` 同步中/已同步).
   - `partial`: some files did not become creatives (`not_created`, each with its reason: CLS already has the same file (MD5), or CLS refused) or an annotation is missing (`annotate_error`, `uploaded[].problems`). Report which.
   - `unknown`: a create's answer was lost and some creatives are not found yet (`missing`). Run the same command again a little later: it only looks, it never creates again. Still missing: tell the user which files, and that they can check the list.
   - `blocked`: relay `reason`. Before anything was created, a fixed request means a new plan (and approval); after a create, never make a second plan for the same files without asking.
3. `gof creative screenshot --output creatives-<time>.png --rows <number uploaded, max 12>` in the working directory: 我的创意 > 创意列表 of this account, newest first (the image goes to the user with the reply).
4. Hand over: how many went up (names when few), 上传目录, 创意人/制作人, 素材类型, AdsDesk sync state, what failed and why, the link `https://creative.centurygames.cn/creativities`, and the screenshot as an attachment only. Never add a text link to the screenshot (no "上传结果截图" link, no local path or URL for the image): the attachment already carries it and such a link does not open.
