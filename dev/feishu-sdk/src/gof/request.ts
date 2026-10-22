import { cellText, feishuDocPath, isObject, need } from './util.ts';

export const REQUIRED_TEXT = ['material_name', 'keyword', 'creative_form', 'supplier', 'reviewer', 'script_url'];
export const OPTIONAL_FIELDS = ['creative_expression', 'creative_batch', 'head_reference', 'creative_reference'];
export const CLS_REQUIRED = ['direction', 'task_type'];
// `supplier` and `creator` name the same supplier and reviewer the way CLS spells them, when the program cannot match them by itself.
export const CLS_OPTIONAL = ['subject', 'department', 'market_contact', 'currency', 'quotation',
  'expected_completion', 'storyboard_time', 'first_draft_time', 'final_cut_time', 'supplier', 'creator'];
/** 提炼词 unless the request names one. */
export const DEFAULT_KEYWORD = '关键词';
/** The progress fields that make up a material name and may differ from row to row within one group. */
export const ITEM_FIELDS = ['primary_tag', 'secondary_tag', 'creative_form', 'keyword'];

/** A run of rows with the same name body: quantity, the tags, form and keyword, and the name without its number. */
export interface Item {
  quantity: number;
  material_name: string; topic: string; primary_tag: string; secondary_tag: string; creative_form: string; keyword: string;
}

export interface Group {
  quantity: number;
  material_name: string; keyword: string; creative_form: string; supplier: string; reviewer: string; script_url: string;
  topic: string; primary_tag: string; secondary_tag: string; creator: string; client: string; brief: string;
  creative_expression: string; creative_batch: string; head_reference: string; creative_reference: string;
  cls: Record<string, string | number>;
  /** The short name of this kind of requirement in the group message ("素人剧情"); only present when given, otherwise the message uses the 一级标签. */
  label?: string;
  /** Only when the rows of the group differ; a group of one kind of row keeps its fields on itself. */
  items?: Item[];
  [key: string]: unknown;
}
export interface NormalizedRequest { groups: Group[]; worksheet?: string }

const pick = (obj: Record<string, any>, key: string, fallback: unknown) => (key in obj ? obj[key] : fallback);
const subset = (keys: string[], allowed: Iterable<string>) => { const set = new Set(allowed); return keys.every(k => set.has(k)); };
const ITEM_KEYS = ['quantity', 'material_name', 'topic', ...ITEM_FIELDS];

/** The rows of a group in order: its items, or the group itself when all its rows are alike. */
export function itemsOf(group: Record<string, any>): Item[] {
  if (Array.isArray(group.items)) return group.items as Item[];
  return [{ quantity: group.quantity, material_name: group.material_name, topic: group.topic, primary_tag: group.primary_tag,
    secondary_tag: group.secondary_tag, creative_form: group.creative_form, keyword: group.keyword }];
}

/** Every value a field takes in the request, in order of first use. */
export function fieldValues(groups: Record<string, any>[], field: string): string[] {
  const values = groups.flatMap(g => (ITEM_FIELDS.includes(field) ? itemsOf(g).map(item => item[field as keyof Item]) : [g[field]]));
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];
}

/**
 * One run of rows. `raw` holds the item's own keys and `inherited` the group's defaults for the tags, form and keyword. The name is
 * either given (a sample with an old number is fine) and checked against the form and keyword, or built from the tags.
 */
function item(raw: Record<string, any>, inherited: Record<string, any>, where: string): Item {
  const q = raw.quantity;
  need(typeof q === 'number' && Number.isInteger(q) && q > 0, 'quantity 必须是正整数');
  const value = (key: string, fallback: unknown) => pick(raw, key, pick(inherited, key, fallback));
  need(value('creative_form', undefined) !== undefined, `${where}缺少创意形式`);
  const form = cellText(value('creative_form', ''), 'creative_form');
  const keyword = cellText(value('keyword', DEFAULT_KEYWORD), 'keyword');
  need(form.trim() !== '', '缺少 creative_form');
  need(keyword.trim() !== '', '缺少 keyword');
  // It ends up in the 素材名称, which is also the creative's name in CLS, where / and \ cannot be: such a row could never be uploaded.
  need(!/[\\/]/.test(keyword), `提炼词“${keyword}”不能含 / 或 \\（素材名称也是 CLS 里的创意名称，那里不能有）：换成别的写法`);
  const result: Record<string, any> = { quantity: q, creative_form: form, keyword };
  const suffix = `_${form}_${keyword}`;
  const given = value('material_name', undefined);
  if (given !== undefined) {
    need(typeof given === 'string' && given.trim() !== '', '缺少 material_name');
    // A user-supplied historical number is a naming example, never a new ID.
    result.material_name = cellText(given, 'material_name').replace(/^GOFCN\d+_/, '');
    need(result.material_name.endsWith(suffix), '素材名称与创意形式/提炼词不一致，请澄清');
    const topic = result.material_name.slice(0, result.material_name.length - suffix.length);
    result.topic = cellText(pick(raw, 'topic', topic), 'topic');
    need(result.topic === topic, '题材与素材名称不一致');
    const cut = topic.indexOf('_');
    const inferred = cut < 0 ? [topic] : [topic.slice(0, cut), topic.slice(cut + 1)];
    ['primary_tag', 'secondary_tag'].forEach((key, i) => {
      result[key] = cellText(value(key, inferred.length === 2 ? inferred[i] : ''), key);
      need(result[key].trim() !== '', '无法从素材名称确定一二级标签，需先根据名称推理');
    });
  } else {
    for (const key of ['primary_tag', 'secondary_tag']) {
      const tag = value(key, '');
      need(typeof tag === 'string' && tag.trim() !== '', `${where}缺少一级/二级标签`);
      result[key] = cellText(tag, key);
    }
    result.topic = `${result.primary_tag}_${result.secondary_tag}`;
    result.material_name = `${result.topic}${suffix}`;
    if ('topic' in raw) need(raw.topic === result.topic, '题材与素材名称不一致');
  }
  return result as Item;
}

