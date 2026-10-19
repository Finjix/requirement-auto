# 接入 lark-agent

本文写给日后改 lark-agent 的人。**本次没有改 lark-agent 的任何文件**；下面每一条都对应 lark-agent 里的具体位置，并且标明哪些是在 Codex 0.163.0（lark-agent 现在锁定的版本）上实测过的。

## 要解决的问题

lark-agent 给每个飞书用户一个 `user/<显示名>/`，用 Codex SDK 为每条输入起一个 `codex exec`。本插件需要两样东西才能按用户隔离：

1. **知道这是谁的目录**：飞书登录和批次放在 `user/<显示名>/requirement-auto/`。
2. **知道用哪个飞书应用**：复用机器人应用的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。

## 为什么不能只靠插件自带的 MCP 声明

实测（Codex 0.163.0，`codex app-server` 的 `mcpServerStatus/list` 和 `mcpServer/tool/call`）：

| 项目 | 结果 |
|---|---|
| 插件 `mcp.json` 里的 stdio 服务能起来、工具可调用 | 是（`pluginId: requirement-auto@requirement-auto`） |
| 服务进程收到 Codex 进程的环境变量 | **否**。只有 `PATH`、`PLUGIN_ROOT`、`PLUGIN_DATA` 和 `mcp.json` 里静态写的 `env` |
| `mcp.json` 的 `env` 里写 `${LARK_AGENT_USER_DIR}` | **不展开**，原样字符串；只有 `${PLUGIN_ROOT}` 会展开 |
| `mcp.json` 里写 `env_vars` | **整个服务被静默丢弃**（schema 禁止多余键） |
| 服务的工作目录 | 插件安装目录，不是用户的 workspace |
| 工具调用的 `_meta` | 只有 `progressToken` 和 `threadId`，没有 cwd 和用户 |
| 在 **config** 里注册的服务用 `env_vars` 转发环境变量 | **可以**（`mcp_servers.<名>.env_vars`） |
| 用 `plugins."<id>".mcp_servers.<名>.enabled=false` 关掉插件自带的服务 | **可以** |

结论：插件自带的 `feishu-auth` 只适合单机（用 `PLUGIN_DATA`）。给 lark-agent 用时，**由宿主每轮在配置里注册一个同名服务**，把插件自带的那个关掉。这样用户目录由宿主决定，模型和工具参数碰不到。

## lark-agent 要改的地方

### 1. 打开插件特性并安装插件（`src/codex/runner.ts`、`start.cmd` / `doctor`）

`codexConfig()` 里把 `features.plugins` 改成 `true`；`apps`、`browser_use`、`in_app_browser`、`computer_use`、`memories` 保持 `false`。

安装对 `CODEX_HOME=<项目>/.codex` 做一次，可重复执行（可以放在 `doctor` 或启动前，用现有的 `codexCli()`）：

```bash
start.cmd codex plugin marketplace add D:\project\requirement-auto
start.cmd codex plugin add requirement-auto@requirement-auto --json     # 输出里的 installedPath 就是已装副本
```

插件改过之后：`plugin remove requirement-auto@requirement-auto` 再 `add`（实测可用）。已装副本在 `.codex/plugins/cache/requirement-auto/requirement-auto/<version>/`。

安装后应能看到技能 `requirement-auto:gof-requirement`，`plugin list --json` 的 `installed` 里有它（实测用的是全新的 CODEX_HOME；lark-agent 的 `.codex` 里如果已有别的插件，也会一起列出，装之前先看一眼）。

### 2. 每轮注入用户环境并注册 MCP（`src/codex/runner.ts` 的 `codexEnv()` / `CodexRunner.run()`）

`TurnJob` 增加 `userDir`（`user/<名>`，即 `userDirectory(store, session)`，**不是** `workspace`）和 `openId`（`session.user_id`，是飞书 Open ID；同一个应用下用户授权得到的 Open ID 与机器人看到的相同）。

```ts
const PLUGIN = 'requirement-auto@requirement-auto';

/** 每轮的环境：用户目录、用户 Open ID、机器人应用。env_vars 只转发名字，密钥不出现在命令行上。 */
export function codexEnv(user?: { userDir: string; openId: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !WITHHELD.has(key.toUpperCase())) env[key] = value;
  return {
    ...env, CODEX_HOME: config.codexHome,
    ...(user ? {
      LARK_AGENT_USER_DIR: user.userDir, LARK_AGENT_USER_OPEN_ID: user.openId,
      FEISHU_APP_ID: config.FEISHU_APP_ID, FEISHU_APP_SECRET: config.FEISHU_APP_SECRET,   // 按你的选择复用机器人应用
    } : {}),
  };
}

export function pluginConfig(installedPath: string): NonNullable<CodexOptions['config']> {
  return {
    // 注意键里的引号：SDK 展平配置时不会给含 @ 的路径段加引号，必须自己写进键里。
    plugins: { [`"${PLUGIN}"`]: { mcp_servers: { 'feishu-auth': { enabled: false } } } },
    mcp_servers: { 'feishu-auth': {
      command: 'node', args: [path.join(installedPath, 'server', 'dist', 'mcp.mjs')],
      env_vars: ['LARK_AGENT_USER_DIR', 'LARK_AGENT_USER_OPEN_ID', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    } },
  };
}
```

