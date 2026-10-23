import { CellRange, columnLetter, coordOf, translateFormula } from './a1.ts';
import { fieldValues, ITEM_FIELDS, itemsOf, normalizeRequest, OPTIONAL_FIELDS, type Item } from './request.ts';
import { chooseSheet, collectIds, concatenate, FIELD_HEADERS, formulaRefs, optionsFor, REQUIRED_HEADERS, type Columns, type Snapshot } from './snapshot.ts';
import type { CellData } from './xlsx.ts';
import { digest, need, safeFilename, TARGET } from './util.ts';

export type Plan = Record<string, any>;

/**
 * The sheet's naming: GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>. 创意形式 may be empty, and SUBSTITUTE folds the "__" it
 * leaves into one "_".
 */
export function namingFormula(cols: Columns, row: number): string {
  const ref = (field: string) => coordOf(cols[field]!, row);
  return `=SUBSTITUTE(CONCATENATE("GOFCN",${ref('number')},"_",${ref('primary_tag')},"_",${ref('secondary_tag')},"_",${ref('creative_form')},"_",${ref('keyword')}),"__","_")`;
}

/**
 * The naming formula a new row gets: the nearest one above it in the 素材名称 column when it names a row the sheet's way (colleagues'
 * own spelling of it is kept, e.g. with the 客户端 cell at the end, which stays empty here), else the sheet's naming itself: colleagues
 * change the formula now and then (from row 23282 it left out 创意形式 for a while). Rows without a 创意形式 need it inside
 * SUBSTITUTE(…,"__","_"), or the name keeps an empty part.
 */
export function rowFormula(snapshot: Snapshot, sheet: string, cols: Columns, row: number, withoutForm: boolean): string {
  const own = namingFormula(cols, row);
  let above: CellData | undefined;
  for (let r = row - 1; r > 1 && !above; r--) {
    const cell = snapshot.cell(sheet, r, cols.name!);
    if (cell?.kind === 'f' && cell.value !== null) above = cell;
  }
  if (!above) return own;
  const formula = translateFormula(above.value!, above.coord, coordOf(cols.name!, row));
  // Tried on a row of five distinct values: it must give exactly what the sheet's naming gives.
  const probe: Record<string, string | number | null> = Object.fromEntries(formulaRefs(formula).map(coord => [coord, null]));
  Object.assign(probe, { [coordOf(cols.number!, row)]: 1, [coordOf(cols.primary_tag!, row)]: 'A', [coordOf(cols.secondary_tag!, row)]: 'B',
    [coordOf(cols.creative_form!, row)]: 'C', [coordOf(cols.keyword!, row)]: 'D' });
  try { if (concatenate(formula, probe) !== 'GOFCN1_A_B_C_D') return own; } catch { return own; }
  if (!withoutForm) return formula;
  probe[coordOf(cols.creative_form!, row)] = null;
  return concatenate(formula, probe) === 'GOFCN1_A_B_D' ? formula : `=SUBSTITUTE(${formula.slice(1)},"__","_")`;
}

/** How the sheet names a row, in its own words: "GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>". */
export function namingPattern(formula: string, row: number, cols: Columns): string {
  const fields = new Map(Object.entries(cols).map(([field, col]) => [coordOf(col, row), FIELD_HEADERS[field]!]));
  const shown = Object.fromEntries(formulaRefs(formula).map(coord => [coord, `<${fields.get(coord) ?? coord}>`]));
  try { return concatenate(formula, shown); } catch { return formula; }
}

