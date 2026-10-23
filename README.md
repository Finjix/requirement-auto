# requirement-auto

GOFCN 素材需求自动化的 **Codex 插件**（可被 ChatGPT/Codex 桌面版或 lark-agent 加载），两个技能各管一件事，各自只确认一次计划：

- **发布需求**（`gof-requirement`）：用户给来需求文档 → 通过飞书 SDK 防覆盖追加创意进度表并验收 → 生成 CSV，保存 CLS 未发布需求草稿、导入脚本 → 回传创意进度表和 CLS 草稿的截图，生成可复制群消息。CLS 需求单是把素材制作需求发给供应商。
- **上传素材**（`gof-creative-upload`）：用户给来做好的素材 → 给还没登记的文件追加创意进度表的行并验收（文件已按进度表规则命名、编号待定时，如 `GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版.mp4`，行照文件名整理；已在表里的不重复登记）→ 按每个文件那一行的素材名称，按 CLS「上传创意」页面的规则上传到创意列表 → 回传进度表和创意列表截图。素材已经做好，**不建 CLS 需求单**，没有 CSV 和群消息。

飞书用户登录用设备授权，登录信息按用户隔离存放。

## 目录

```
.agents/plugins/marketplace.json     本仓库就是一个 marketplace（名字 requirement-auto）
plugins/requirement-auto/            插件本体，安装和打包的就是这个目录
  plugin.json                        可移植插件清单（Agent Plugins 1.0.0）
  server/dist/                       桥和技能命令行 gof.mjs 的打包产物（提交入库，装好即用）
  skills/gof-requirement/            技能：发布需求（SKILL.md、两个技能共用的 references/、assets/CSV 模板和防覆盖回执）
  skills/gof-creative-upload/        技能：上传素材，登记进度表后上传到 CLS 创意列表（SKILL.md）
dev/                                 开发专用，不进入发布包
  feishu-sdk/                        桥和 gof 命令行的 TypeScript 源码（src/gof/ 是业务逻辑）、esbuild 脚本、测试和 XLSX 夹具
  package_plugin.mjs                 插件结构检查和打包
docs/lark-agent-integration.md       放进 lark-agent：怎么放、两边的约定、验证过什么
```

## 它怎么工作

