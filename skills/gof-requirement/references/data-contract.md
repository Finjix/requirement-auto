# 数据契约与辅助命令

`scripts/batch.py` 无网络功能、不写在线表、不修改输入 XLSX；仅用标准 Python 和 `openpyxl`。通过 `load_workspace_dependencies` 定位 bundled Python。失败输出 JSON `status=blocked` 并非零退出。

默认飞书路径是[浏览器操作参考](browser-workflow.md)：通过网页下载快照并粘贴 batch.py 生成的 TSV，不依赖 CLI 配置或官方 API 授权。CLS 见[接口操作参考](api-workflow.md)；`cls_api.py` 仅离线生成/检查请求，`cls_api.js` 在当前 CLS 同源会话执行限定 HTTP。`feishu_api.py` 的在线入口当前停用，但离线摘要和既有 API 批次校验仍保留。新 UI 批次不创建 api-plan.json；既有清单中的不可变 api-plan.json 不能移除来绕过保护。`cls-check --observations` 与原 --ui 二选一，表示同样的真实观察条件。

API 操作前追加 cls_api_attempt（action=save_draft/import_scripts、operation_id、observations），同组同动作已有尝试即拒绝再次请求。API draft_saved/scripts_imported 证据额外要求 transport=cls_api、draft_id、operation/receipt 的本批绝对路径；记录时重新核对完整回读及原批需求。截图仍必需。飞书 verify 的 API 证据为 `{ "transport": "feishu_api", "proof": "<本批规则证明绝对路径>" }`，并非自填成功布尔值；record append_verified/resumed 时置于 evidence.validations。

## 请求

用户发起任务默认完成进度表、CSV、CLS 未发布草稿、允许的脚本导入及可复制群消息，不询问处理范围。自然语言由 Codex 解释，一二级标签根据素材名称推理；供应商、审核人、提炼词和创意形式来自用户。以下为用户主动明确限定“仅进度表和 CSV”时的最小请求示例，不是默认全流程的完整请求（数量来自当次需求）：

```json
{
  "worksheet": "26年1月-GOFCN",
  "groups": [{
    "quantity": 60,
    "material_name": "多明星04_2min_混剪_关键词",
    "creative_form": "混剪",
    "keyword": "关键词",
    "supplier": "丁杰",
    "reviewer": "张天伟",
    "script_url": "https://centurygames.feishu.cn/wiki/CurrentScript123"
  }]
}
```

`worksheet` 可省略，`--current-sheet` 传本次检查前实际表名；两者均无时按年月选择结构正确的最新 GOFCN 表，歧义则失败。每组是一个 CSV/CLS 子批次，至少按供应商、题材分组。

quantity 为正整数。默认全流程的必要澄清清单为八项：`keyword`（提炼词）、`material_name`（素材名称主体或带 GOFCN 编号的样例）、`creative_form`（创意形式）、`supplier`（供应商）、`reviewer`（审核人）、`script_url`（脚本内容，即 CSV 中的链接）、`cls.direction`（CLS 创意方向）、`cls.task_type`（CLS 任务类型）。后两项缺少时必须在执行计划前提问，不能根据 creative_form 擅自默认；用户主动排除建单时才仅需前六项。脚本链接须为用户本次确认的飞书文档 HTTPS 链接，不能缺省或留空；只用于 CSV，不增加进度表填写字段。没有提炼词默认值。示例中的“关键词”只是用户值示例，链接也只是格式示例，不能作为实际需求链接。

名称主体按现有公式组织，例如 `多明星04_2min_混剪_关键词`；用户给出自然语言名称时，由 Codex 根据已有命名公式整理并在计划展示。样例中的历史编号会去掉，程序统一分配连续新编号；素材编号与名称脚本编号一致。`primary_tag`、`secondary_tag` 可由 Codex 推理后传入；缺省时程序从名称中形式和提炼词之前的主体按首个下划线拆成两级标签（此例为“多明星04”和“2min”）。语义不明确时由 Codex 针对歧义澄清，不硬猜。程序校验最终公式名称与确认的名称主体一致。

