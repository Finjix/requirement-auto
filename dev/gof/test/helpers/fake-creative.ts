import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Obj = Record<string, any>;

/**
 * A stand-in for the CLS calls of the page 上传创意 and for the object storage its upload links point at, with the shapes the real
 * ones answered with (2026-10-21). It answers only to `Bearer good`, keeps every request, and can be told to misbehave the ways a test
 * needs: a create whose answer is lost (after or before it took effect), an annotation that is accepted but not applied, or refused.
 */
export interface FakeCreative {
  origin: string;
  requests: { method: string; path: string; query: string; authorization: string | undefined; body?: Obj }[];
  creatives: Map<number, Obj>;
  /** Objects put to storage, by path, with their MD5. */
  objects: Map<string, { md5: string; bytes: number; contentType: string | undefined }>;
  logs: string[];
  createMode: 'normal' | 'lose-answer' | 'hang-up' | 'error500' | 'refuse' | 'refuse-after-first';
  annotateMode: 'normal' | 'ignore-once' | 'refuse';
  /** The signing call hands out links to a host the client must refuse. */
  signElsewhere: boolean;
  close(): void;
}

export const ACCOUNT = { id: 1565, name: '钟丰骏-实习生' };
export const GAME = { id: 94, name: '无尽冬日', code: 'GOFCN', app_id: 'gof.cn.prod', icon_url: 'https://example.invalid/icon.jpg' };
export const DIRS = [{ id: 1572252, name: '无尽冬日 - NEW', children: [
  { id: 1573620, name: '常规素材', children: [
    { id: 1573621, name: '图片', children: [{ id: 1573700, name: '横版', children: [] }] },
    { id: 1585089, name: '双端共用-视频', children: [] },
  ] },
  { id: 1573590, name: '营销素材', children: [{ id: 1585181, name: '双端共通', children: [] }, { id: 1585190, name: '图片', children: [] }] },
] }];
export const PEOPLE = {
  creative_users: [{ id: 653, name: '张天伟' }, { id: 1104, name: '雷佳威' }, { id: 1565, name: '钟丰骏-实习生' }, { id: 1233, name: '李晨阳' }, { id: 492, name: '李晨阳' }, { id: 2001, name: '金莉' }],
  producers: [{ id: 663, name: '北京柒曦文化传媒有限公司（丁杰）' }, { id: 1405, name: '谢振文' }, { id: 1163, name: '盂县丰创智慧技术服务工作室（个体工商户）-杨燃' }, { id: 653, name: '张天伟' },
    // The progress sheet calls this supplier 廿十一.
    { id: 2002, name: '长沙廿拾一文化传媒有限公司' }],
};
export const TYPES = [{ id: 'video', name: '视频' }, { id: '2d_video', name: '2D视频' }, { id: 'image', name: '图片' }, { id: 'aigc', name: 'AI生成' }, { id: 'other', name: '其他' }];