- **飞书全部走 SDK**：不再有 lark-cli。`server/dist/bridge.mjs`（基于 `@larksuiteoapi/node-sdk`）只暴露白名单操作：读取 Wiki/文档/表格规则、导出完整 XLSX、防覆盖写入（`allow_overwrite:false`，服务端拒绝非空目标）。`gof.mjs feishu` 负责"校验 → 写 → 回读 → 验收"的编排，在同一进程里调用桥访问飞书；`gof.mjs batch` 离线规划追加行、校验快照、生成 CSV 和群消息，`gof.mjs cls` 构造 CLS 操作、校验回执，并负责 CLS 的登录和接口请求（见下一条）。XLSX 由 `src/gof/xlsx.ts` 里自带的只读解析器读取（zip + XML），不依赖其他库或运行时。
- **共享进度表上的验收**：接口追加只发送自己的范围，所以写后验收只对追加的行（所有列）和写入列的下拉规则严格；追加期间同事在工作簿别处的改动（其他单元格、其他页签、筛选、行列尺寸、别的列的下拉）列在 `foreign_changes` 里，不再让已写入的批次卡在 `conflict`。写入发出后的任何拒绝都带 `write_sent: true`，只能 `reconcile`；`prepare` 会拒绝为一个已有"写入发出、未核对、且行已在表里"批次的需求再建批次，防止重复追加。同一份计划再次 `prepare`（例如写入没有落地）另起 `<plan_id>-2` 目录，原批次记录保留。
- **从需求链接自动整理需求，少问用户**：用户只需给飞书需求链接（表格的某一页，或文档；可以一次给多份，一份文档是一组：一张 CLS 单，行号在同一次追加里按链接顺序连续，最后只出一条群消息）。`gof.mjs feishu document` 把它读成文字（表格：标题、表头和每行需求；文档：全文），`gof.mjs feishu context` 给出目标进度表现在的下拉选项、该供应商最近几批行是怎么填的、本人以前的批次（含审核人和 CLS 方向、任务类型）。技能据此推断条数、一二级标签、提炼词（没写明就填“关键词”）、供应商、审核人、CLS 方向和任务类型，推不出的才问，最后给一份计划请用户确认。一二级标签先用文档写明的；没写明就读每行的脚本内容，从现有下拉选项里挑最贴切的。创意形式（制作形式）是选填：只填文档或用户写明的，不猜。设计师供应商要写明：文档和用户的话里都没有就问；只有用户说供应商还没定时，进度表那格才留空，CLS 供应商选 `待定供应商`，群消息写“供应商：待定供应商”（一批里要么每份需求都有供应商、要么都没有，因为接口一次写一整列）。同一文档里不同类型的行（如 设定3.0 / 设定2.0）用 `items` 按原顺序写进同一张 CLS 单；素材名称由命名公式算出，不再手写（`context` 和 `plan` 用表头的话给出 `naming`）。下拉里没有的值列在计划的 `new_options`，批准后用 `dropdown-add` 加进整列（一级、二级标签要文档写明才加；创意形式、设计师供应商、创意者脚本审核人没有就直接加；供应商列是多选，保持多选）。进度表和 CLS 的叫法不同（冯彦蓉 / 冯彦蓉-实习生，丁杰 / 北京柒曦文化传媒有限公司（丁杰）），程序按唯一包含关系自动对上，对不上的由请求写明 `cls.supplier` / `cls.creator`。批准后表格版本变了（加下拉、别人改了别处）不再要求重新批准，只要新增行、编号和名称不变。
- **素材名称是 `GOFCN<编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>`**：进度表一贯的公式是 `=CONCATENATE("GOFCN",C,"_",H,"_",I,"_",K,"_",D,L)`。正式表从第 23282 行（2026-10-22）起的行用了不含创意形式和客户端的 `=CONCATENATE("GOFCN",C,"_",H,"_",I,"_",D)`，那是改错了，插件不跟。新行的公式：上一行的公式能按这个顺序命名时沿用它（同事的写法照留，比如末尾的客户端 L，插件不填它）；不能（如 23282 起那种）时插件自己写 `=SUBSTITUTE(CONCATENATE("GOFCN",C,"_",H,"_",I,"_",K,"_",D),"__","_")`。创意形式可以不填，`SUBSTITUTE` 把它留下的 `__` 合成一个 `_`（沿用的公式没套 SUBSTITUTE 时给它套上）；一批要么都填、要么都不填（接口一次写一整列），只有部分行写明时都不填、把它放在提炼词前面，名称一样。一二级标签和创意形式不能含 `_`，提炼词可以含 `_` 但不能在开头、结尾或连续出现（名称按 `_` 分段，否则一个名称有两种读法）。请求可以给某一行“必须叫什么”（`material_name`，前面的 `GOFCN<数字>_` 或 `GOFCNxxxxx_` 会去掉），算出的名称不同就拒绝并说出这一行会叫什么。
- **为做好的素材登记进度表（上传素材技能，不建单）**：请求里不写 `script_url` 和 `cls`，这一组就只追加进度表的行：没有 CSV，`gof cls` 拒绝为它建单，计划摘要不显示需求名称和群消息里的写法，`batch message` 没有内容；`prepare` 的“写入发出、未核对”防重按这些行去掉编号后的名称判断（有脚本链接的需求仍按链接）。建单的需求仍然必须有脚本链接。人名先用 `gof creative options --creator <审核人> --producers <供应商>` 对上 CLS 的叫法（`people`：每个名字对上的 CLS 名字或问题），因为这时还没有行，做不了上传计划。`gof creative files <路径…>` 列出文件、文件夹和 zip 里的文件（zip 解压到 tmp，只读），编号待定的名称给出 `name_without_number` 和 `parts`。素材按 `编号_一级标签_二级标签_[创意形式_]提炼词` 命名，`parts` 给出一级、二级和其后的 `rest`（不足三段标 `unclear`）。每个文件一行：标签取自 `parts`；`rest` 就是提炼词（`_竖版`/`_横版`、版本都算在里面），只有它第一段明显是创意形式（下拉里的 `3D`、`2D`、`解说`…，或用户说是）时才拆出来写进创意形式；同一条素材的几个版本共用的第一段是素材名，不是创意形式（`…_兵临城下塔防_冻鱼_竖版` / `…_兵临城下塔防_企鹅_竖版` 的提炼词是 `兵临城下塔防_冻鱼_竖版` / `兵临城下塔防_企鹅_竖版`）。拿不准就当提炼词，名称一样。文件名写进 `material_name`，计划核对算出的名称和文件名一致；下拉里没有的标签列在 `new_options`，批准后加。`gof feishu plan` 的 `same_name_rows` 列出表里已经有同名行的文件（多半已经登记过，不再追加）。追加之后，上传计划会自己按名称找到这些行（见下面“上传素材”）。真实表上的演练（只读，2026-10-22 20:31 的快照）：`D:\玩法AI迭代素材` 的 5 个文件得到 GOFCN67738–67742 五行，名称就是文件名换上编号，新增一级 `AI玩法优化`、二级 `搂冰块抢资源`/`火车运输御敌`/`转斧杀熊烤肉`。2026-10-23 按新规则在 10-23 的快照上重新离线规划：上一行（23339）是不含创意形式的公式，插件改写自己的公式；`兵临城下塔防_冻鱼_竖版`、`兵临城下塔防_企鹅_竖版`、`割资源冰块对抗_竖版` 都是提炼词，创意形式和供应商留空，名称和文件名一致。
- **登录用设备授权**：`gof.mjs feishu login start` 返回授权链接和验证码，用户确认后 `gof.mjs feishu login poll` 保存登录（`login status` 只读本地记录，`login logout` 退出）。刷新令牌一次性有效，续期在文件锁内进行。宿主声明了用户的 Open ID 时，授权账号不是该用户会被拒绝。
- **按用户隔离**：宿主给每个 Codex 进程设 `LARK_AGENT_USER_DIR=<user/用户名>`，该用户的飞书登录和批次都在 `<用户目录>/requirement-auto/{feishu,batches,cls,tmp}`；其中 `batches` 和 `tmp` 里 7 天没动过的内容会在每次运行 `gof` 时自动删除，登录数据不动。工具和脚本都不接受用户标识参数，令牌不出现在任何输出里。
  **边界**：lark-agent 的 Codex 是 `danger-full-access`，仍是同一个 Windows 账号。这是防串号和误操作的逻辑隔离，防不住被提示词注入后主动去读别人目录的模型。