`topic` 缺省从名称推导，用于 CSV 分组；传入时须与名称一致。审核人与创意人是同一人，`reviewer` 为统一人员字段，`creator` 缺省取 `reviewer`，不能传不同人员。进度表“创意者／脚本审核人”、CLS 导入创意人和群消息创意人均使用此值；用户只需提供一次审核人或创意人，由 Codex 统一映射为 reviewer，不另外澄清两者关系。`client`、`creative_expression`、`creative_batch`、`head_reference`、`creative_reference` 均留空，非空输入拒绝；其他进度字段不填写。

默认全流程必须在执行计划前一次收齐 `cls.direction`、`cls.task_type`、`cls.requirement_name`、实际页面其他必填项及需求说明，并把建单字段传入请求，沿用已确认的脚本内容链接。只有用户主动明确排除建单时 `brief`、`cls` 才可省略。导入创意人使用本组 `creator`（即 `reviewer`），直接列入完整计划，不另行澄清。可选 CLS：`subject`、`department`、`market_contact`、`currency`、`quotation`、`expected_completion`、`storyboard_time`、`first_draft_time`、`final_cut_time`；按用户需求或已给信息确定填值，未要求且非必填的明确留空，不猜测、不在执行中补问。请求包含非空 cls 时必须提供三个必填字段。程序允许用于用户明确限定的部分流程，只校验静态字段；Codex 须按默认全流程只读检查实际页面并确保完整计划覆盖全部后续输入，不能因程序允许省略 cls 就询问范围或自行省略建单。

用户回复“执行计划”后，连续执行完整计划，不再按进度表、草稿、导入等阶段索要确认。执行阶段只核对获批值与当前页面是否相符；遇到实际阻碍才停下来请求处理。若用户在原计划完成后新增建单需求，作为新增任务先澄清全部所需信息并确认单独建单计划，沿用原批 CSV，不重新运行 prepare 或重贴原批。

仅支持测试节点，不能以 request 的 target_url 临时绕过目标保护。

## 命令与输出

下述 python/batch.py 替换为实际绝对路径。observed-url 必须从当前浏览器页面读取，不能抄计划 URL。

```text
python batch.py plan --request request.json --snapshot downloaded.xlsx --observed-url <实际URL> [--current-sheet <表名>]
```

只读输出计划 JSON：plan_id、基线摘要、工作表/列映射、追加范围、行值/公式、名称和下拉选项。系统计划模式中只输出计划不写文件；用户确认后才把完整 JSON 保存为 approved-plan.json。

历史重复编号和编号/名称不一致列入 history_warnings，不修改历史数据；所有可读编号共同参与取最大值避让。若既有编号无法读取而不能证明新号无冲突则停止。

```text
python batch.py prepare --plan approved-plan.json --snapshot fresh.xlsx --observed-url <实际URL> --workspace <工作区>
python batch.py preflight --batch <批次目录> --snapshot fresh.xlsx --observed-url <实际URL>
python batch.py record --batch <批次目录> --step append_started
python batch.py verify --batch <批次目录> --snapshot after.xlsx --observed-url <实际URL>
python batch.py record --batch <批次目录> --step append_verified --snapshot after.xlsx --observed-url <实际URL>
```

