# CLS 接口操作参考

飞书读取、导出、追加和下拉设置使用[飞书 SDK 桥](feishu-sdk-workflow.md)。本参考仅用于 CLS 接口；登录见[CLS 登录与会话](cls-session.md)，之后全部是 `gof.mjs cls` 发出的 HTTP 请求，不通过 UI 处理业务，不要求截图。素材开放 API、API Key、视频上传和发布不属于本技能。创建/安装技能不等于批准在线测试或业务写入；每次业务写入仍须完整计划获批。

## 当前验证状态

- 飞书统一使用插件内的 SDK 桥（`server/dist/bridge.mjs`，版本 `feishu-sdk-bridge/1`）；本地测试及离线打包不等于授权或服务端防覆盖验证。未通过隔离探测时不能进行业务追加，不提供 UI 兜底。
- CLS 创建草稿、multipart CSV 导入、GET 回读此前（浏览器页面内的版本）已在独立草稿 10224 成功。现在的版本由 Node 直接发送同样的请求，只带 Authorization 头：本地用模拟服务和真实 Chrome/Edge 测过，**尚未对真实 CLS 实测**。首次 `cls login` 或 `cls session` 会用 `/api/userinfo` 确认令牌在浏览器外也被接受，不被接受时停止，此时还没有任何写入。2026-10-14 回读 10224 为 status=7（已撤销），不能继续导入或用于未发布草稿验收。仅对用户批准的在线试跑创建新的独立测试草稿。
- 本地模拟测试不等于飞书服务端安全验证。桥的成功响应、前端已登录、receipt 的人工布尔声明均不能替代验收。

## CLS 接口命令

只使用 `creative.centurygames.cn`，不使用素材开放 API Key。命令都以 `node <skill>/../../server/dist/gof.mjs cls …` 运行，登录由命令自己从用户的浏览器资料里取得（见[CLS 登录与会话](cls-session.md)），令牌只在命令进程内存里。

| 命令 | 作用 |
|---|---|
| `cls login` / `cls session` | 登录并检查会话 |
| `cls catalog --output catalog.json` | 读取项目、人员、方向、任务类型等选项，保存已脱敏的目录（不含邮箱、令牌或用户全量信息） |
| `cls observe --action save_draft|import_scripts [--draft ID] --output observations.json` | 用 CLS 当前返回的事实生成 `cls-check` 要的观察（账号、建单/导入权限、草稿是否未发布且可编辑且尚无脚本）；不是人工声明 |
| `cls --batch … --group … --action … --catalog … --observations … --output …` | 离线生成并封印本组的保存/导入操作文件 |
| `cls run --batch <批次> --operation <操作文件> --output <本批新 receipt>` | 发出操作文件对应的写请求并回读，写出 receipt |
| `cls read-draft --id N` | 只读回读草稿 |
| `cls verify --batch … --operation … --draft N --output …` | 对已存在的草稿只读回读并写出 receipt（用于结果未知后的恢复） |

先只读 `cls catalog`，由 `gof.mjs cls` 匹配本次字段。供应商只接受完整名称或唯一括号别名；创意人严格对应审核人；项目按 code=GOFCN、方向按项目和名称、任务类型按实际选项匹配。不硬编码此前的 94/390/663/653。未指定的报价/币种沿用已观察到的原生默认 0/cny，并在完整计划标为系统默认，不冒充用户确认报价；其他可选字段留空，用户指定时才匹配并填写。

完整计划前执行 `gof.mjs cls --preview --request request.json --catalog catalog.json`。只输出本次每组拟用字段和 ID、创意人及系统默认值，不创建工单或操作文件；可选字段、匹配歧义和报价/日期问题必须在这里解决，不能延后到执行阶段。

每组的顺序：

