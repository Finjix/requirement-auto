# requirement-auto

GOFCN 素材需求自动化的 **Codex 插件**（可被 ChatGPT/Codex 桌面版或 lark-agent 加载）：通过飞书 SDK 防覆盖追加创意进度表并验收，生成 CSV，保存 CLS 未发布草稿、导入脚本，生成可复制群消息。飞书用户登录用设备授权，登录信息按用户隔离存放。

## 目录

```
.agents/plugins/marketplace.json     本仓库就是一个 marketplace（名字 requirement-auto）
plugins/requirement-auto/            插件本体，安装和打包的就是这个目录
  plugin.json                        可移植插件清单（Agent Plugins 1.0.0）
  mcp.json                           stdio MCP 服务 feishu-auth：飞书登录工具
  server/dist/                       桥、MCP 服务和技能命令行 gof.mjs 的打包产物（提交入库，装好即用）
  skills/gof-requirement/            技能：SKILL.md、references/、scripts/cls_api.js（CLS 浏览器适配器）、assets/（CSV 模板）
dev/                                 开发专用，不进入发布包
  feishu-sdk/                        桥、MCP 服务和 gof 命令行的 TypeScript 源码（src/gof/ 是业务逻辑）、esbuild 脚本、测试和 XLSX 夹具
  package_plugin.mjs                 插件结构检查和打包
docs/lark-agent-integration.md       放进 lark-agent：怎么放、两边的约定、验证过什么
```

## 它怎么工作

- **飞书全部走 SDK**：不再有 lark-cli。`server/dist/bridge.mjs`（基于 `@larksuiteoapi/node-sdk`）只暴露白名单操作：读取 Wiki/文档/表格规则、导出完整 XLSX、防覆盖写入（`allow_overwrite:false`，服务端拒绝非空目标）。`gof.mjs feishu` 负责"校验 → 写 → 回读 → 验收"的编排，在同一进程里调用桥访问飞书；`gof.mjs batch` 离线规划追加行、校验快照、生成 CSV 和群消息，`gof.mjs cls` 构造 CLS 操作并校验回执。XLSX 由 `src/gof/xlsx.ts` 里自带的只读解析器读取（zip + XML），不依赖其他库或运行时。
- **登录用设备授权**：`feishu_auth_login` 返回授权链接和验证码，用户在自己的浏览器里确认，`feishu_auth_poll` 保存登录。刷新令牌一次性有效，续期在文件锁内进行。宿主声明了用户的 Open ID 时，授权账号不是该用户会被拒绝。
- **按用户隔离**：宿主给每个 Codex 进程设 `LARK_AGENT_USER_DIR=<user/用户名>`，该用户的飞书登录和批次都在 `<用户目录>/requirement-auto/{feishu,batches}`。工具和脚本都不接受用户标识参数，令牌不出现在任何输出里。
  **边界**：lark-agent 的 Codex 是 `danger-full-access`，仍是同一个 Windows 账号。这是防串号和误操作的逻辑隔离，防不住被提示词注入后主动去读别人目录的模型。
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
4. 在测试进度表上走一遍全流程。

## 已知限制

- CLS 一步依赖 `mcp__cua_repl` 的内置浏览器取登录会话，而 lark-agent 关闭了浏览器工具，在 lark-agent 里这一步目前走不通，需要单独设计；技能还没有为此做降级处理（在 lark-agent 里，进度表追加和验收可用，CLS 草稿和导入不可用）。
- 夹具来自 openpyxl 生成的文件，不是飞书真实导出的 XLSX。解析器对共享公式、内联字符串、x14 下拉扩展等做了处理，但真实导出的样式/验证写法只有拿到一份真实文件才能确认；建议把一份真实导出的进度表加进夹具。

## 依赖版本

| 依赖 | 版本 |
|---|---|
| Node.js（系统，运行桥和 MCP） | ≥ 24 |
| @larksuiteoapi/node-sdk | 1.75.0（已打包进 `server/dist`） |
| @modelcontextprotocol/sdk | 1.32.1（已打包进 `server/dist`） |