- **CLS：浏览器只负责登录，建单和导入走 HTTP**：CLS 在公司 SSO 后面，没有设备授权或回调，登录只能在网页上完成，而公司 SSO 就是飞书网页扫码授权。`gof.mjs cls login --qr` 用本机已装的 Chrome 或 Edge（`src/gof/chromium.ts`，自带的最小 DevTools 客户端，不下载、不依赖 npm 包、不依赖 Codex 的内置浏览器或电脑控制）以**无头模式**打开 CLS，用户用手机扫码；命令只从页面自己的 API 请求里读出 Authorization，用 `/api/userinfo` 确认有效，然后关闭浏览器。之后的选项读取、建草稿、导入 CSV、回读都是 Node 发出的 HTTP 请求（`src/gof/cls-adapter.ts`，路径白名单，没有发布/删除能力），令牌只在命令进程内存里。浏览器资料在用户自己目录的 `cls/browser-profile`，各用户互不相通；登录还有效时后续命令静默取得会话，不再需要扫码。SSO 留下的是会话级 Cookie，所以浏览器按“继续上次浏览”（`--restore-last-session`）启动才保得住登录；等待扫码的浏览器以 `detached` 启动，命令返回后仍在，下一次命令接上（否则 Windows 上子进程随命令进程一起结束）。整个流程没有任何浏览器窗口。
- **CLS 二维码登录（不需要有人在电脑前）**：`gof.mjs cls login --qr cls-login.png` 让无头浏览器停在飞书扫码页，把页面截图写成 PNG（lark-agent 的工作目录就是交付目录，图片随回复自动发给用户），浏览器留在后台等扫码；用户用飞书手机端扫码后，浏览器会停在飞书对 CLS 应用 `dsc_admin` 的授权页（需要点【授权】），`gof.mjs cls session` 接上那个浏览器，**自动点【授权】**、取得登录并正常关闭它。自动点的范围很窄：页面上写明的应用必须是 `dsc_admin`，已绑定账号时页面上的账号必须是绑定的那个，只点【授权】、绝不点【拒绝】，一次登录只点一次，其余情形不点并报告原因。15 分钟没人扫码，下一个命令会清理等待的浏览器和图片。二维码谁扫谁登录，所以只发给本人；账号绑定会拦住之后换号。
- **每个任务都检查登录，不只是第一次**：`gof.mjs login check` 真实地检查飞书和 CLS，**先飞书后 CLS、一次只向用户要一个登录**：飞书没登录时只返回飞书的 `todo`，CLS 记为 `not_checked`（不启动浏览器），飞书登录好后下一次检查才轮到 CLS 二维码。飞书登录也在这个无头浏览器里完成：`gof.mjs feishu authorize --qr` 在浏览器里打开设备授权链接，浏览器没有飞书网页登录态时停在飞书扫码页并把二维码交给用户，扫码后 `gof.mjs feishu authorize` 自动点飞书授权页的【授权】，再 `gof.mjs feishu login poll` 收登录；因为浏览器资料目录与 CLS 共用，这一次扫码同时让 CLS 的单点登录通过，CLS 不再要第二次扫码（真实环境实测：扫码一次，`login check` 4 秒内两边都 ok）。飞书是向飞书服务器验证（只看本地过期时间会漏掉用户在飞书里撤销授权的情况；令牌过期会自动续一次，也把闲置的登录续期，刷新令牌 7 天不用就失效），CLS 是在无头浏览器里取一次真实会话。返回 `ok`、`login_required`（带 `todo`，说明该让用户做什么）、`blocked`（账号不一致、授权页不对等，重新登录解决不了）或 `unknown`（暂时连不上飞书，不说明登录失效）；只读，退出码非 0 表示有问题。技能规定每个任务开始、用户批准计划之后第一次写入之前、进入 CLS 阶段之前、任何命令报登录失效时、中断恢复时都要运行它。
- **多用户共用一台电脑的保护**（`src/gof/cls-guard.ts`）：第一次登录的 CLS 账号按用户记在 `cls/account.json`，之后换了账号就拒绝。宿主给了 `LARK_AGENT_USER_OPEN_ID` 却没有 `LARK_AGENT_USER_DIR` 时，所有命令直接拒绝，不回落到共用目录。同一用户的浏览器同一时间只由一个命令使用（`src/gof/chromium.ts` 的资料目录锁，第二个命令最多等 2 分钟）；浏览器还在运行但一时连不上时不会被当成已退出，也就不会删掉它的端口文件、再起一个。素材解压出的每个 zip（`tmp/unpacked/<编号>`）各自按 7 天清理。
- **没有 MCP 服务**：登录和业务都是 `gof.mjs` 命令，由 Codex 的 shell 工具运行，直接继承宿主给 Codex 进程的环境变量（用户目录、Open ID、应用凭证）。插件声明的 MCP 进程拿不到这些变量（Codex 0.163.0 实测），曾需要宿主每轮另行注册，所以去掉了。

