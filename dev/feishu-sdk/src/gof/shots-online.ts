import { report, sheetUrl } from './batch.ts';
import type { Online, Session } from './cls-online.ts';
import { createCreativeAdapter, type CreativeAdapterConfig } from './creative-adapter.ts';
import { clsProfileDir } from './cls-session.ts';
import { draftScreenshot, type DraftShotOptions } from './draft-shot.ts';
import { docScreenshot, type DocShotOptions } from './doc-shot.ts';
import { sheetScreenshot, type SheetShotOptions } from './sheet-shot.ts';
import { Blocked, checkTarget, feishuDocPath, need, NODE } from './util.ts';

/*
 * The two pictures that close the requirement flow: `gof.mjs feishu screenshot` (the 创意进度表 on the rows that were appended) and
 * `gof.mjs cls screenshot` (a group's CLS 需求草稿). Both are worked out from the batch's own record, both only look at a page in this
 * user's hidden browser (see sheet-shot.ts and draft-shot.ts), and neither can change anything in Feishu or CLS.
 */

type Obj = Record<string, any>;

/** Test seams: a local CLS and short waits. Production passes nothing. */
export interface ShotDeps {
  adapter?: Partial<CreativeAdapterConfig>;
  sheet?: Partial<SheetShotOptions>;
  draft?: Partial<DraftShotOptions>;
}

/** The progress sheet after the append: the tab the rows were put into, opened on those rows. */
export async function sheetPicture(online: Online, batch: string, output: string, deps: ShotDeps = {}): Promise<Obj> {
  const result = report(batch);
  need(result.append_verified, '这一批还没有追加并验收进度表，没有可截图的行');
  const url = sheetUrl(result.sheet_id);
  checkTarget(url);
  // The browser profile is the CLS one: it must be this user's own, and the Feishu login that fills it is checked with the CLS one.
  await online.session();
  const shot = await sheetScreenshot({ profileDir: clsProfileDir(), output, url, range: result.range, ...deps.sheet });
  if (shot.state === 'login_required') throw new Blocked(`飞书网页登录已失效（页面停在 ${shot.where}）：先运行 gof.mjs login check 再截图`);
  if (shot.state === 'no_access') throw new Blocked(`进度表打不开（停在 ${shot.where}）：账号可能没有这张表的权限`);
  return { status: 'screenshot_saved', file: shot.file, worksheet: result.worksheet, range: result.range, progress_sheet: url };
}

/** The draft a group of the batch has in CLS (the one its scripts were imported into, else the one that was saved). */
export function draftOf(batch: string, group: string | undefined): { group: string; id: number; url: string } {
  const groups: Obj[] = report(batch).groups.filter((g: Obj) => group === undefined || g.group === group);
  need(groups.length > 0, group === undefined ? '这一批没有分组' : `这一批没有分组 ${group}`);
  const withDraft = groups.map(g => ({ group: String(g.group), ...(g.scripts_imported ?? g.draft_saved ?? {}) })).filter(g => Number.isSafeInteger(g.draft_id));
  if (withDraft.length === 0) throw new Blocked(group === undefined ? '这一批还没有保存任何 CLS 草稿' : `分组 ${group} 还没有保存 CLS 草稿`);
  need(withDraft.length === 1, `这一批有 ${withDraft.length} 个 CLS 草稿，用 --group 指明要哪一个：${withDraft.map(g => g.group).join('、')}`);
  const only = withDraft[0]!;
  return { group: only.group, id: only.draft_id, url: only.url };
}

/** A group's CLS draft, opened in the app as a person would and photographed. */
export async function draftPicture(online: Online, batch: string, group: string | undefined, output: string, deps: ShotDeps = {}): Promise<Obj> {
  const draft = draftOf(batch, group);
  const session: Session = await online.session();
  const games = await createCreativeAdapter({ origin: session.origin, authorization: session.authorization, ...deps.adapter }).games();
  const game = (Array.isArray(games) ? games : []).find((g: Obj) => g.code === 'GOFCN');
  need(game, `CLS 账号“${session.account.name}”没有 GOFCN 项目`);
  const shot = await draftScreenshot({ profileDir: clsProfileDir(), output, draftId: draft.id, game, ...deps.draft });
  if (shot.state === 'login_required') throw new Blocked('CLS 登录已失效（页面停在登录页）：先运行 gof.mjs login check 再截图');
  if (shot.state === 'no_access') throw new Blocked(`草稿页打不开（停在 ${shot.where}）：账号可能没有这个页面的权限`);
  return { status: 'screenshot_saved', file: shot.file, group: draft.group, draft_id: draft.id, draft_url: draft.url };
}

/**
 * A requirement document after an edit (`gof.mjs feishu doc-screenshot`): a docx opened on the block the edit wrote (its `focus.block`), a
 * sheet on its tab and the cells it filled (`focus.sheet_id`, `focus.range`). Only looks, as the user, in this user's hidden browser.
 */
export async function docPicture(online: Online, url: string, focus: { block?: string; sheet_id?: string; range?: string }, output: string, deps: ShotDeps & { doc?: Partial<DocShotOptions> } = {}): Promise<Obj> {
  const docPath = feishuDocPath(url, 'docx|wiki|sheets', true);
  need(docPath, '不是公司飞书文档链接（需要 wiki、docx 或 sheets 链接）');
  need(!docPath.includes(NODE), '创意进度表用 gof feishu screenshot --batch 截图');
  need(focus.block === undefined || /^[A-Za-z0-9]{8,64}$/.test(focus.block), '--block 需要 doc-edit 结果里 focus.block 的块 ID');
  need(focus.sheet_id === undefined || /^[A-Za-z0-9_-]{1,64}$/.test(focus.sheet_id), '--sheet 需要 doc-edit 结果里 focus.sheet_id');
  need(focus.range === undefined || /^[A-Z]{1,3}\d+(:[A-Z]{1,3}\d+)?$/.test(focus.range), '--range 需要写成 A9 或 A9:B12');
  await online.session();
  const sheet = focus.sheet_id !== undefined || docPath.startsWith('/sheets/');
  if (sheet) {
    const located = new URL(url);
    if (focus.sheet_id) located.searchParams.set('sheet', focus.sheet_id);
    const shot = await sheetScreenshot({ profileDir: clsProfileDir(), output, url: located.toString(), range: focus.range, ...deps.sheet });
    if (shot.state === 'login_required') throw new Blocked(`飞书网页登录已失效（页面停在 ${shot.where}）：先运行 gof.mjs login check 再截图`);
    if (shot.state === 'no_access') throw new Blocked(`表格打不开（停在 ${shot.where}）：账号可能没有这份表格的权限`);
    return { status: 'screenshot_saved', file: shot.file, url: located.toString(), ...(focus.range ? { range: focus.range } : {}) };
  }
  const shot = await docScreenshot({ profileDir: clsProfileDir(), output, url, block: focus.block, ...deps.doc });
  if (shot.state === 'login_required') throw new Blocked(`飞书网页登录已失效（页面停在 ${shot.where}）：先运行 gof.mjs login check 再截图`);
  if (shot.state === 'no_access') throw new Blocked(`文档打不开（停在 ${shot.where}）：账号可能没有这份文档的权限`);
  return { status: 'screenshot_saved', file: shot.file, url, ...(focus.block ? { block: focus.block } : {}) };
}
