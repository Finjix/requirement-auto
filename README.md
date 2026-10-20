# requirement-auto

GOFCN 素材需求自动化的 **Codex 插件**（可被 ChatGPT/Codex 桌面版或 lark-agent 加载）：通过飞书 SDK 防覆盖追加创意进度表并验收，生成 CSV，保存 CLS 未发布草稿、导入脚本，生成可复制群消息。飞书用户登录用设备授权，登录信息按用户隔离存放。

## 目录

```
.agents/plugins/marketplace.json     本仓库就是一个 marketplace（名字 requirement-auto）
plugins/requirement-auto/            插件本体，安装和打包的就是这个目录
  plugin.json                        可移植插件清单（Agent Plugins 1.0.0）
  mcp.json                           stdio MCP 服务 feishu-auth：飞书登录工具
  server/dist/                       桥、MCP 服务和技能命令行 gof.mjs 的打包产物（提交入库，装好即用）
  skills/gof-requirement/            技能：SKILL.md、references/、assets/（CSV 模板）
dev/                                 开发专用，不进入发布包
  feishu-sdk/                        桥、MCP 服务和 gof 命令行的 TypeScript 源码（src/gof/ 是业务逻辑）、esbuild 脚本、测试和 XLSX 夹具
  package_plugin.mjs                 插件结构检查和打包
docs/lark-agent-integration.md       放进 lark-agent：怎么放、两边的约定、验证过什么
```

## 它怎么工作

- **飞书全部走 SDK**：不再有 lark-cli。`server/dist/bridge.mjs`（基于 `@larksuiteoapi/node-sdk`）只暴露白名单操作：读取 Wiki/文档/表格规则、导出完整 XLSX、防覆盖写入（`allow_overwrite:false`，服务端拒绝非空目标）。`gof.mjs feishu` 负责"校验 → 写 → 回读 → 验收"的编排，在同一进程里调用桥访问飞书；`gof.mjs batch` 离线规划追加行、校验快照、生成 CSV 和群消息，`gof.mjs cls` 构造 CLS 操作、校验回执，并负责 CLS 的登录和接口请求（见下一条）。XLSX 由 `src/gof/xlsx.ts` 里自带的只读解析器读取（zip + XML），不依赖其他库或运行时。
- **从需求链接自动整理需求，少问用户**：用户只需给飞书需求链接（表格的某一页，或文档）。`gof.mjs feishu document` 把它读成文字（表格：标题、表头和每行需求；文档：全文），`gof.mjs feishu context` 给出目标进度表现在的下拉选项、该供应商最近几批行是怎么填的、本人以前的批次（含审核人和 CLS 方向、任务类型）。技能据此推断条数、一二级标签、创意形式、提炼词（没写明就填“关键词”）、供应商、审核人、CLS 方向和任务类型，推不出的才问，最后给一份计划请用户确认。同一文档里不同类型的行（如 设定3.0 / 设定2.0）用 `items` 按原顺序写进同一张 CLS 单；素材名称由标签拼出，不再手写。下拉里没有的值，批准后用 `dropdown-add` 加进整列（一级、二级标签、创意形式、设计师供应商、创意者脚本审核人；供应商列是多选，保持多选）。进度表和 CLS 的叫法不同（冯彦蓉 / 冯彦蓉-实习生，丁杰 / 北京柒曦文化传媒有限公司（丁杰）），程序按唯一包含关系自动对上，对不上的由请求写明 `cls.supplier` / `cls.creator`。批准后表格版本变了（加下拉、别人改了别处）不再要求重新批准，只要新增行、编号和名称不变。
- **登录用设备授权**：`feishu_auth_login` 返回授权链接和验证码，用户在自己的浏览器里确认，`feishu_auth_poll` 保存登录。刷新令牌一次性有效，续期在文件锁内进行。宿主声明了用户的 Open ID 时，授权账号不是该用户会被拒绝。
- **按用户隔离**：宿主给每个 Codex 进程设 `LARK_AGENT_USER_DIR=<user/用户名>`，该用户的飞书登录和批次都在 `<用户目录>/requirement-auto/{feishu,batches,cls}`。工具和脚本都不接受用户标识参数，令牌不出现在任何输出里。
  **边界**：lark-agent 的 Codex 是 `danger-full-access`，仍是同一个 Windows 账号。这是防串号和误操作的逻辑隔离，防不住被提示词注入后主动去读别人目录的模型。