`run()` 里 `new Codex({ env: codexEnv(job.user), config: { ...codexConfig(), ...pluginConfig(installedPath) } })`。上面的 `-c` 组合（`plugins."requirement-auto@requirement-auto".mcp_servers.feishu-auth.enabled=false` 加 `mcp_servers.feishu-auth.{command,args,env_vars}`）已在 Codex 0.163.0 的 app-server 上实测：只剩一个 `feishu-auth` 服务，工具返回 `storage: "host"`、`app_configured: true`。

同一个环境也会传给 Codex 的 shell 工具，所以技能的 Python 脚本（`feishu_api.py`）直接用得到 `LARK_AGENT_USER_DIR` 等变量，批次也落在用户目录。按 Codex 文档，shell 工具默认保留名字里带 KEY/SECRET/TOKEN 的变量（`shell_environment_policy.ignore_default_excludes` 默认 true），我没有在真实任务里验证；如果以后改了这个策略，要保证这四个变量仍然透传。

调用处 `src/tasks/service.ts`：任务开始时用该用户的目录和 Open ID 填 `TurnJob`。

### 3. 机器人密钥的代价（`WITHHELD`）

`WITHHELD` 现在把 `FEISHU_APP_SECRET` 挡在 Codex 进程之外。复用机器人应用意味着每轮要把它交给 Codex（上面 `codexEnv(user)` 只在有用户时加回）。后果：能和机器人对话的人，理论上能让 Codex 读到机器人密钥。README 里 lark-agent 已经声明 Codex 能读 `.env`，这里没有新增一类风险，但要知道。想收紧就给设备授权单独建一个应用，把 `FEISHU_APP_ID/SECRET` 换成它的，其余不用改。

### 4. 飞书应用权限（`docs/feishu.md`）

应用权限的 `user` 列表现在是空的。补上：

```json
"user": ["wiki:wiki:readonly", "sheets:spreadsheet:readonly", "sheets:spreadsheet:read", "sheets:spreadsheet:write_only",
         "sheets:spreadsheet", "drive:export:readonly", "docx:document:readonly", "offline_access"]
```

隔离探测另需 `sheets:spreadsheet:create`。发布新版本后，用户首次授权会看到这些权限。设备授权要求应用允许用户身份授权；`feishu_auth_login` 报 `config`（`invalid_client`）时先查应用凭证，再查这一项。**此项我没有在真实应用上验证。**

### 5. 自动清理（`src/maintenance.ts`）

清理只动 `user/<名>/workspace`，`user/<名>/requirement-auto/` 不会被清。建议：`batches/` 随 `RETENTION_DAYS` 清理；**`feishu/` 永远不按时间清**（登录文件的修改时间每次续期都会更新，但用户几天不来是正常的）。

### 6. 可选：登录卡片

lark-agent 可以不依赖模型转述，直接识别 `feishu_auth_login` 的工具调用结果，把授权链接渲染成卡片按钮。工具结果的 `structuredContent` 里有 `verification_uri_complete`、`user_code`、`expires_in_s`。

## 隔离模型（写给评审的人）

| 防住的 | 怎么防 |
|---|---|
| 用户 A 的登录被用户 B 使用 | 每个 Codex 进程的数据目录由宿主环境决定；MCP 工具和桥命令都没有用户参数 |
| A 把授权链接发给 B，B 点了确认 | 宿主传 `LARK_AGENT_USER_OPEN_ID`，授权账号不一致会被拒绝，令牌不落盘 |
| 令牌出现在对话、日志、批次记录里 | 工具结果和桥输出只含状态；错误文本统一去掉令牌和应用密钥 |
| 两个进程同时续期把一次性刷新令牌用坏 | 续期在文件锁里做，锁内重读 |
| 批次落进共享的系统 temp | `LARK_AGENT_USER_DIR` 存在时批次根目录改为用户目录 |

| **没防住的** | 原因 |
|---|---|
| 被提示词注入的模型主动 `cat user/别人/requirement-auto/feishu/auth.json` | Codex 是 `danger-full-access`，同一个 Windows 账号，文件权限挡不住；lark-agent 的 README 也是这么声明的。要真隔离，得给每个用户单独的系统账号或沙箱 |
| 读取机器人 App Secret | 见第 3 条 |

## 上线前的验收

1. 在测试机上按第 1、2 步接好，`doctor` 通过。
2. 用两个飞书账号分别发"登录飞书"：各自拿到各自的链接；用 A 的链接让 B 确认，应被拒绝。
3. 确认 `user/<A>/requirement-auto/feishu/auth.json` 与 `user/<B>/...` 是两个文件，内容里的 `open_id` 不同。
4. 按 [README](../README.md) 的"还没做"清单完成隔离探测，再走测试进度表的全流程。
