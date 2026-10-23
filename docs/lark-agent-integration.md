# 放进 lark-agent

lark-agent（`D:\project\lark-agent`）已经实现了"插件文件夹拖进去就能用"。本文说明怎么放、两边各自做了什么、以及哪些东西还没有在真实环境里验证过。lark-agent 一侧的实现在它的 `src/plugins.ts`，使用说明在它的 README“插件”一节。

## 怎么放

把本仓库的 **`plugins/requirement-auto`**（里面直接是 `plugin.json` 的那个文件夹，不是整个仓库）复制到 lark-agent 的 **`plugins/`** 下，重启 lark-agent。在 lark-agent 目录里：

```bat
start.cmd stop
robocopy D:\project\requirement-auto\plugins\requirement-auto plugins\requirement-auto /MIR /XD .state /XF auth.json app.json
start.cmd
```

- 第一次放，直接把文件夹拖进 `plugins/` 也一样；之后更新用 `/MIR`（镜像）而不是覆盖粘贴：覆盖粘贴会把旧版里已删除的文件留在 `plugins/` 里。（`robocopy` 返回 1 到 7 都是成功。）
- 日志里出现 `已安装插件`、`插件已就绪`，`http://127.0.0.1:8765/health` 的 `plugins.loaded` 里有 `requirement-auto`，就是装好了。`start.cmd doctor` 不改动任何东西，只告诉你 `plugins/` 下每个文件夹的状态。
- 以后改了插件：重复上面的复制和重启。内容变了（版本号没变也算）会自动整体替换；把文件夹从 `plugins/` 删掉就卸载；文件夹改名加 `_` 前缀就是停用。
- 服务运行中复制没有效果，只在启动时扫描。

用户不需要任何配置。用户在飞书里给来需求文档要发布素材需求时，Codex 会按技能描述自己选用 `requirement-auto:gof-requirement`（发布需求：进度表 + CLS 建单）；发来做好的素材要求上传时选用 `requirement-auto:gof-creative-upload`（上传素材：进度表 + CLS 上传素材，不建单）。需要飞书登录时，Codex 运行 `gof.mjs feishu login start` 和 `gof.mjs feishu authorize --qr`，把二维码发给用户。

### 素材上传与附件

上传技能从 lark-agent 的附件说明里拿文件：lark-agent 把用户发来的附件下载到 `user/<名>/workspace/input/<原文件名>`，在提示开头写 `Files the user attached to this message …` 并列出绝对路径。技能只读这些文件，不移动、不改名；zip 解压到插件自己的 `tmp/unpacked/`；还没登记的文件先追加创意进度表的行，再按每个文件那一行的素材名称上传（文件名不对时创意名称和上传的文件名都换成素材名称，本地文件不动）；结束后的进度表和创意列表截图写进工作目录，随回复发回。lark-agent 一侧（2026-10-21 起）：

| 情况 | 现在怎么处理 |
|---|---|
| 单独发送的视频（`media` 消息） | 按文件接收，保留原文件名 |
| 文件和视频不超过 2 GB，图片不超过 100 MB | 超过 100 MB 的按飞书规定用 Range 分段（每段 30 MB）下载；太大时任务失败并把原因告诉用户 |
| 每条消息最多 10 个附件 | 未改；多了就用 zip 一次发完 |
| 有任务在执行时用户再发消息（如先发文字、再发素材） | 并入正在执行的那一轮（Codex 的 steering，2026-10-22 起）：附件先下载到同一个 `workspace/input/`，Codex 在下一步读到这条消息和附件路径；Codex 不再接收时（这一轮刚结束）改为在后面单独执行 |
| 文件夹（`folder` 消息，或图文里的文件夹） | 飞书的资源接口不支持文件夹（`type=file` 返回 500/40009，`type=folder` 返回 234001，与权限无关），机器人回复请用户压缩成 zip 再发 |

批量素材的做法：把文件夹压缩成 zip 发给机器人，插件解压后按文件逐个建创意。素材还没登记时（比如已按进度表规则命名、编号写成 `GOFCNxxxxx` 的文件），技能先从这些文件整理出进度表的行并追加，再按新行的素材名称上传；素材已经做好，不建 CLS 需求单。整个过程只确认一次计划。

