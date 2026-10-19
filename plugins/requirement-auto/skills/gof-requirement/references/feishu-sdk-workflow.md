# 飞书 SDK 桥

适用于飞书文档读取、测试进度表完整导出、获批追加和下拉规则验收。业务命令统一通过 `scripts/feishu_api.py`，它调用插件内的 `server/dist/bridge.mjs`（基于飞书官方 Node SDK `@larksuiteoapi/node-sdk`，只有白名单操作）。不直接调用通用写接口、不切换浏览器兜底，也不使用 lark-cli。

## 运行条件

- 系统已装 Node.js 24+（桥和 MCP 服务都用它）；Python 用包内 `assets/dependencies/python/python.exe`，版本固定、文件有摘要清单。
- 宿主通过环境变量告诉进程"这是谁的数据目录、用哪个飞书应用"：`LARK_AGENT_USER_DIR`（用户目录，必须是绝对路径）、`LARK_AGENT_USER_OPEN_ID`（可选，该用户的 Open ID）、`FEISHU_APP_ID` / `FEISHU_APP_SECRET`。用户数据放在 `<用户目录>/requirement-auto/{feishu,batches}`。
- 没有宿主（单机直接用）时数据放 `PLUGIN_DATA`，再退回 `~/.requirement-auto/default`；应用凭证可写在该目录的 `app.json`（`{"appId":"…","appSecret":"…"}`）。有宿主时从不读 `app.json`。

```text
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/skill_runtime.py doctor     无网络：校验 Python 摘要、桥文件、Node 版本
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py doctor        查询当前用户的登录与必要权限
```

缺文件、版本/摘要不符或平台不是 Windows x64 时停止，不运行 npm install、不下载、不用系统 CLI、不自动更新。

## 登录与授权

登录用飞书**设备授权**：向 `accounts.feishu.cn/oauth/v1/device_authorization` 申请，用户在自己的浏览器里打开链接确认，之后用 `…/oauth/v3/token` 换取令牌，续期用 SDK 的 `accessToken.refresh`。请求的权限是进度表读写、导出、文档和 Wiki 读取，另加 `offline_access` 以取得刷新令牌。

优先用 MCP 工具（插件自带 `feishu-auth` 服务）：`feishu_auth_status` → `feishu_auth_login` → 把链接和验证码原样发给用户并结束本轮 → 用户回复后 `feishu_auth_poll`；`feishu_auth_logout` 仅在用户要求退出或换账号时用。MCP 不可用时用同一份登录的脚本版：

```text
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py login start [--probe-scope]
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py login poll [--wait 40]
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py login status
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py login logout
```

`--probe-scope` 仅在已获批的隔离探测前使用，额外请求 `sheets:spreadsheet:create`。

- 令牌只在桥进程内存和用户目录的 `feishu/auth.json`；工具结果、桥输出、日志和批次记录中不出现令牌或应用密钥。
- 刷新令牌一次性有效，续期在文件锁内进行，多个进程同时需要续期只会续一次。
- 宿主声明了用户的 Open ID 时，授权账号不是该用户会被拒绝，令牌不落盘。
- 用户拒绝授权、授权过期、权限缺失或需要企业审批时如实说明，交给用户和管理员处理；不换 bot 身份、不借用别人的登录。

## 快照、计划、追加

```text
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py snapshot --output <新快照.xlsx>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py document --url <本次脚本文档链接>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py plan --request request.json --snapshot <快照.xlsx>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py prepare --plan approved-api-plan.json --snapshot <fresh.xlsx>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py append --batch <批次> --receipt <隔离安全记录.json>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py reconcile --batch <已有批次>
```

目标固定为测试 Wiki 节点 `YFyywzwLsiT07EkpBaecr8nIncn`。桥解析真实 spreadsheet token，工作表元数据与完整 XLSX 顺序/名称必须一致。用户明确指定表名优先，否则选择年月最新且列结构正确的 GOFCN 表，歧义时询问。计划明确展示表名和 sheet ID；不读取用户当前浏览器标签。

桥的操作都有白名单：

| 操作 | 接口 |
|---|---|
| 读取 | Wiki `get_node`、sheets v3 `sheets/query`、sheets v2 `dataValidation` / `values_batch_get` / `metainfo`、docx `raw_content` |
| 导出 | `drive/v1/export_tasks` 创建、轮询、下载；输出必须是不存在的新 XLSX |
| 写入 | `sheet_ai/v2/spreadsheets/{token}/tools/invoke_write`，`batch_update` + `set_cell_range`，每个范围 `allow_overwrite:false` |
| 新建 | 仅隔离探测：`sheets/v3/spreadsheets` |