## 发布需求的两张截图（gof-requirement）

流程最后（`batch report` 之后）技能把两张图随回复发给用户：**创意进度表**（追加的那几行）和每组的 **CLS 需求草稿**。上传素材技能也发进度表这张（追加了行时），另一张是创意列表。和创意列表截图一样，都是在该用户自己的无头浏览器里“看一眼再拍”：不点击、不输入，飞书和 CLS 里不改任何东西；`.png` 文件已存在不覆盖。

- `gof feishu screenshot --batch <批次> --output x.png`：要求这一批已 `append_verified`；打开 `?sheet=<页签>`，带上这一批追加的行范围（`range`），等页面不再有请求、画布画完再截 2000×1100 的图。飞书网页登录态来自同一个浏览器资料（扫一次飞书码，CLS 和飞书网页都登录）；页面停在登录页（`accounts.*`、`/accounts/`、`/login`）就拒绝并说明，不出图。
- `gof cls screenshot --batch <批次> [--group <组>] --output x.png`：草稿 ID 取批次记录里的 `scripts_imported`（没有则 `draft_saved`），整批只有一个草稿时可省 `--group`；在应用里按页面自己的路由进入 `/requirement/<id>/edit-outer`（直接整页打开可能在权限加载前被挡），等加载标记消失、图片画完，按页面高度（上限 2600）截图；被应用转去别的页面（无权限）就拒绝，不出图。
- 技能要求发出前自己看一遍图：登录页、无权限页、空表或看不到新编号的图不发，只说明缺哪张及原因，链接照给。

实现：`src/gof/shot-page.ts`（共用的无头页面、窗口、网络静止、PNG 写入；创意列表截图也改用它）、`sheet-shot.ts`、`draft-shot.ts`、`shots-online.ts`（从批次记录取行范围和草稿 ID）；测试 `test/shots.test.ts` 用本地假页面验证流程。

