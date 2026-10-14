# CLS 接口操作参考

飞书读取、导出、追加和下拉设置使用[包内飞书 CLI](feishu-cli-workflow.md)。本参考仅用于 CLS 已登录会话接口；浏览器保留[正常登录与会话观察](cls-session.md)及受限适配器同源 HTTP，不通过 UI 处理业务，不要求截图。素材开放 API、API Key、视频上传和发布不属于本技能。创建/安装技能不等于批准在线测试或业务写入；每次业务写入仍须完整计划获批。

## 当前验证状态

- 飞书统一使用固定版本的包内 CLI；本地测试及离线打包不等于授权或服务端防覆盖验证。未通过隔离探测时不能进行业务追加，不提供 UI 兜底。
- CLS 创建草稿、multipart CSV 导入、GET 回读此前已在独立草稿 10224 成功；适配器继续使用这些接口，代码更改需经本地测试和只读回读。2026-10-14 回读 10224 为 status=7（已撤销），不能继续导入或用于未发布草稿验收。仅对用户批准的在线试跑创建新的独立测试草稿。
- 本地模拟测试不等于飞书服务端安全验证。CLI 成功响应、前端已登录、receipt 的人工布尔声明均不能替代验收。

## CLS 已登录会话

只使用 `creative.centurygames.cn`。不使用素材开放 API Key。通过 `mcp__cua_repl` 的受支持 CDP 能力观察普通页面请求中的 Authorization，保持在 REPL 内存。禁止从 localStorage、Cookie 导出、隐藏 store 或凭据文件取值；禁止打印完整 Network 事件、请求头或含认证信息的执行表达式。捕获后关闭 Network 观察；结束清空认证变量及包含头的事件变量。

`scripts/cls_api.js` 导出 `createClsAdapter`，提供 `readCatalog`、`readDraft`、`createDraft`、`importScripts`、`verify`。在同源 Runtime.evaluate 中用局部 module 包装载入源码，避免改变应用全局状态：

```javascript
// source 为本地 cls_api.js；authorization 来自已观察的请求，仅存内存。
// operation 为 cls_api.py 生成的本组 JSON；不要把执行表达式写入文件。
const expression = `(async()=>{
  const module={exports:{}};
  ${source}
  const api=module.exports.createClsAdapter({origin:location.origin,
    authorization:${JSON.stringify(authorization)}, fetch:(...args)=>fetch(...args), crypto});
  return await api.readCatalog();
})()`;
const response = await cdp.send('Runtime.evaluate', {
  expression, awaitPromise:true, returnByValue:true
});
```

先只读 `readCatalog`，保存已脱敏 catalog（不含邮箱、令牌或用户全量信息），由 `cls_api.py` 匹配本次字段。供应商只接受完整名称或唯一括号别名；创意人严格对应审核人；项目按 code=GOFCN、方向按项目和名称、任务类型按实际选项匹配。不硬编码此前的 94/390/663/653。未指定的报价/币种沿用已观察到的原生默认 0/cny，并在完整计划标为系统默认，不冒充用户确认报价；其他可选字段留空，用户指定时才匹配并填写。

完整计划前执行 `cls_api.py --preview --request request.json --catalog catalog.json`。只输出本次每组拟用字段和 ID、创意人及系统默认值，不创建工单或操作文件；可选字段、匹配歧义和报价/日期问题必须在这里解决，不能延后到执行阶段。

每组的顺序：

1. 进度表已完整验证后 `batch.py record --step cls_started --group 01`。
2. 生成保存操作：`cls_api.py --batch <批次> --group 01 --action save_draft --catalog catalog.json --observations observations.json --output <批次>/save-operation.json`。observations 采用原 cls-check 条件；必须来自真实观察。
3. 请求前 `record --step cls_api_attempt --group 01 --evidence attempt.json`。attempt.json 包含 action、operation_id 和 observations。此记录禁止跨会话重复执行同一动作。
4. 同源调用 `createDraft(operation)`。它重新检查账号和权限，POST `/api/workflow/script/save` 固定 status=-2，不传既有 id；随后 GET 回读。保存返回 receipt 到本批新文件，从草稿 ID 得到真实入口 URL，无需打开业务页或截图。
5. `record draft_saved`，evidence 带 confirmed/unpublished、transport=cls_api、draft_id、真实 URL、operation 文件和 receipt 文件，及接口实际返回的 requirement_number（如有）。脚本重新验收所有字段和尝试顺序；缺少或不符的回读不能用成功布尔值代替。
6. 生成 `import_scripts` 操作，来自同一批 CSV 和已记录草稿 ID，核对 import_enabled、import_would_publish=false、未发布及可编辑状态。记录新 cls_api_attempt，再调用 `importScripts(operation)`。使用 multipart 字段 script_id/file/user_id；不要手工设置 multipart Content-Type。
7. 验收整组数量、顺序、名称、创意人、首行链接／其余“同上”和固定标签，确认 parent.status=-2。保存 receipt 后 record scripts_imported，evidence 加 quantity/names。记录实际脚本 ID，最后生成 message 和本地 report，不要求截图。

适配器只返回成功业务码的请求摘要及必要业务字段，不返回认证头。HTTP 200 仍检查 code=0。它不提供发布、状态变更、删除、更新旧脚本、附件或素材上传方法。导入前草稿必须属于当前账号、外包需求、无既有脚本；已有内容或结果不明时先核对，不重复导入。

### 中断恢复

写请求不会自动重试。已有 cls_api_attempt 阻止再次发送。优先按已知 draft_id 调用 readDraft；创建超时未拿到 ID 时，由用户提供可唯一核对的已有草稿入口/ID，或按已获准的只读查询定位；不能猜 ID、点击业务列表兜底或反复新建。`verify(operation,id)` 生成只读回读 receipt，复用原操作文件及事件；blocked 状态仍须用户解决问题并明确要求恢复后才 record resumed。飞书恢复走 CLI fresh XLSX 及当前规则证明，不能删除 api-plan、改写清单或切换 UI 重做。

部分脚本导入保留现状交付，不补写或覆盖；查不到或无法唯一定位草稿时停止。API 结果未知时不能切换 UI 重做同一阶段。成功响应或代理写入的布尔字段不能单独证明完整验收。历史 UI 批次的截图证据保持原样读取；新的 CLS API receipt 不依赖截图。

## 交付与耗时

交付测试进度表及范围、实际草稿入口和可复制群消息。CSV、接口回读及报告保留在系统 temp，供技能内部使用和恢复，不自动清理，不默认展示目录或文件链接；用户明确索取时再提供。使用系统实际返回的 GOFCN 需求编号；缺失时保留占位符并提示发布后补齐。无论有无编号，都不得说已发布。内部报告保留每个阶段证据时间，不冒充重新查询线上当前状态。

请求摘要保存路径、HTTP/业务状态、耗时；只读与写入分开。完整批次记录阶段总耗时和调用次数，与同等数量的旧 UI 流程比较后再报告速度，不能把模拟测试耗时当线上速度。尚未授权、未实测的步骤明确标记。