1. 进度表已完整验证后 `gof.mjs batch record --step cls_started --group 01`。
2. `cls observe --action save_draft --output observations.json`，再生成保存操作：`gof.mjs cls --batch <批次> --group 01 --action save_draft --catalog catalog.json --observations observations.json --output <批次>/save-operation.json`。
3. 请求前 `record --step cls_api_attempt --group 01 --evidence attempt.json`。attempt.json 包含 action、operation_id 和 observations。此记录禁止跨会话重复执行同一动作；`cls run` 没有这条记录就拒绝发送。
4. `cls run --batch <批次> --operation <批次>/save-operation.json --output <批次>/save-receipt.json`。它重新检查账号和权限，POST `/api/workflow/script/save` 固定 status=-2，不传既有 id；随后 GET 回读，写出 receipt，并从草稿 ID 得到真实入口 URL，无需打开业务页或截图。发送前会在批次目录写一个 `cls-sent-*.json` 标记，同一操作文件不会再次发送写请求。
5. `record draft_saved`，evidence 带 confirmed/unpublished、transport=cls_api、draft_id、真实 URL、operation 文件和 receipt 文件，及接口实际返回的 requirement_number（如有）。脚本重新验收所有字段和尝试顺序；缺少或不符的回读不能用成功布尔值代替。
6. `cls observe --action import_scripts --draft <ID> --output observations-import.json`，生成 `import_scripts` 操作（来自同一批 CSV 和已记录草稿 ID）。记录新 cls_api_attempt，再 `cls run`。导入使用 multipart 字段 script_id/file/user_id。
7. 验收整组数量、顺序、名称、创意人、首行链接／其余“同上”和固定标签，确认 parent.status=-2。保存 receipt 后 record scripts_imported，evidence 加 quantity/names。记录实际脚本 ID，最后生成 message 和本地 report，不要求截图。

适配器只返回成功业务码的请求摘要及必要业务字段，不返回认证头。HTTP 200 仍检查 code=0。它不提供发布、状态变更、删除、更新旧脚本、附件或素材上传方法，路径白名单之外的请求在发出前就被拒绝。导入前草稿必须属于当前账号、外包需求、无既有脚本；已有内容或结果不明时先核对，不重复导入。

### 中断恢复

写请求不会自动重试。已有 cls_api_attempt 和 `cls-sent-*.json` 标记阻止再次发送。写请求结果未知时 `cls run` 返回 `unknown_result:true`，并带上能确定的 `draft_id` 和 `operation_id`。优先按已知 draft_id 运行 `cls read-draft --id N`；创建超时未拿到 ID 时，由用户提供可唯一核对的已有草稿入口/ID，或按已获准的只读查询定位；不能猜 ID、点击业务列表兜底或反复新建。`cls verify --operation … --draft N --output …` 生成只读回读 receipt，复用原操作文件及事件；blocked 状态仍须用户解决问题并明确要求恢复后才 record resumed。飞书恢复走 SDK 桥 fresh XLSX 及当前规则证明，不能删除 api-plan、改写清单或切换 UI 重做。

部分脚本导入保留现状交付，不补写或覆盖；查不到或无法唯一定位草稿时停止。API 结果未知时不能切换 UI 重做同一阶段。成功响应或代理写入的布尔字段不能单独证明完整验收。历史 UI 批次的截图证据保持原样读取；新的 CLS API receipt 不依赖截图。

## 交付与耗时

交付测试进度表及范围、实际草稿入口和可复制群消息。CSV、接口回读及报告保留在系统 temp，供技能内部使用和恢复，不自动清理，不默认展示目录或文件链接；用户明确索取时再提供。使用系统实际返回的 GOFCN 需求编号；缺失时保留占位符并提示发布后补齐。无论有无编号，都不得说已发布。内部报告保留每个阶段证据时间，不冒充重新查询线上当前状态。

请求摘要保存路径、HTTP/业务状态、耗时；只读与写入分开。完整批次记录阶段总耗时和调用次数，与同等数量的旧 UI 流程比较后再报告速度，不能把模拟测试耗时当线上速度。尚未授权、未实测的步骤明确标记。