export function normalizeRequest(request: unknown): NormalizedRequest {
  need(isObject(request) && subset(Object.keys(request), ['worksheet', 'groups']), '请求有未知字段/目标覆盖');
  const groups = request.groups;
  need(Array.isArray(groups) && groups.length > 0, '需要至少一个供应商/题材组');
  const allowed = [...REQUIRED_TEXT, ...OPTIONAL_FIELDS, 'quantity', 'topic', 'primary_tag', 'secondary_tag', 'creator', 'client', 'brief', 'cls', 'items', 'label'];
  const normalized: Group[] = [];
  groups.forEach((raw: unknown, offset: number) => {
    const index = offset + 1;
    need(isObject(raw) && subset(Object.keys(raw), allowed), `第 ${index} 组有未知字段`);
    const g: Record<string, any> = {};
    if ('items' in raw) {
      const list = raw.items;
      need(Array.isArray(list) && list.length > 0, `第 ${index} 组的 items 需要至少一项`);
      need(!['material_name', 'topic'].some(k => k in raw), `第 ${index} 组已按 items 分行，素材名称写在各项里`);
      const items = list.map((entry: unknown, i: number) => {
        need(isObject(entry) && subset(Object.keys(entry), ITEM_KEYS), `第 ${index} 组第 ${i + 1} 项有未知字段`);
        return item(entry, raw, `第 ${index} 组第 ${i + 1} 项`);
      });
      const total = items.reduce((n: number, it: Item) => n + it.quantity, 0);
      // A normalized request is normalized again when a batch is prepared: its total is the items' sum.
      need(!('quantity' in raw) || raw.quantity === total, `第 ${index} 组的 quantity 与各项数量之和不一致`);
      // A group of one kind of row looks the same however it was written.
      if (items.length === 1) Object.assign(g, items[0]);
      else Object.assign(g, { quantity: total, items });
    } else {
      Object.assign(g, item(raw, {}, `第 ${index} 组`));
    }
    const missing = ([['supplier', '供应商'], ['reviewer', '审核人'], ['script_url', '脚本内容链接']] as const)
      .filter(([key]) => !(key in raw)).map(([, label]) => label);
    need(missing.length === 0, `第 ${index} 组缺少需求字段：${missing.join('、')}`);
    for (const key of ['supplier', 'reviewer', 'script_url']) {
      need(typeof raw[key] === 'string' && raw[key].trim() !== '', `缺少 ${key}`);
      g[key] = cellText(raw[key], key);
    }
    g.creator = g.reviewer; // Same person for progress reviewer, CLS creator and message.
    need(pick(raw, 'creator', g.reviewer) === g.reviewer, '审核人与进度表创意者字段不一致');
    for (const key of ['client', ...OPTIONAL_FIELDS]) {
      need(pick(raw, key, '') === '', `进度表阶段 ${key} 应留空`);
      g[key] = '';
    }
    if ('label' in raw) {
      // Only in the group message, where it stands in front of "*数量" inside brackets: no brackets, stars or line breaks of its own.
      const label = cellText(raw.label, 'label').trim();
      need(label !== '' && label.length <= 20 && !/[()（）*＊]/.test(label), `第 ${index} 组的 label 需要 1-20 个字，且不含括号和星号`);
      g.label = label;
    }
    g.brief = pick(raw, 'brief', ''); // Only still accepted so older requests load; it is not used anywhere.
    need(typeof g.brief === 'string', 'brief 必须是文本');
    need(feishuDocPath(g.script_url, 'wiki|docx|sheets', true) !== undefined, '脚本链接必须是当前确认的飞书文档');
    const cls = pick(raw, 'cls', {});
    need(!(isObject(cls) && 'requirement_name' in cls), 'CLS 需求名称由该组素材编号生成（GOFCN首号-GOFCN末号），不接受输入');
    need(isObject(cls) && subset(Object.keys(cls), [...CLS_REQUIRED, ...CLS_OPTIONAL]), 'CLS 字段未知');
    if (Object.keys(cls).length > 0) {
      for (const key of CLS_REQUIRED) need(typeof cls[key] === 'string' && cls[key].trim() !== '', `缺少 CLS ${key}`);
    }
    for (const value of Object.values(cls)) need(typeof value === 'string' || typeof value === 'number', 'CLS 字段必须是明确的文本/数值');
    g.cls = { ...cls };
    normalized.push(g as Group);
  });
  const result: NormalizedRequest = { groups: normalized };
  if ('worksheet' in request) {
    need(typeof request.worksheet === 'string' && request.worksheet.trim() !== '', '工作表名称不能为空');
    result.worksheet = request.worksheet;
  }
  return result;
}