prepare 重算并比较获批计划，变化则拒绝。输出 `<workspace>/outputs/gof-requirement/<plan_id>`，已有目录拒绝；含 baseline.xlsx、manifest.json、append.tsv、分组 CSV、追加式 events/*.json。脚本不存储“用户授权”标志，也不能代替真实对话授权。

append.tsv 是面向浏览器剪贴板的原始制表符矩阵：单元格直接以 TAB 分隔、行以 CRLF 分隔，不采用 CSV 引号包裹或双写引号。公式中的双引号须原样保留。单元格内部含 TAB/CR/LF 时拒绝生成；CSV 文件仍使用标准 CSV 转义。旧批次的带引号 TSV 不能直接用于公式粘贴，也不能覆盖其完整性记录；根据原获批 plan 另生成原始矩阵，并只在仍符合本批保护条件时使用。

CSV 为 UTF-8 BOM、CRLF，严格三列表头：脚本名称、脚本内容、创意标签；每组首行脚本内容填本次确认的链接，其余“同上”。缺少链接时停止计划及 CSV 生成，先澄清，不借用历史链接。标签固定为 `玩法卖点（单选，必选）/展示向/展示向`，不随进度表一二级标签变化。`assets/original-template.csv` 仅参考，**禁止直接上传**；模板当前本地名称为 `D:/创意脚本9.21潘越.csv`，与之前 60 条模板结构和内容一致。

preflight 只在无写入尝试时允许通过。verify 返回 complete（本批完整、历史未变且下拉有效）、not_applied（未出现本批内容，不代表可自动重试）、partial（部分出现，停止）、conflict（历史变化、字段错误或计划外新增，停止）。XLSX 无法表达飞书协同锁/所有下拉颜色，必须另做 UI 检查。

verify 允许飞书自动把既有筛选范围的末行延长到本批末行，但新增筛选行必须完全处于本批追加行内，列范围、起始行、筛选条件和排序配置必须不变。其他筛选变化仍为 conflict；这不授权代理修改历史筛选。

飞书可能在 XLSX 中完全省略已保存的自定义下拉规则。仅此缺漏允许使用 `verify --validation-evidence ui-validations.json` 补充实际 UI 验收；导出中存在但错误的规则、值/公式错误、历史变化仍拒绝。JSON 为数组，每项含 worksheet、精确 range、options（实际已保存完整选项）、source="custom"、mode="single"/"multiple"、confirmed=true、saved=true、reason="xlsx_omits_inline_rule"、实际测试表 url、已存在 screenshot 绝对路径及当前快照 snapshot_digest（Snapshot.fingerprint）。须先重新打开当前本批选区的数据验证对话框，核对保存的选项、模式、来源并保存截图；不能以尚未保存的输入或推测创建证据。此证据只对应当前快照，不能复用于更晚的快照。记录 append_verified/resumed 时，evidence.json 的 validations 字段携带同一数组。verify 返回 ui_validated_ranges 明示哪些范围由 UI 证据补验，不能宣称这些规则已通过 XLSX 验证。

```text
python batch.py status --batch <批次目录>
python batch.py record --batch <批次目录> --step cls_started --group 01
python batch.py cls-check --batch <批次目录> --group 01 --action save_draft --ui ui.json
python batch.py record --batch <批次目录> --step draft_saved --group 01 --evidence evidence.json
python batch.py cls-check --batch <批次目录> --group 01 --action import_scripts --ui ui.json
python batch.py record --batch <批次目录> --step scripts_imported --group 01 --evidence evidence.json
python batch.py record --batch <批次目录> --step handoff --group 01 --evidence evidence.json
python batch.py message --batch <批次目录>
```

ui.json 表示实际观察的布尔事实：logged_in、can_create、unpublished 必须 true，保存时 required_complete 必须 true；导入另需 draft_saved=true、import_enabled=true、import_would_publish=false。save_result=failure/unknown 则停止。publish 和未许可 action 永远拒绝。守卫不操纵网页、不使禁用项启用。

draft_saved evidence 必须含 confirmed=true、unpublished=true、实际 CLS url、已存在的 screenshot 绝对路径；可选 requirement_number 必须是实际读取的正式 GOFCN 编号。scripts_imported evidence 还需 quantity、names 与该组完整一致。handoff 和 blocked evidence 的 reason 必填。保存结果未知不能填 confirmed=true。

事件独占创建、不覆盖，每组 handoff 终止该组自动化。blocked 后必须等待；用户解决问题且明确要求恢复时才运行：

```text
python batch.py record --batch <批次目录> --step resumed --snapshot fresh.xlsx --observed-url <实际URL> --evidence resume.json
```

resume.json 需 confirmed=true、reason；若已开始 CLS，另需 cls_reconciled=true（已通过接口回读或实际 UI 核对现有草稿/导入，不是推测）。通常仅允许完整追加，或完全没有追加尝试且基线未变的批次恢复。对于已尝试但未生效的追加，须用户明确要求本次重试、UI 确认同步完成、最新快照 verify=not_applied 且完整语义摘要与原基线相同；resume.json 另填 retry_append=true、sync_confirmed=true。此事件只允许下一次 preflight/append_started，尝试开始后授权被消耗。复用原 CSV，不重新 prepare。部分写入、占用、历史变化或未知结果不允许重贴。证据布尔值不能代替真实用户授权和现场核验。

恢复前读 status 与现有页面；完整批次复用 CSV，部分批次不自动补写。素材编号、plan_id、草稿内部 ID 不能推导正式需求编号。用户后续提供实际编号可 record requirement_number，更新群消息，不代发。