export async function fakeCreative(options: { existing?: Obj[]; canUpload?: boolean } = {}): Promise<FakeCreative> {
  const state: FakeCreative = {
    origin: '', requests: [], creatives: new Map(), objects: new Map(), logs: [],
    createMode: 'normal', annotateMode: 'normal', signElsewhere: false, close: () => undefined,
  };
  let nextId = 556000;
  let ignored = false;
  for (const c of options.existing ?? []) state.creatives.set(c.id, c);
  /** The latest link handed out for each "folder/file" key: what a create of that folder takes. */
  const signedFor = new Map<string, string>();

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(request.url ?? '/', 'http://x');
      const path = decodeURIComponent(url.pathname);
      let body: Obj | undefined;
      try { body = raw.length && request.headers['content-type']?.includes('json') ? JSON.parse(raw.toString('utf8')) : undefined; } catch { body = undefined; }
      state.requests.push({ method: request.method ?? '', path, query: url.search, authorization: request.headers.authorization, ...(body ? { body } : {}) });
      const send = (data: unknown, status = 200, code = 0, message = 'OK') => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code, type: 'message', message, data })); };

      if (request.method === 'PUT' && path.startsWith('/cos/')) {
        if (request.headers.authorization) return send(null, 400, 400, 'no credentials expected');
        state.objects.set(path, { md5: createHash('md5').update(raw).digest('hex'), bytes: raw.length, contentType: request.headers['content-type'] });
        response.writeHead(200, { ETag: `"${createHash('md5').update(raw).digest('hex')}"` });
        return response.end();
      }
      if (request.headers.authorization !== 'Bearer good') return send(null, 401, 401, 'unauthorized');
      const q = url.searchParams;
      if (request.method === 'GET') {
        if (path === '/api/creative/games') return send([GAME]);
        if (path === '/api/userinfo') return send({ ...ACCOUNT, status: 1, roles: ['creative_plan'], game_ids: [94],
          group_permissions: [{ project_ids: [94], role_id: 'creative_plan_junior', permissions: { pages: ['PAGE_MODULE_CREATIVE'] } }] });
        if (path === '/api/permissions') return send({ creative_plan_junior: options.canUpload === false ? ['workflow.scripts'] : ['creative.upload', 'creative.delete'], creative_plan: ['creative.upload'] });
        if (path === '/api/game/adsdesk/dirs') return send(DIRS);
        if (path === '/api/game/recommend-filters') return send(PEOPLE);
        if (path === '/api/material/filters') return send({ types: TYPES });
        if (path === '/api/creatives') {
          const keywords = q.get('keywords');
          const uploaders = q.getAll('upload_users[]').map(Number);
          const confirmed = q.get('confirmed') !== '0';
          let list = [...state.creatives.values()].filter(c => (c.confirmed !== false) === confirmed);
          if (keywords) list = list.filter(c => c.name.includes(keywords) || String(c.id) === keywords);
          if (uploaders.length) list = list.filter(c => uploaders.includes(c.upload_user_id));
          list.sort((a, b) => b.id - a.id);
          return send({ creatives: list.slice(0, Number(q.get('page_size') ?? 50)).map(c => ({ id: c.id, name: c.name, upload_user_id: c.upload_user_id, user_id: c.user_id, user_ids: c.user_ids,
            sync_status: { adsdesk: { status: 0, total: 1, succ: 0, fail: 0 } } })), total: list.length });
        }
        const one = /^\/api\/creative\/(\d+)$/.exec(path);
        if (one) { const c = state.creatives.get(Number(one[1])); return c ? send(c) : send(null, 200, 403, '创意不存在'); }
        return send(null, 404, 404, 'not found');
      }
      if (request.method === 'POST') {
        if (path === '/api/report/log') { state.logs.push(String(body?.msg)); return send(null); }
        if (path === '/api/qcloud/signed-url') {
          const files: string[] = body?.files ?? [];
          const taken = files.map(f => f.split('/')[0]!).filter(n => [...state.creatives.values()].some(c => c.name === n));
          if (taken.length) return send(null, 200, 403, `以下创意已存在: ${[...new Set(taken)].join(',')}`);
          const now = Math.floor(Date.now() / 1000);
          const sign = encodeURIComponent(`q-sign-algorithm=sha1&q-ak=AKIDtest&q-sign-time=${now};${now + 3660}&q-key-time=${now};${now + 3660}&q-header-list=host&q-url-param-list=&q-signature=abc`);
          const urls: Obj = {};
          const mapping: Obj = {};
          for (const key of files) {
            const [, file] = key.split('/');
            if (!/\.(mp4|mov|avi|m4v|jpe?g|png|gif|webp|bmp|html|mp3|wav|zip)$/i.test(file ?? '')) continue;
            const object = `/cos/creatives/2026/10/21/${randomUUID().slice(0, 8)}/${file}`;
            const base = state.signElsewhere ? 'https://evil.example.com' : state.origin;
            urls[key] = `${base}${encodeURI(object)}?sign=${sign}`;
            mapping[key] = key;
            signedFor.set(key, object);
          }
          return send({ urls, mapping });
        }
        if (path === '/api/creative/multiple-upload') {
          if (state.createMode === 'hang-up') { request.socket.destroy(); return; }
          if (state.createMode === 'error500') return send(null, 502, 502, 'bad gateway');
          if (state.createMode === 'refuse') return send(null, 200, 403, '素材处理失败');
          const succ: Obj[] = [];
          const fail: string[] = [];
          for (const name of body?.names ?? []) {
            const key = [...signedFor.keys()].find(k => k.split('/')[0] === name);
            const object = key ? state.objects.get(signedFor.get(key)!) : undefined;
            if (!object || [...state.creatives.values()].some(c => c.materials?.[0]?.file_hash === object.md5)) { fail.push(name); continue; }
            const id = nextId++;
            state.creatives.set(id, { id, name, game_id: body?.game_id, user_id: null, user_ids: [], upload_user_id: ACCOUNT.id, params: { types: [], langs: [] },
              adsdesk_dir_id: body?.adsdesk_dir_ids?.[name], status: 1, confirmed: true,
              materials: [{ id: id * 10, name, file_hash: object.md5, size: object.bytes, file_path: signedFor.get(key!) }] });
            succ.push({ name, id });
            if (state.createMode === 'refuse-after-first') return send(null, 200, 403, '部分素材处理失败');
          }
          if (state.createMode === 'lose-answer') { request.socket.destroy(); return; }
          return send({ succ, fail });
        }
        if (path === '/api/creative/multiple-edit') {
          if (state.annotateMode === 'refuse') return send(null, 200, 403, '没有编辑权限');
          if (state.annotateMode === 'ignore-once' && !ignored) { ignored = true; return send(null); }
          for (const c of body?.creatives ?? []) {
            const found = state.creatives.get(c.id);
            if (!found) return send(null, 200, 403, `创意不存在: ${c.id}`);
            Object.assign(found, { user_id: c.sponsor, user_ids: c.producers, params: { ...found.params, types: c.types }, custom_tags: c.custom_tags });
          }
          return send(null);
        }
      }
      return send(null, 404, 404, 'not found');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => { server.closeAllConnections(); server.close(); };
  return state;
}