## 上传素材（gof-creative-upload）

用户发来或指定一批做好的素材（视频、图片、文件夹、zip），技能先**填进度表**：还没有行的文件每个追加一行并验收（行从文件名整理，文件名看不出来的按用户的话和需求、脚本、交付文档判断，推不出的才问；已在表里的文件不重复登记）；再按 CLS **我的创意 > 创意列表 > 上传创意** 的规则上传：一个文件一个创意，名称是这个文件在**创意进度表里那一行的素材名称**（见下面“名称”）；上传目录默认 `双端共用-视频`；创意人取**创意者脚本审核人**、制作人取**设计师供应商**（依次来自用户的话、本次对话、文档和文件夹/压缩包名，都没有才问；素材已经做好，供应商必须写明，不用 `待定供应商`，请求里没有供应商就拒绝，已有的行供应商为空时上传计划也拒绝并提示问用户）；素材类型按文件判断（图片 → 图片，视频 → 视频，其余 → 其他）；创意标签不填。**不建 CLS 需求单**：需求单是请供应商做素材，这里素材已经做好。先给一份计划请用户确认，确认后追加进度表、上传、保存标注、回读核对，最后返回进度表和创意列表截图。

- **走页面自己的 HTTP 接口，不用开放 API**：前端源码（webpack 带源码的包）里“上传创意”页的调用依次是 `GET /api/game/adsdesk/dirs`（上传目录树）、`/api/game/recommend-filters`（创意人、制作人候选）、`/api/material/filters?fields=types`（素材类型）→ `POST /api/qcloud/signed-url`（每个文件一个腾讯云 COS 预签名 PUT 链接，只签 host，约 61 分钟有效）→ 直接 `PUT` 到 COS（不带 CLS 凭证）→ `POST /api/creative/multiple-upload?confirmed=1`（= 页面的【下一步】，按名称建创意并指定上传目录）→ `POST /api/creative/multiple-edit`（= 【保存】：`sponsor` 创意人、`producers` 制作人、`types` 素材类型、`custom_tags` 留空）。全部用 CLS 登录取得的 `Authorization: Bearer`，Node 直接调用已实测可用（2026-10-21）。飞书知识库里的《CLS OPEN_API》要 `X-Api-Key`、必须给 `primary_tag`、没有上传目录和素材类型，不符合这里的需求，没有使用。
- **实测到的规则**：签名阶段只要有一个名称在 CLS 已存在，整批被拒（HTTP 200、业务码 403、`以下创意已存在: …`），所以计划阶段先按名称查重；CLS 只给 mp4/mov/avi/m4v、jpg/jpeg/png/gif/webp/bmp、html、mp3/wav 签链接（mkv、webm、flv、wmv、tif、heic、psd、pdf、txt 等没有）；压缩包按页面说明不能直接上传（插件先解压 zip，再按里面的文件上传）；建创意时 MD5 相同的文件会被拒（`fail`）。指定了上传目录的创意会由 CLS 自动同步到 AdsDesk 的该目录（实测已有创意约 2 分钟后同步）。
- **名称：每个文件对上进度表的一行**：供应商交回的文件很少按素材名称命名（`01.mp4`、`g56890_a_v15.mp4`），所以计划先给每个文件定行：请求里写了 `items[].number`（技能根据本次对话追加的行、需求文档、脚本内容、交付清单判断）就用它；没写的只有文件名已经和那一行的素材名称一致时才按文件名里的 GOFCN 编号定行。文件名是编号待定的素材名称（`GOFCNxxxxx_<其余>`，x、X、* 都算）时，按“素材名称去掉编号后等于 `<其余>`”找那一行（`row_from: name`），上传时补上编号；还没有这一行就拒绝并提示先登记（追加进度表的行，不建单），有两行同名就要用 `items[].number` 指定。两个压缩包里同名的文件用 `<压缩包名>：<文件名>` 区分。同一编号在几个分表各有一行、内容一样的算一行，内容不同用 `items[].sheet` 指定分表；那一行的素材名称为空、算不出来或含 /  时，请用户补正进度表或确认一个名称写在 `items[].name`（只有这种行可以）。这些情况都一次列出来（每类最多列 30 个文件）。名称从表里取，不由技能手写；文件名不一致就改名上传：创意名称和上传到 COS 的文件名（`<素材名称>/<素材名称>.mp4`）都换成素材名称，用户的文件本身不动。文件名带 GOFCN 编号但和那一行的素材名称不一致时（多半是参考的初版编号，比如终稿库标题 `GOFCN56890 企鹅保龄球 V15` 的 56890 是它依据的原片），计划不按这个编号定行，拒绝并提示用 `items[].number` 写明，不管 CLS 里有没有那一行的创意。进度表的供应商名对不上 CLS 时，提示在那个文件的 `items[].producers` 写明 CLS 的名字（写在顶层会改掉同批其他文件取自各自那一行的制作人）。名称完全依赖进度表，所以 `progress` 默认就读插件的进度表；只有用户说明不在任何进度表上的素材才用 `"progress": false`（保留文件名或 `items[].name`）。
- **命令**：`gof creative files <路径…>`（只读：列出要上传的文件，zip 先解压）、`gof creative options [--find 目录名] [--creator 审核人] [--producers 供应商,…]`（人名按上传计划的规则对上 CLS 的叫法，放在 `people`）、`gof creative rows [--numbers 67680-67683] [--find 企鹅保龄球,冻鱼飞盘] [--progress 链接]`（只读：按编号或素材名称/提炼词里的文字列出进度表的行，给技能判断文件是哪一行用）、`gof creative plan --request … --output …`（只读：哈希文件、读 CLS 选项、读进度表、名称查重，写出加封的计划）、`gof creative run --plan …`（执行；再次运行同一计划会接着做）、`gof creative status --plan …`、`gof creative screenshot --output x.png [--rows N]`。
- **安全边界**（`src/gof/creative-adapter.ts`，和需求流程的 CLS 客户端分开，后者仍然不能上传）：路径白名单，只有读选项、签名、PUT 到本次签出的 COS 链接、建创意、保存标注和页面同样的上传日志；没有删除、发布、确认、改标签。建创意每批只发一次（发出前独占创建标记文件），结果未知就按名称回读查找，永不重发；标注只是赋值，只在回读显示没生效时补发，最多 3 次。签名链接只在进程内存里，不写盘不打印。计划加封，执行前核对文件哈希、账号、目录、人员和类型仍然有效。
- **截图**：在该用户自己的无头 CLS 浏览器里打开应用，用应用自己的路由进入创意列表（直接整页打开 `/creativities` 会在权限加载前被挡到“无权限”页），列表筛选设为“上传人 = 当前账号、按更新时间倒序”（写在该浏览器资料的本地存储里），等行和缩略图画完再截 2000px 宽的图；不点击、不输入，CLS 里不改任何东西。
- **进度表查找**：默认（`"progress": true`）读插件的进度表（两个技能追加行的那个节点），或给用户提供的进度表链接（只读导出，约 40 秒）。飞书导出不带公式的计算结果，素材名称由插件按公式算出：`CONCATENATE`/`CONCAT`（含空参数、引用别的行），外面可以套 `SUBSTITUTE(…,"__","_")`（正式表 G23218:G23253 就是这样写的）；在正式表上实测（2026-10-22）61142 个有编号的行只有 282 行素材名称为空、3 行是坏公式（`A1:0`），纯 CONCATENATE 的 60365 行和需求流程的算法结果完全一致。进度表的叫法不一定是 CLS 的（进度表写 廿十一，CLS 是 长沙廿拾一文化传媒有限公司），对不上时拒绝并提示在 `producers`/`creator` 写明 CLS 的名字。

