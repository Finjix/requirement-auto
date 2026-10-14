# 包内飞书 CLI

适用于飞书文档读取、测试进度表完整导出、获批追加和下拉规则验收。业务命令统一通过 `scripts/feishu_api.py`，不直接调用通用 CLI 写命令、不切换浏览器兜底。

## 完整包及配置

固定版本：Python `3.13.15`、openpyxl `3.1.5`、et_xmlfile `2.0.0`、官方 `@larksuite/cli@1.0.98`、Windows x64 native CLI、Node `24.21.0 LTS` 和锁定的 npm 依赖。完整运行依赖位于 `assets/dependencies/`；其中 `manifest.json` 记录依赖来源、锁文件和所有运行时文件 SHA-256。仅使用包内 Python，不依赖代理环境的 bundled runtime。

```text
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/skill_runtime.py doctor
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py doctor
```

第一个命令无网络，仅校验包内文件、实际版本和 Python 模块；第二个查询用户授权和必要 scopes。缺文件、版本/摘要不符或平台不是 Windows x64 时停止，不运行 npm install、npx、安装向导、系统 CLI、自动更新或其他技能安装。仓库中的 skill 已含完整便携依赖，整个文件夹可直接发布。

首次配置仅在用户要求/批准配置后进行。由 runtime doctor 返回 CLI 的绝对路径，所有配置/授权进程都使用 `skill_runtime.runtime_environment(<skill根目录>)`：它把 `LARKSUITE_CLI_CONFIG_DIR` 固定到 `<skill>/.state/feishu-cli` 并关闭更新/skills 通知，不能遗漏这组进程环境。已有专用配置则复用，不重置、删除或切换全局 profile。

```text
<包内CLI> config init --new --name gof-requirement
<包内CLI> --profile gof-requirement auth login --scope "wiki:wiki:readonly sheets:spreadsheet:readonly sheets:spreadsheet:read sheets:spreadsheet:write_only sheets:spreadsheet drive:export:readonly docx:document:readonly" --no-wait --json
```

用户在正常飞书页面完成配置/授权，企业审批按实际要求处理。身份固定为用户，不切换 bot 绕过文档权限。仅在独立隔离探测获批时追加 `sheets:spreadsheet:create`。官方 CLI 管理凭据；不读取/复制凭据、不保存 token 到批次、清单或日志。`.state` 不进入交付包，移动到另一台机器后重新授权。skill 创建/构建任务默认不运行这些在线命令。

## 快照、计划、追加

```text
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py snapshot --output <新快照.xlsx>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py document --url <本次脚本文档链接>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py plan --request request.json --snapshot <快照.xlsx>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py prepare --plan approved-api-plan.json --snapshot <fresh.xlsx>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py append --batch <批次> --receipt <隔离安全记录.json>
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py reconcile --batch <已有批次>
```

目标固定为测试 Wiki 节点 `YFyywzwLsiT07EkpBaecr8nIncn`。CLI 解析真实 spreadsheet token，工作表元数据与完整 XLSX 顺序/名称必须一致。用户明确指定表名优先，否则选择年月最新且列结构正确的 GOFCN 表，歧义时询问。计划明确展示表名和 sheet ID；不读取用户当前浏览器标签。

snapshot 导出完整 XLSX 并检查导出前后版本；输出必须为未存在的新文件。导出返回未完成任务但没有文件时停止，不拿 CSV 替代；按官方任务引用只读查进度，不盲目再次提交。系统计划模式可读取已有快照，不执行落盘导出。

plan 只打印 JSON，包含 `batch_plan` 和 `api_plan`；api_plan 包含真实目标、sheet ID、版本、全工作簿规则及本批最终下拉选项/颜色/模式。获批后才保存完整 JSON。prepare 重算两个计划并生成不可变 `api-plan.json`，变化时停止，不能静默重编号。

append 先核对隔离安全记录、用户身份、版本、fresh XLSX、隐藏列/空公式/合并/编号及全工作簿规则。写入为 `+cells-set --writes - --allow-overwrite=false`，每项也固定 `allow_overwrite:false`；JSON 通过 stdin，公式用 formula、多选用 multiple_values，不给空白字段发送 null。下拉只写本批范围，保留全部原选项、颜色、高亮和模式。引用型或不完整规则不能可靠保留时停止。

写后完整导出并回读全部规则，`rule-proof.json` 绑定 api_plan 和当前快照。验收同时保护历史值、公式、样式和规则；XLSX 中存在但错误的规则不能补验。通过后记录 append_verified，并生成 `api-attempt-*/verification-report.json`，无需截图。报告和 receipt 表示采集时的证据，不代表网页与接口是原子事务。

## 首次防覆盖验证

必须先取得独立在线验证计划授权：仅创建一个新的 `GOFCN_API_SAFETY_*` 工作簿，写入哨兵和返回空字符串的公式，测试三次占用拒写并回读。不能使用进度表旧格，不删除验证表。

```text
<skill>/assets/dependencies/python/python.exe -B <skill>/scripts/feishu_api.py probe --receipt <新的安全记录.json>
```

只有服务端明确拒绝占用写入且每次原值/公式不变，才生成绑定 CLI 版本和目标 token 的记录。网络/权限失败不等于防覆盖成功，不人工生成通过记录。未获批或未验证时可以完成只读计划，业务追加保持受阻。

## 中断恢复

先读 batch status，运行 reconcile：它只读核对真实目标、导出 fresh XLSX、回读完整规则/版本，用原 api_plan 生成新的规则证明和验收报告。输出 snapshot 和 validation_evidence，可用于 batch.verify 和 record resumed；不再次写入。完整则复用原 CSV，用户解决阻塞且明确要求恢复后才 record resumed；若尚未记录 append_verified，则携带同一 snapshot、规则证据和采集路径记录该事件，再继续 CLS。已开始 CLS 时先回读已有草稿和导入。

任何已尝试写入的 CLI 批次不重发；部分写入、占用、历史变化或未知结果保持现场并交接，不回滚、不补写、不转 UI。即使返回全空，客户端仍不能推断前一次请求已结束。未尝试的批次只有基线、规则和获批版本完全一致才可继续。旧 UI 批次保留原事件/证据，不移除 api-plan 或改写 manifest 绕过守卫。

## 发布完整包（维护者）

```text
<仓库>/skill/assets/dependencies/python/python.exe -B <仓库>/dev/package_skill.py --output <新交付包.zip>
```

也可直接压缩整个 skill 文件夹，排除 `.state` 和缓存。发布工具只校验及打包已有依赖，不下载、不安装、不更新锁文件；ZIP 保留 Python、npm、CLI、Node 及传递依赖许可证，不包含批次、个人凭据或浏览器会话。依赖准备工具及测试仅在仓库 dev/ 中维护，不进入 skill。源码与发布包均不替用户发起在线测试。
