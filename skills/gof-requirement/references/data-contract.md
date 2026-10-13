# 数据契约与辅助命令

`scripts/batch.py` 无网络功能、不写在线表、不修改输入 XLSX；仅用标准 Python 和 `openpyxl`。通过 `load_workspace_dependencies` 定位 bundled Python。失败输出 JSON `status=blocked` 并非零退出。

## 请求

自然语言由 Codex 解释，程序不猜业务信息。以下为完整信息示例，供应商、创意人、链接和 CLS 字段必须来自当次澄清：

```json
{
  "worksheet": "26年1月-GOFCN",
  "groups": [{
    "quantity": 60,
    "topic": "多明星04_2min",
    "primary_tag": "多明星04",
    "secondary_tag": "2min",
    "creative_form": "混剪",
    "keyword": "关键词",
    "client": "",
    "supplier": "丁杰",
    "creator": "张天伟",
    "script_url": "https://centurygames.feishu.cn/wiki/用户确认的实际节点",
    "brief": "许君聪、吴樾、曹云金、林子聪，2min，总计60条。",
    "cls": {
      "direction": "2D剪辑",
      "task_type": "视频",
      "requirement_name": "多明星04_2min_混剪_60条"
    }
  }]
}
```

`worksheet` 可省略，`--current-sheet` 传本次检查前实际表名；两者均无时按年月选择结构正确的最新 GOFCN 表，歧义则失败。每组是一个 CSV/CLS 子批次，至少按供应商、题材分组。

quantity 为正整数。topic、标签、形式、供应商、创意人、脚本链接、brief、cls 三个字段必填；client 必须显式提供，可留空。keyword 默认“关键词”。可选进度字段：`creative_expression`、`creative_batch`、`head_reference`、`creative_reference`，缺省为空。可选 CLS：`subject`、`department`、`market_contact`、`currency`、`quotation`、`expected_completion`、`storyboard_time`、`first_draft_time`、`final_cut_time`；未给出不猜测。

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

CSV 为 UTF-8 BOM、CRLF，严格三列表头：脚本名称、脚本内容、创意标签；每组首行当前链接，其余“同上”；标签固定为 `玩法卖点（单选，必选）/展示向/展示向`。`assets/original-template.csv` 仅参考，**禁止直接上传**；模板当前本地名称为 `D:/创意脚本9.21潘越.csv`，与之前 60 条模板结构和内容一致。

preflight 只在无写入尝试时允许通过。verify 返回 complete（本批完整、历史未变且下拉有效）、not_applied（未出现本批内容，不代表可自动重试）、partial（部分出现，停止）、conflict（历史变化、字段错误或计划外新增，停止）。XLSX 无法表达飞书协同锁/所有下拉颜色，必须另做 UI 检查。

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

resume.json 需 confirmed=true、reason；若已开始 CLS，另需 cls_reconciled=true（已通过 UI 核对现有草稿/导入，不是推测）。仅允许完整追加，或完全没有追加尝试且基线未变的批次恢复。部分写入、冲突、已尝试但看似未写入都不能借此重贴。

恢复前读 status 与现有页面；完整批次复用 CSV，部分批次不自动补写。素材编号、plan_id、草稿内部 ID 不能推导正式需求编号。用户后续提供实际编号可 record requirement_number，更新群消息，不代发。