## 安装与使用

需要 Node.js 24+，别无其他依赖（包约 3 MB）。

```bash
codex plugin marketplace add <本仓库路径>
codex plugin add requirement-auto@requirement-auto
```

- **单机用 Codex 桌面版**：没有 `LARK_AGENT_USER_DIR` 时，登录和批次存在 `PLUGIN_DATA`（环境里有的话），否则 `~/.requirement-auto/default`；应用凭证写进该目录的 `app.json`（`{"appId":"…","appSecret":"…"}`，面向该应用的管理员，注意文件权限）。
- **lark-agent（拖入即用）**：把 `plugins/requirement-auto` 复制到 lark-agent 的 `plugins/` 下，重启 lark-agent，不需要任何配置。lark-agent 启动时自动安装，并按用户每轮注入用户目录和飞书应用。步骤和约定见 [docs/lark-agent-integration.md](docs/lark-agent-integration.md)。
- 改了插件后要让已装副本生效：`codex plugin remove requirement-auto@requirement-auto` 再 `add`（或提升 `plugin.json` 的 version）。

### Codex 0.163.0 的实测结论

- 插件声明的 MCP 进程只拿到 PATH、`PLUGIN_ROOT`、`PLUGIN_DATA` 和静态 `env`；宿主环境变量不会传进去，`${VAR}` 也不展开（只展开 `${PLUGIN_ROOT}`），`mcp.json` 多写键（比如 `env_vars`）整个服务会被静默丢弃。这是插件不再带 MCP 服务的原因；以后如果要加回来，按用户传目录得由宿主在配置里注册同名服务。
- 技能在 Codex 里的名字带命名空间：`requirement-auto:gof-requirement`（发布需求）、`requirement-auto:gof-creative-upload`（上传素材）。

