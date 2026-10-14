# requirement-auto

GOFCN 素材需求自动化智能体技能（Agent Skill），通过包内飞书 CLI 追加创意进度表并验收，生成 CSV、保存 CLS 未发布草稿、导入脚本和生成可复制群消息。

## 目录与发布

- `skill/`：完整技能，包含 `SKILL.md`、`agents/`、`scripts/`、`references/` 和 `assets/`（含运行依赖）。
  - `scripts/batch.py`：离线批次处理与验收；`scripts/feishu_api.py`：飞书操作；`scripts/cls_api.py` 与 `cls_api.js`：CLS 请求及回读校验。
  - `scripts/skill_runtime.py doctor`：运行时自检。
  - `references/`：按流程查阅的说明文档；`assets/`：CSV 模板与 `dependencies/` 便携运行依赖。
- `dev/`：本地开发专用目录，包含测试、依赖准备及打包工具，不进入发布包。

运行时直接使用包内 Python、Node 和飞书 CLI，无需安装依赖或修改系统 PATH。首次使用飞书和 CLS 仍需正常配置、登录及授权。

发布时直接将整个 `skill` 文件夹压缩为 ZIP，再按需改名；不包含 `.state/`、缓存和个人凭据。也可运行 `skill/assets/dependencies/python/python.exe -B dev/package_skill.py --output dev/dist/requirement-auto-windows-x64.zip`，离线校验后打包并生成 SHA-256。

批次中间文件默认保存在系统临时目录，由技能内部使用，不自动清理。正常交付展示业务结果、CLS 草稿入口和可复制群消息。

测试：`skill/assets/dependencies/python/python.exe -B dev/run_tests.py`。新增开发工具和测试统一放入 `dev/`，不要在仓库根目录或 `skill/` 中建立开发工具、测试或临时产物目录。技能运行所需的脚本、资源和依赖保留在 `skill/`。

## 依赖版本

运行平台：64 位 Windows。

| 依赖 | 版本 |
|---|---|
| Python | 3.13.15 |
| openpyxl | 3.1.5 |
| et_xmlfile | 2.0.0 |
| Node.js | 24.21.0 |
| 飞书 CLI（@larksuite/cli） | 1.0.98 |

完整依赖、固定版本锁文件、文件摘要及许可证均保留在 `skill/assets/dependencies/`。