- **CLS：浏览器只负责登录，建单和导入走 HTTP**：CLS 在公司 SSO 后面，没有设备授权或回调，登录只能在网页上完成，而公司 SSO 就是飞书网页扫码授权。`gof.mjs cls login --qr` 用本机已装的 Chrome 或 Edge（`src/gof/chromium.ts`，自带的最小 DevTools 客户端，不下载、不依赖 npm 包、不依赖 Codex 的内置浏览器或电脑控制）以**无头模式**打开 CLS，用户用手机扫码；命令只从页面自己的 API 请求里读出 Authorization，用 `/api/userinfo` 确认有效，然后关闭浏览器。之后的选项读取、建草稿、导入 CSV、回读都是 Node 发出的 HTTP 请求（`src/gof/cls-adapter.ts`，路径白名单，没有发布/删除能力），令牌只在命令进程内存里。浏览器资料在用户自己目录的 `cls/browser-profile`，各用户互不相通；登录还有效时后续命令静默取得会话，不再需要扫码。SSO 留下的是会话级 Cookie，所以浏览器按“继续上次浏览”（`--restore-last-session`）启动才保得住登录；等待扫码的浏览器以 `detached` 启动，命令返回后仍在，下一次命令接上（否则 Windows 上子进程随命令进程一起结束）。整个流程没有任何浏览器窗口。
- **CLS 二维码登录（不需要有人在电脑前）**：`gof.mjs cls login --qr cls-login.png` 让无头浏览器停在飞书扫码页，把页面截图写成 PNG（lark-agent 的工作目录就是交付目录，图片随回复自动发给用户），浏览器留在后台等扫码；用户用飞书手机端扫码后，浏览器会停在飞书对 CLS 应用 `dsc_admin` 的授权页（需要点【授权】），`gof.mjs cls session` 接上那个浏览器，**自动点【授权】**、取得登录并正常关闭它。自动点的范围很窄：页面上写明的应用必须是 `dsc_admin`，已绑定账号时页面上的账号必须是绑定的那个，只点【授权】、绝不点【拒绝】，一次登录只点一次，其余情形不点并报告原因。15 分钟没人扫码，下一个命令会清理等待的浏览器和图片。二维码谁扫谁登录，所以只发给本人；账号绑定会拦住之后换号。
- **每个任务都检查登录，不只是第一次**：`gof.mjs login check` 真实地检查飞书和 CLS，**先飞书后 CLS、一次只向用户要一个登录**：飞书没登录时只返回飞书的 `todo`，CLS 记为 `not_checked`（不启动浏览器），飞书登录好后下一次检查才轮到 CLS 二维码。飞书登录也在这个无头浏览器里完成：`gof.mjs feishu authorize --qr` 在浏览器里打开设备授权链接，浏览器没有飞书网页登录态时停在飞书扫码页并把二维码交给用户，扫码后 `gof.mjs feishu authorize` 自动点飞书授权页的【授权】，再 `feishu_auth_poll` 收登录；因为浏览器资料目录与 CLS 共用，这一次扫码同时让 CLS 的单点登录通过，CLS 不再要第二次扫码（真实环境实测：扫码一次，`login check` 4 秒内两边都 ok）。飞书是向飞书服务器验证（只看本地过期时间会漏掉用户在飞书里撤销授权的情况；令牌过期会自动续一次，也把闲置的登录续期，刷新令牌 7 天不用就失效），CLS 是在无头浏览器里取一次真实会话。返回 `ok`、`login_required`（带 `todo`，说明该让用户做什么）、`blocked`（账号不一致、授权页不对等，重新登录解决不了）或 `unknown`（暂时连不上飞书，不说明登录失效）；只读，退出码非 0 表示有问题。技能规定每个任务开始、用户批准计划之后第一次写入之前、进入 CLS 阶段之前、任何命令报登录失效时、中断恢复时都要运行它。
- **多用户共用一台电脑的保护**（`src/gof/cls-guard.ts`）：第一次登录的 CLS 账号按用户记在 `cls/account.json`，之后换了账号就拒绝。宿主给了 `LARK_AGENT_USER_OPEN_ID` 却没有 `LARK_AGENT_USER_DIR` 时，所有命令直接拒绝，不回落到共用目录。
- **MCP 只管登录**：业务编排在 `gof.mjs` 里一次完成，因为追加的顺序校验不能拆成模型逐步调用。

## 安装与使用