## 开发与测试

```bash
cd dev/feishu-sdk && npm install        # 一次
npm test                                # 类型检查 → 打包到 plugins/.../server/dist → node:test
```

`npm test` 已经包含插件结构检查（`node dev/package_plugin.mjs --check`）。

发布：`node dev/package_plugin.mjs --output dev/dist/requirement-auto.zip`（先校验结构，再打包并生成 SHA-256）。直接复制 `plugins/requirement-auto` 目录也可以；不要带上 `.state`、批次、`auth.json`、`app.json`。

新增开发工具和测试放进 `dev/`；插件运行需要的脚本和资源放在 `plugins/requirement-auto/`。业务逻辑改在 `dev/feishu-sdk/src/gof/`，`npm test` 会重新打包进 `server/dist`，记得把产物一起提交。

`dev/feishu-sdk/test/fixtures/` 里的 XLSX 夹具和 `golden.json` 是移植前由 Python 版实现（用 openpyxl）生成并记录的"标准答案"（生成脚本在 git 历史里，提交 `test: capture the Python implementation's answers`）。测试比对行范围、编号、名称、CSV 文本、验收结论和拒绝原因，不比对摘要。

## 还没做、需要你来验证的事

离线测试（mock 飞书服务）不能代替真实验收，以下都需要真实飞书应用和你的授权，我没有运行：

1. 飞书应用后台：给应用的**用户身份**开通 `wiki:wiki:readonly sheets:spreadsheet:readonly sheets:spreadsheet:read sheets:spreadsheet:write_only sheets:spreadsheet drive:export:readonly docx:document:readonly offline_access`（隔离探测另需 `sheets:spreadsheet:create`），发布版本。
2. 真实设备授权登录：`gof.mjs feishu login start` → 浏览器确认 → `gof.mjs feishu login poll`。`oauth/v1/device_authorization` 和 `sheet_ai/.../invoke_write` 没有公开文档，只有官方 lark-cli 在用，协议来自它的开源代码和 `--dry-run` 抓取。
3. **在隔离表上重做防覆盖探测**：`gof.mjs feishu login start --probe-scope` → `gof.mjs feishu probe`。旧的 lark-cli 时代记录全部作废。探测时记下服务端"非空拒写"的真实错误码和文案，补进 `dev/feishu-sdk/src/api.ts` 的 `OCCUPIED` 判断。
4. **CLS 写入**：从二维码到登录的整条路已在真实 CLS 上验证（2026-10-20，本机 Edge，无头）：生成二维码并发给用户 → 用户用飞书手机端扫码 → 浏览器停在 `dsc_admin` 授权页 → `cls session` 自动点【授权】并取到登录（3 秒）→ 之后连续的静默检查成功，二维码图片和等待的浏览器都已清理；令牌只带 Authorization 头就被 `/api/userinfo` 和 `cls catalog` 接受，另一个用户目录仍是未登录。还没做的是写入：用独立的测试草稿走一遍 `cls observe → run`。
5. 在测试进度表上走一遍全流程。
6. **从需求链接自动整理**：读需求文档和 `context` 已在真实的四份示例文档和测试进度表上只读跑过（行数 15/14/7 正确，供应商历史、下拉选项、以前的批次都读得出来）；CLS 名称匹配用真实目录验证过（丁杰、杨燃、冯彦蓉都能对上）。还没在真实表格上做过的写入：给创意形式、供应商（多选列）、审核人列 `dropdown-add`，以及一次含多种行（`items`）的完整追加和建单。
7. **素材上传**：已在真实 CLS 上只读验证（2026-10-21）：`creative options`（GOFCN、上传权限、默认目录 `双端共用-视频` id 1585089、72 个创意人、144 个制作人、11 种素材类型）、`creative plan`（含进度表查找：GOFCN66367 → 26年1月-GOFCN 第 9960 行，创意人 张天伟、制作人 谢振文）、签名接口（只申请链接、没有上传）、`creative screenshot`（与页面一致）。真实写入已在 lark-agent 里走通一次（2026-10-22，`00.zip` 的 3 个文件：签名、PUT 到 COS、`multiple-upload` 建创意、`multiple-edit` 保存标注、回读核对都成功）；但那一批的创意名称就是文件名 `01`/`02`/`03`，这是改成按进度表素材名称命名的原因。**按素材名称改名上传还没在真实 CLS 上做过**（只在本地假 CLS 上验证）：签名时 key 里的文件名和本地文件不同（`<素材名称>/<素材名称>.mp4`），按页面的做法 CLS 只按名称签名、按 key 存对象，应当接受，要用一批认可的素材实测一次。真实上传会在 GOFCN 创意列表里新建创意并自动同步到 AdsDesk；能不能删掉不确定（账号角色 `creative_plan` 没有 `creative.delete`，GOFCN 分组角色 `creative_plan_junior` 有），AdsDesk 里已同步的副本会不会跟着删也不清楚，所以要先经你同意、用你认可的素材做。