/** Plans the rows to append: the next material numbers, the naming formula, the dropdown options to extend. */
export function makePlan(snapshot: Snapshot, requestInput: unknown, current?: string | null): Plan {
  const request = normalizeRequest(requestInput);
  const [sheet, tables, ignored] = chooseSheet(snapshot, request, current);
  const ws = snapshot.sheet(sheet);
  const cols = tables[sheet]!;
  need(!ws.protectedSheet, '导出工作表受保护，请核对实际编辑权限');
  const warnings: string[] = ignored.map(name => `较早的 GOFCN 工作表“${name}”表头不可用，未参与编号避让`);
  const identifiers = collectIds(snapshot, tables, warnings);
  const startNumber = [...identifiers.keys()].reduce((a, b) => Math.max(a, b), 0) + 1;
  const startRow = snapshot.last[sheet]! + 1;
  const total = request.groups.reduce((sum, g) => sum + g.quantity, 0);
  const endRow = startRow + total - 1;
  need(endRow <= 1048576, '追加超出工作表行数');
  const optionalUsed = new Set(OPTIONAL_FIELDS.filter(k => request.groups.some(g => g[k] !== '')));
  need([...optionalUsed].every(k => k in cols), '本批可选字段在工作表中没有对应列');
  const used = [...REQUIRED_HEADERS, ...optionalUsed];
  const left = Math.min(...used.map(k => cols[k]!));
  const right = Math.max(...used.map(k => cols[k]!));
  const area = new CellRange({ minCol: left, maxCol: right, minRow: startRow, maxRow: endRow });
  for (const text of ws.merges) {
    const merged = new CellRange(text);
    need(merged.maxRow < area.minRow || merged.minRow > area.maxRow || merged.maxCol < area.minCol || merged.minCol > area.maxCol,
      '追加范围与合并单元格相交');
  }
  // The API writes a column in one go: a column of some rows with a value and some without would be a write with holes.
  const forms = request.groups.flatMap(g => itemsOf(g).map(item => item.creative_form !== ''));
  need(forms.every(Boolean) || !forms.some(Boolean),
    '这一批有的行写了创意形式、有的没写（追加时一列一次写完，不能留空）：都不写创意形式、把它放在提炼词前面（素材名称不变），或分两次追加');
  const suppliers = request.groups.map(g => g.supplier !== '');
  need(suppliers.every(Boolean) || !suppliers.some(Boolean), '这一批有的需求写了设计师供应商、有的没写（追加时一列一次写完，不能留空）：分两次追加');
  const withoutForm = !forms.some(Boolean);
  const naming = namingPattern(rowFormula(snapshot, sheet, cols, startRow, withoutForm), startRow, cols);
  const rows: Plan[] = [];
  const groups: Plan[] = [];
  let cursor = 0;
  request.groups.forEach((g, offset) => {
    const index = offset + 1;
    const id = String(index).padStart(2, '0');
    const names: string[] = [];
    const groupRows: number[] = [];
    for (const item of itemsOf(g)) {
      for (let n = 0; n < item.quantity; n++) {
        const r = startRow + cursor;
        const number = startNumber + cursor;
        const values: Record<string, string | number | null> = {};
        for (let c = left; c <= right; c++) values[coordOf(c, r)] = null;
        for (const field of used) {
          if (field === 'name') continue;
          const value = (ITEM_FIELDS.includes(field) ? item[field as keyof Item] : g[field]) as string;
          values[coordOf(cols[field]!, r)] = field === 'number' ? number : (value !== '' ? value : null);
        }
        const nameCoord = coordOf(cols.name!, r);
        const formula = rowFormula(snapshot, sheet, cols, r, withoutForm);
        // The name is what the formula makes of the row; a name the request gives (a file named for its row) must come out exactly.
        const name = concatenate(formula, values);
        need(name.startsWith(`GOFCN${number}_`), '命名公式未产生正确 GOFCN 编号');
        need(item.material_name === undefined || name === `GOFCN${number}_${item.material_name}`,
          `按进度表的命名（${naming}），这一行会叫“${name}”，不是要求的“GOFCN${number}_${item.material_name}”：核对一级标签、二级标签、创意形式和提炼词`);
        need(!/[\\/]/.test(name), `素材名称“${name}”含 / 或 \\（素材名称也是 CLS 里的创意名称，那里不能有）`);
        values[nameCoord] = formula;
        rows.push({ row: r, number, name, values, group: id });
        names.push(name);
        groupRows.push(r);
        cursor++;
      }
    }
    const first = itemsOf(g)[0]!;
    const filename = `创意脚本_${[id, first.topic, first.creative_form, g.supplier].filter(Boolean).map(safeFilename).join('_')}.csv`;
    groups.push({ id, csv: filename, names, rows: groupRows, request: g });
  });
  const dropdowns: Plan[] = [];
  for (const field of ['primary_tag', 'secondary_tag', 'creative_form', 'client', 'supplier', 'creator', 'creative_expression']) {
    const wanted = fieldValues(request.groups, field);
    if (wanted.length === 0 || !(field in cols)) continue;
    const existing = optionsFor(ws, cols[field]!, startRow - 1);
    need(wanted.every(v => !v.includes(',') && !v.includes('"')), '下拉标签含逗号/引号，需人工核对规则');
    const combined = [...existing, ...wanted.filter(v => !existing.includes(v))];
    const letter = columnLetter(cols[field]!);
    dropdowns.push({ field, range: `${letter}${startRow}:${letter}${endRow}`, options: combined,
      missing: wanted.filter(v => !existing.includes(v)), mode: field === 'creative_expression' ? 'multiple' : 'single' });
  }
  const plan: Plan = {
    schema: 1, target: TARGET, worksheet: sheet, current_sheet: current ?? null, request, baseline_digest: snapshot.fingerprint,
    columns: cols, range: area.toString(), quantity: total, first_number: startNumber, last_number: startNumber + total - 1,
    rows, groups, dropdowns, history_warnings: warnings, naming,
  };
  plan.plan_id = digest(plan).slice(0, 24);
  return plan;
}

/**
 * What the user approved: the sheet, the rows with their numbers, values and names, and the groups. A plan made again on a newer
 * snapshot may differ in everything else (the snapshot digest, the dropdown options read from it, warnings about old rows).
 */
export function business(plan: Plan): unknown {
  const { schema, target, worksheet, current_sheet, request, columns, range, quantity, first_number, last_number, rows, groups } = plan;
  return { schema, target, worksheet, current_sheet, request, columns, range, quantity, first_number, last_number, rows, groups };
}
