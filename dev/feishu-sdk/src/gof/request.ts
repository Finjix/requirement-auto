import { cellText, feishuDocPath, isObject, need } from './util.ts';

export const REQUIRED_TEXT = ['material_name', 'keyword', 'creative_form', 'supplier', 'reviewer', 'script_url'];
export const OPTIONAL_FIELDS = ['creative_expression', 'creative_batch', 'head_reference', 'creative_reference'];
export const CLS_REQUIRED = ['direction', 'task_type', 'requirement_name'];
export const CLS_OPTIONAL = ['subject', 'department', 'market_contact', 'currency', 'quotation',
  'expected_completion', 'storyboard_time', 'first_draft_time', 'final_cut_time'];

export interface Group {
  quantity: number;
  material_name: string; keyword: string; creative_form: string; supplier: string; reviewer: string; script_url: string;
  topic: string; primary_tag: string; secondary_tag: string; creator: string; client: string; brief: string;
  creative_expression: string; creative_batch: string; head_reference: string; creative_reference: string;
  cls: Record<string, string | number>;
  [key: string]: unknown;
}
export interface NormalizedRequest { groups: Group[]; worksheet?: string }

const pick = (obj: Record<string, any>, key: string, fallback: unknown) => (key in obj ? obj[key] : fallback);
const subset = (keys: string[], allowed: Iterable<string>) => { const set = new Set(allowed); return keys.every(k => set.has(k)); };

export function normalizeRequest(request: unknown): NormalizedRequest {
  need(isObject(request) && subset(Object.keys(request), ['worksheet', 'groups']), '请求有未知字段/目标覆盖');
  const groups = request.groups;
  need(Array.isArray(groups) && groups.length > 0, '需要至少一个供应商/题材组');
  const allowed = [...REQUIRED_TEXT, ...OPTIONAL_FIELDS, 'quantity', 'topic', 'primary_tag', 'secondary_tag', 'creator', 'client', 'brief', 'cls'];
  const normalized: Group[] = [];
  groups.forEach((raw: unknown, offset: number) => {
    const index = offset + 1;
    need(isObject(raw) && subset(Object.keys(raw), allowed), `第 ${index} 组有未知字段`);
    const q = raw.quantity;
    need(typeof q === 'number' && Number.isInteger(q) && q > 0, 'quantity 必须是正整数');
    need(REQUIRED_TEXT.every(k => k in raw), `第 ${index} 组缺少需求字段：提炼词、素材名称、创意形式、供应商、审核人、脚本内容链接`);
    const g: Record<string, any> = { quantity: q };
    for (const key of REQUIRED_TEXT) {
      need(typeof raw[key] === 'string' && raw[key].trim() !== '', `缺少 ${key}`);
      g[key] = cellText(raw[key], key);
    }
    // A user-supplied historical number is a naming example, never a new ID.
    g.material_name = g.material_name.replace(/^GOFCN\d+_/, '');
    const suffix = `_${g.creative_form}_${g.keyword}`;
    need(g.material_name.endsWith(suffix), '素材名称与创意形式/提炼词不一致，请澄清');
    const topic = g.material_name.slice(0, g.material_name.length - suffix.length);
    g.topic = cellText(pick(raw, 'topic', topic), 'topic');
    need(g.topic === topic, '题材与素材名称不一致');
    const cut = topic.indexOf('_');
    const inferred = cut < 0 ? [topic] : [topic.slice(0, cut), topic.slice(cut + 1)];
    ['primary_tag', 'secondary_tag'].forEach((key, i) => {
      g[key] = cellText(pick(raw, key, inferred.length === 2 ? inferred[i] : ''), key);
      need(g[key].trim() !== '', '无法从素材名称确定一二级标签，需先根据名称推理');
    });
    g.creator = g.reviewer; // Same person for progress reviewer, CLS creator and message.
    need(pick(raw, 'creator', g.reviewer) === g.reviewer, '审核人与进度表创意者字段不一致');
    for (const key of ['client', ...OPTIONAL_FIELDS]) {
      need(pick(raw, key, '') === '', `进度表阶段 ${key} 应留空`);
      g[key] = '';
    }
    g.brief = pick(raw, 'brief', '');
    need(typeof g.brief === 'string', 'brief 必须是文本');
    need(feishuDocPath(g.script_url, 'wiki|docx', true) !== undefined, '脚本链接必须是当前确认的飞书文档');
    const cls = pick(raw, 'cls', {});
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