snapshot 导出完整 XLSX 并检查导出前后版本（`metainfo.revision`）；导出任务未完成时停止，不拿 CSV 替代，不盲目再次提交。系统计划模式可读取已有快照，不执行落盘导出。

plan 只打印 JSON，包含 `batch_plan` 和 `api_plan`；api_plan 包含真实目标、sheet ID、版本、全工作簿规则及本批最终下拉选项/颜色/模式。获批后才保存完整 JSON。prepare 重算两个计划并生成不可变 `api-plan.json`，变化时停止，不能静默重编号。

append 先核对隔离安全记录、用户身份、版本、fresh XLSX、隐藏列/空公式/合并/编号及全工作簿规则。写入是一次 `invoke_write`，公式用 formula、多选用 multiple_values，不给空白字段发送 null。写请求不重试：没有收到结果就是"结果未知"，只回读，不重发。下拉只写本批范围，保留全部原选项、颜色、高亮和模式；引用型或不完整规则不能可靠保留时停止。

写后完整导出并回读全部规则，`rule-proof.json` 绑定 api_plan 和当前快照。验收同时保护历史值、公式、样式和规则；XLSX 中存在但错误的规则不能补验。通过后记录 append_verified，并生成 `api-attempt-*/verification-report.json`。报告和 receipt 表示采集时的证据，不代表网页与接口是原子事务。

## 首次防覆盖验证

传输层从 lark-cli 换成了 SDK 桥，所以旧版 receipt（`cli_version`、schema 1）全部作废。必须先取得独立在线验证计划授权：仅创建一个新的 `GOFCN_API_SAFETY_*` 工作簿，写入哨兵和返回空字符串的公式，测试三次占用拒写并回读。不能使用进度表旧格，不删除验证表。

```text
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py login start --probe-scope   （用户确认授权后 login poll）
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py probe --receipt <新的安全记录.json>
```

只有服务端明确拒绝占用写入（桥返回 `kind: occupied`）且每次原值/公式不变，才生成绑定桥版本 `feishu-sdk-bridge/1` 的记录。网络/权限失败不等于防覆盖成功，不人工生成通过记录。探测中遇到的真实"非空拒写"错误码和文案，应补进 `dev/feishu-sdk/src/api.ts` 的 `OCCUPIED` 判断和对应测试。未获批或未验证时可以完成只读计划，业务追加保持受阻。

## 中断恢复

先读 batch status，运行 reconcile：它只读核对真实目标、导出 fresh XLSX、回读完整规则/版本，用原 api_plan 生成新的规则证明和验收报告。输出 snapshot 和 validation_evidence，可用于 batch.verify 和 record resumed；不再次写入。完整则复用原 CSV，用户解决阻塞且明确要求恢复后才 record resumed；若尚未记录 append_verified，则携带同一 snapshot、规则证据和采集路径记录该事件，再继续 CLS。已开始 CLS 时先回读已有草稿和导入。

任何已尝试写入的批次不重发；部分写入、占用、历史变化或未知结果保持现场并交接，不回滚、不补写、不转 UI。即使返回全空，客户端仍不能推断前一次请求已结束。未尝试的批次只有基线、规则和获批版本完全一致才可继续。旧 UI 批次保留原事件/证据，不移除 api-plan 或改写 manifest 绕过守卫。由 lark-cli 时代创建的批次（api-plan 含 `cli_version`）不能用新桥回读，需用原技能包。

## 发布与维护（维护者）

```text
<仓库>/plugins/requirement-auto/skills/gof-requirement/assets/dependencies/python/python.exe -I -B <仓库>/dev/run_tests.py
<仓库>/plugins/requirement-auto/skills/gof-requirement/assets/dependencies/python/python.exe -I -B <仓库>/dev/package_plugin.py --output <新交付包.zip>
```

桥与 MCP 服务的源码在 `dev/feishu-sdk/`，`npm run build` 打包到 `plugins/requirement-auto/server/dist/`（产物提交入库，安装插件不需要 npm install）。发布工具只校验及打包已有文件，不下载、不安装、不更新锁文件；ZIP 不含批次、个人凭据或浏览器会话。