8. **上传素材（先登记进度表再上传）**：只在真实快照上离线规划过（见上面“为做好的素材登记进度表”），本地测试覆盖了不带脚本链接的行（没有 CSV、不能建单、防重复追加）、按名称找行、同名行提示和端到端上传；**没有在真实飞书和 CLS 上写过**。要确认：(a) 新的一级标签 `AI玩法优化` 和三个二级标签是不是业务上想要的（按约定照文件名加进下拉）；(b) 一次真实的“文件 → 追加 → 上传”，用你认可的素材做；(c) `gof creative options --creator/--producers` 在真实 CLS 上对人名的结果。
9. **发布需求的两张截图**：只在本地假页面上验证过（登录页拒绝、无权限拒绝、不覆盖、行范围带进链接），**没有在真实飞书和真实 CLS 上跑过**。两点需要真实环境确认：(a) 进度表链接里的 `range=<A1 范围的 base64>` 是否真的把视图定位到追加的行（飞书“复制选区链接”的写法，官方文档没有写明；不认的话表会停在顶部，图里看不到新编号，技能规定这种图不发）；(b) 草稿页 `/requirement/<id>/edit-outer` 经 `$router.push` 进入后的加载标记和高度（页面实际用的接口名未核对，等不到就靠加载标记和文字判断）。

## 已知限制

- CLS 登录靠用户在自己的手机上扫码，不需要有人在运行机器人的电脑前，也不需要桌面；这台电脑要装 Chrome 或 Edge。没有弹窗口登录这条路，渠道看不到图片时就无法登录。
- 素材在 lark-agent 里只能作为附件到达：飞书不允许机器人下载用户拖进来的**文件夹**（资源接口只认图片和文件，与权限无关，2026-10-21 实测全部接口都不行），所以文件夹要压缩成 zip 发送，插件在计划阶段流式解压（支持 zip64、UTF-8 与 GBK 文件名、CRC 校验；只取顶层或唯一一层文件夹里的文件）。单独发的视频、2 GB 以内的文件 lark-agent 都能收（超过 100 MB 的按飞书规定分段下载）；一条消息最多 10 个附件；任务进行中再发来的消息（比如先发文字、再发 zip）会并入正在执行的那一轮（lark-agent 的 steering，见 [docs/lark-agent-integration.md](docs/lark-agent-integration.md)），技能在下一步就能读到它的附件。
- 夹具来自 openpyxl 生成的文件，不是飞书真实导出的 XLSX。解析器对共享公式、内联字符串、x14 下拉扩展等做了处理，但真实导出的样式/验证写法只有拿到一份真实文件才能确认；建议把一份真实导出的进度表加进夹具。

## 依赖版本

| 依赖 | 版本 |
|---|---|
| Node.js（系统，运行桥和 gof） | ≥ 24 |
| @larksuiteoapi/node-sdk | 1.75.0（已打包进 `server/dist`） |