## 约定（宿主给插件什么）

| 项目 | 内容 |
|---|---|
| 清单 | 文件夹里的 `plugin.json` 必须带 `$schema`（Agent Plugins），或者用 `.codex-plugin/plugin.json`。**不带 `$schema` 的根 `plugin.json`，Codex 报 `missing plugin.json`**（实测）；lark-agent 会在日志和 `doctor` 里说明原因 |
| 插件在 Codex 里的名字 | `requirement-auto@lark-agent`；技能 `requirement-auto:gof-requirement`、`requirement-auto:gof-creative-upload` |
| 每个用户每一轮的环境变量 | `LARK_AGENT_USER_DIR`（`user/<名>`，不是其中的 `workspace`）、`LARK_AGENT_USER_OPEN_ID`（飞书 Open ID）、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`（机器人的应用）。Codex 的 shell 工具拿得到，`gof.mjs` 直接读取 |
| MCP 服务 | 插件不带 `mcp.json`，没有 MCP 服务。lark-agent 的 `mcpServers()` 读不到 `mcp.json` 时返回空，不注册、也不关闭任何服务；这段逻辑留着给以后声明了 MCP 的插件用 |
| 数据位置 | `user/<名>/requirement-auto/{feishu,cls,batches,tmp}`。不在 `workspace/` 里，所以不在 lark-agent 的清理范围内，也不会被当作交付文件发给用户。登录（`feishu`、`cls`）一直保留；`batches` 和 `tmp` 由插件自己清理：每次运行 `gof` 开始时，删除 7 天（环境变量 `REQUIREMENT_AUTO_RETENTION_DAYS` 可改，整数天）内没有任何文件被创建、修改或移动过的批次目录和 tmp 文件（`src/retention.ts`）。批次整个删或整个不删，所以超过 7 天的未完成批次不能再恢复 |

### 为什么插件不带 MCP 服务

插件以前用一个 `feishu-auth` MCP 服务做飞书登录，现在改成 `gof.mjs feishu login …` 命令。原因是下面的实测（Codex 0.163.0，`codex app-server` 的 `mcpServerStatus/list` 和 `mcpServer/tool/call`）：

| 项目 | 结果 |
|---|---|
| 插件 `mcp.json` 里的 stdio 服务能起来、工具可调用 | 是 |
| 服务进程收到 Codex 进程的环境变量 | **否**。只有 `PATH`、`PLUGIN_ROOT`、`PLUGIN_DATA` 和 `mcp.json` 里静态写的 `env` |
| `mcp.json` 的 `env` 里写 `${LARK_AGENT_USER_DIR}` | **不展开**，原样字符串；只有 `${PLUGIN_ROOT}` 会展开 |
| `mcp.json` 里写 `env_vars` | **整个服务被静默丢弃**（schema 禁止多余键） |
| 在 **config** 里注册的服务用 `env_vars` 转发环境变量 | **可以**（`mcp_servers.<名>.env_vars`） |
| 用 `plugins."<id>".mcp_servers.<名>.enabled=false` 关掉插件自带的服务 | **可以** |
| 配置键里的插件号含 `@` | SDK 展平配置时不会给路径段加引号，必须自己写进键里（`plugins."requirement-auto@lark-agent"…`） |

插件声明的 MCP 服务拿不到按用户区分的目录，宿主只能每轮在配置里重新注册一个同名服务。shell 命令本来就继承这些变量，用户目录同样由宿主决定，模型和命令参数碰不到，所以直接去掉了 MCP。

### 安装行为（实测）

`codex plugin add` 可重复执行，会把已装副本整体替换（删掉的文件、旧版本目录都会清理）；`plugin remove` 对不存在的插件也不报错；`plugins/` 本身被登记为名为 `lark-agent` 的本地 marketplace，登记信息和启用状态写在 `.codex/config.toml`。已装副本在 `.codex/plugins/cache/lark-agent/requirement-auto/<version>/`，自带的运行时校验（254 个文件的摘要）在那里通过。

## 验证过什么、没验证什么

已在本机验证（Codex 0.163.0，临时 Codex home，真实插件）：

- 安装、重复启动不重装、改动后替换、删除后卸载；整套流程在 lark-agent 的自动测试里（用真实 Codex CLI）。
- 按 lark-agent 每轮实际生成的配置启动 `codex app-server`：技能 `requirement-auto:gof-requirement` 可见（当时插件还带 `feishu-auth` MCP 服务；去掉后没有重新跑过这一项）。
- 从已装副本运行 `node <插件根>/server/dist/gof.mjs feishu doctor`（Node、桥、登录和权限）和 `gof.mjs feishu login status`（读到宿主环境，`storage: "host"`）。
- lark-agent 完整启动：`/health` 的 `plugins.loaded` 列出插件，无效文件夹出现在 `plugins.skipped`。

**没有验证（需要真实飞书应用、真实 Codex 登录或你的授权）：**

1. 用真实模型回合走一遍：用户在飞书里提需求 → Codex 选用技能 → 运行 `gof.mjs login check` 和 `gof.mjs feishu login start`。
2. 飞书应用后台：给应用的**用户身份**开通 `wiki:wiki:readonly sheets:spreadsheet:readonly sheets:spreadsheet:read sheets:spreadsheet:write_only sheets:spreadsheet drive:export:readonly docx:document:readonly offline_access`（隔离探测另需 `sheets:spreadsheet:create`），允许用户身份授权，并发布版本。lark-agent 不记录插件需要的权限，以这份清单为准。
3. 真实设备授权登录，以及两个飞书账号分别登录互不串号（用 A 的链接让 B 确认应被拒绝；`user/<A>/requirement-auto/feishu/auth.json` 与 `user/<B>/…` 里的 `open_id` 不同）。
4. 按 [README](../README.md) 的“还没做”清单做隔离探测，再在测试进度表上走全流程。CLS 登录本身已在真实环境验证（见 README），但还没有经过 lark-agent 的每用户环境走一遍。

## 已知限制

- **CLS 登录走二维码，不需要有人在电脑前，也没有浏览器窗口**：技能先 `gof.mjs cls login --qr cls-login.png`，无头浏览器停在飞书扫码页，图片写在 Codex 的工作目录（`user/<名>/workspace`，也就是 lark-agent 的交付目录），随回复自动发给用户，由用户用飞书手机端扫码确认；之后 `gof.mjs cls session` 取得登录。二维码只能发给本人。登录保存在 `user/<名>/requirement-auto/cls/browser-profile`，之后的命令用无头浏览器静默取得会话并走 HTTP。前提是这台电脑装了 Chrome 或 Edge，不需要桌面会话。
- **机器人密钥**：有插件时，每个用户的每一轮 Codex 进程都带着 `FEISHU_APP_SECRET`。lark-agent 的 README 本来就声明 Codex 能读 `.env`，这里没有新增一类风险，但要知道。想收紧：给设备授权单独建一个飞书应用，把 `.env` 里的 `FEISHU_APP_ID/SECRET` 换成它。
- **宿主设了 `LARK_AGENT_USER_OPEN_ID` 就必须同时设 `LARK_AGENT_USER_DIR`**，否则命令拒绝运行，不会回落到所有用户共用的目录。
- **隔离是逻辑上的**：Codex 是 `danger-full-access`，同一个 Windows 账号。这防得住串号和误操作，防不住被提示词注入后主动去读别人目录（`cat user/别人/requirement-auto/feishu/auth.json`）的模型。要真隔离，得给每个用户单独的系统账号或沙箱。

| 防住的 | 怎么防 |
|---|---|
| 用户 A 的登录被用户 B 使用 | 每个 Codex 进程的数据目录由宿主环境决定；`gof` 和桥命令都没有用户参数 |
| A 把授权链接发给 B，B 点了确认 | 宿主传 `LARK_AGENT_USER_OPEN_ID`，授权账号不一致会被拒绝，令牌不落盘 |
| 令牌出现在对话、日志、批次记录里 | `gof` 和桥的输出只含状态；错误文本统一去掉令牌和应用密钥 |
| 两个进程同时续期把一次性刷新令牌用坏 | 续期在文件锁里做，锁内重读 |
| 批次落进共享的系统 temp | `LARK_AGENT_USER_DIR` 存在时批次根目录改为用户目录 |