需要 Node.js 24+，别无其他依赖（包约 3 MB）。

```bash
codex plugin marketplace add <本仓库路径>
codex plugin add requirement-auto@requirement-auto
```

- **单机用 Codex 桌面版**：插件自带的 `feishu-auth` 服务用 `PLUGIN_DATA` 存登录；应用凭证写进该目录的 `app.json`（`{"appId":"…","appSecret":"…"}`，面向该应用的管理员，注意文件权限）。MCP 进程拿不到桌面环境变量（见下）。
- **lark-agent（拖入即用）**：把 `plugins/requirement-auto` 复制到 lark-agent 的 `plugins/` 下，重启 lark-agent，不需要任何配置。lark-agent 启动时自动安装，并按用户每轮覆盖 MCP 配置、注入用户目录和飞书应用。步骤和约定见 [docs/lark-agent-integration.md](docs/lark-agent-integration.md)。
- 改了插件后要让已装副本生效：`codex plugin remove requirement-auto@requirement-auto` 再 `add`（或提升 `plugin.json` 的 version）。

### Codex 0.163.0 的实测结论

- 插件的 `mcp.json` 必须含 `$schema`，且 stdio 条目只允许 `type/command/args/env/cwd`；多写任何键（比如 `env_vars`）整个服务会被静默丢弃。
- 插件声明的 MCP 进程只拿到 PATH、`PLUGIN_ROOT`、`PLUGIN_DATA` 和静态 `env`；宿主环境变量不会传进去，`${VAR}` 也不展开（只展开 `${PLUGIN_ROOT}`）。所以按用户传目录必须由宿主在配置里注册同名 MCP 服务，并关掉插件自带的那一个。
- 技能在 Codex 里的名字带命名空间：`requirement-auto:gof-requirement`。

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
2. 真实设备授权登录：`feishu_auth_login` → 浏览器确认 → `feishu_auth_poll`。`oauth/v1/device_authorization` 和 `sheet_ai/.../invoke_write` 没有公开文档，只有官方 lark-cli 在用，协议来自它的开源代码和 `--dry-run` 抓取。
3. **在隔离表上重做防覆盖探测**：`gof.mjs feishu login start --probe-scope` → `gof.mjs feishu probe`。旧的 lark-cli 时代记录全部作废。探测时记下服务端"非空拒写"的真实错误码和文案，补进 `dev/feishu-sdk/src/api.ts` 的 `OCCUPIED` 判断。
4. **CLS 写入**：从二维码到登录的整条路已在真实 CLS 上验证（2026-10-20，本机 Edge，无头）：生成二维码并发给用户 → 用户用飞书手机端扫码 → 浏览器停在 `dsc_admin` 授权页 → `cls session` 自动点【授权】并取到登录（3 秒）→ 之后连续的静默检查成功，二维码图片和等待的浏览器都已清理；令牌只带 Authorization 头就被 `/api/userinfo` 和 `cls catalog` 接受，另一个用户目录仍是未登录。还没做的是写入：用独立的测试草稿走一遍 `cls observe → run`。
5. 在测试进度表上走一遍全流程。
6. **从需求链接自动整理**：读需求文档和 `context` 已在真实的四份示例文档和测试进度表上只读跑过（行数 15/14/7 正确，供应商历史、下拉选项、以前的批次都读得出来）；CLS 名称匹配用真实目录验证过（丁杰、杨燃、冯彦蓉都能对上）。还没在真实表格上做过的写入：给创意形式、供应商（多选列）、审核人列 `dropdown-add`，以及一次含多种行（`items`）的完整追加和建单。

## 已知限制

- CLS 登录靠用户在自己的手机上扫码，不需要有人在运行机器人的电脑前，也不需要桌面；这台电脑要装 Chrome 或 Edge。没有弹窗口登录这条路，渠道看不到图片时就无法登录。
- 夹具来自 openpyxl 生成的文件，不是飞书真实导出的 XLSX。解析器对共享公式、内联字符串、x14 下拉扩展等做了处理，但真实导出的样式/验证写法只有拿到一份真实文件才能确认；建议把一份真实导出的进度表加进夹具。

## 依赖版本

| 依赖 | 版本 |
|---|---|
| Node.js（系统，运行桥和 MCP） | ≥ 24 |
| @larksuiteoapi/node-sdk | 1.75.0（已打包进 `server/dist`） |
| @modelcontextprotocol/sdk | 1.32.1（已打包进 `server/dist`） |
