# CLS 浏览器会话读取

浏览器只用于取得正常 CLS 登录会话及执行受限适配器的同源 HTTP。飞书业务全部走包内 CLI；CLS 不通过 UI 填写、导入、保存或截图验收。

使用 `mcp__cua_repl` 的内置浏览器 `iab`，初始化和受支持 CDP API 以当次工具文档为准。只操作 `https://creative.centurygames.cn` 的普通页面。未登录时由用户完成正常网页登录，不代填密码、不自动完成 SSO 授权。

通过 Network 观察普通页面请求中的 Authorization，只保留在 REPL 内存。禁止导出 Cookie、从 localStorage/隐藏 store/凭据文件取值，禁止打印完整 Network 事件、认证头或包含令牌的执行表达式。取得会话后关闭 Network 观察；结束时清空认证及事件变量。

用 [CLS 接口参考](api-workflow.md) 中的局部 module 包装加载受限适配器。仅返回脱敏 catalog 和验收 receipt；不保存带认证信息的脚本表达式。跨 tab 后重新确认 CLS origin。登录失效时停止，由用户正常重新登录；不切换其他浏览器或通过 API Key 绕过权限。

只读调查确认：CLS 正常登录跳至 DSC Admin，公司 SSO 支持网页登录。公开前端未提供已验证的 CLI/device flow/localhost 回调支持，因此本 skill 不实现替代登录。未来需有权访问的正式接入文档和批准配置再评估。
