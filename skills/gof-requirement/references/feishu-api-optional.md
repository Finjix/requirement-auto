# 飞书官方 API 实验参考（当前停用）

用户当前不希望申请飞书 API 审批，因此本方案不是默认流程，也不是运行依赖。默认流程使用[飞书浏览器操作](browser-workflow.md)和[CLS 接口](api-workflow.md)。不要执行本文件的配置、授权或在线命令；不要借用其他应用、身份或私有接口规避审批。

这里只保留此前未完成的实现设计。`feishu_api.py` 的在线入口已停用，没有命令行或环境变量开关。以后用户明确要求恢复官方 API 方案时，先重新评估应用权限、授权和隔离验证，并经代码修改恢复入口；仍须取得具体在线计划授权。未完成授权、未验证防覆盖行为，不能宣称可安全追加。

## 飞书官方 CLI

默认可执行文件：`<用户目录>/.codex/tools/lark-cli/1.0.98/lark-cli.exe`；其他环境用 `feishu_api.py --cli <绝对路径>` 指定相同版本。使用 bundled Python。所有业务命令固定 `--profile gof-requirement --as user`，不影响其他 CLI profile，不切换 bot 绕过访问限制。版本升级后重新校验，不自动更新。

先运行 `feishu_api.py doctor`。浏览器登录不等于官方 API OAuth 授权。首次配置专用应用由用户在官方页面完成：

```text
lark-cli config init --new --name gof-requirement
lark-cli --profile gof-requirement auth login --scope "wiki:wiki:readonly sheets:spreadsheet:readonly sheets:spreadsheet:read sheets:spreadsheet:write_only sheets:spreadsheet drive:export:readonly docx:document:readonly" --no-wait --json
```

只有专用 profile 不存在时才初始化；已经配置则复用，不覆盖或清除既有 CLI 应用。初始化与授权链接只在 Codex 内置浏览器打开，用户完成登录及授权；不得代点扩权确认。记录授权状态而非 app secret、access/refresh token。凭据由官方 CLI 管理；不读取 CLI 凭据文件，不传入命令参数、批次或日志。账号、scope 或文档权限不足时停止，不能直接降级为无保护写入。创建隔离安全验证表还需要 `sheets:spreadsheet:create`，须在在线验证计划和授权中明确，正常追加不创建工作簿。

### 快照、计划、追加

```text
python feishu_api.py snapshot --output <新快照.xlsx>
python feishu_api.py plan --request request.json --snapshot <快照.xlsx> --current-sheet <原当前表名>
python feishu_api.py prepare --plan approved-api-plan.json --snapshot <最新快照.xlsx> --workspace <工作区>
python feishu_api.py append --batch <批次目录> --receipt <已验证的安全记录.json>
python feishu_api.py document --url <本次脚本文档链接>
```

`plan` 只打印 JSON，不写文件；包含原 `batch_plan` 和独立 `api_plan`。用户确认后才保存整个 JSON。API 计划补充真实 sheet ID、版本、全工作簿下拉规则、原颜色和实际模式；不能使用旧 XLSX 推测多选属性。展示原规则加本批缺项后的最终选项，供应商可以是多选。

`prepare` 重算并比较两个计划，保存不可变 `api-plan.json` 并纳入批次文件摘要，兼容旧批次。`append` 要求安全记录、当前用户登录、目标节点对应 token、完整 fresh XLSX 与获批基线一致、全工作簿规则及版本未变。编号和隐藏列仍由原保护脚本扫描。范围或版本改变时更新计划并等待用户重新确认，不静默改号。

实际写入是官方 `+cells-set --writes - --allow-overwrite=false`；每个区域也固定 `allow_overwrite:false`。JSON 通过 stdin 发送，避免 Windows 命令长度和转义问题。仅写有批准值的列，名称使用 `formula`；多选值使用 `multiple_values`。每列精确矩形，未填写列不发送 null 或清空。下拉规则随本批新增单元格写入，完整保留原选项、颜色及模式；不调用整列更新、清除验证或历史规则更新。版本号不是服务端锁，脚本不能替代飞书权限隔离。

写后重新导出 XLSX，回读完整规则，生成 `rule-proof.json`；`batch.verify` 同时比较历史值/公式/样式和 API 历史规则，包括颜色、多选及范围外规则。XLSX 中存在但错误的规则仍拒绝；只有遗漏的新增规则可由当前快照绑定的 API 证据补充。`api_validated_ranges` 明示 API 验证范围。

输出位于本批 `api-attempt-*`：新快照、写入矩阵、规则证明和请求耗时摘要。部分成功、超时、未知结果或规则变化会记录 blocked，停止 CLS，不重发、不回滚、不转 UI 重做。完整回读后才记录 append_verified；代理仍需打开本批首尾行保存截图。

### 隔离安全验证

先展示并取得在线验证计划授权：创建一个新的 `GOFCN_API_SAFETY_*` 工作簿；仅在这个新工作簿写入哨兵和返回空字符串的公式，再用防覆盖参数尝试写入已占用目标并回读。不碰进度表旧格，不删除验证表。

```text
python feishu_api.py probe --receipt <新的安全记录.json>
```

只有服务端明确拒绝占用写入、每次回读原值和公式完整保留，才生成记录。网络失败、权限失败不能作为防覆盖成功。记录绑定 CLI 版本和测试进度表 token。未通过时保持追加禁用，不人工制作通过记录。并发变化/部分成功的恢复路径另由本地模拟测试覆盖，不宣称 probe 建立了全局锁。
