import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseCsv } from '../../src/gof/cls.ts';

type Obj = Record<string, any>;

/**
 * A stand-in for the CLS API with the shapes the restricted adapter reads: the option lists, drafts and CSV imports.
 * It answers only to `Bearer good`, and it keeps every request so a test can see what was sent.
 */
export interface FakeCls {
  origin: string;
  requests: { method: string; path: string; authorization: string | undefined }[];
  drafts: Map<number, Obj>;
  /** What the next POST does: answer normally, or hang up without an answer (an outcome the client cannot know). */
  postMode: 'normal' | 'hang-up';
  close(): void;
}

export async function fakeCls(catalog: Obj): Promise<FakeCls> {
  const state: FakeCls = { origin: '', requests: [], drafts: new Map(), postMode: 'normal', close: () => undefined };
  let nextId = 5001;
  let nextScript = 9001;
  const account = { id: catalog.account.id, name: catalog.account.name, status: 1, game_ids: catalog.account.game_ids, roles: catalog.account.roles };
  const permissions = { [catalog.account.roles[0]]: [...(catalog.can_create ? ['workflow.script.save'] : []), ...(catalog.can_import ? ['workflow.script.edit'] : [])] };
  const reads: Record<string, unknown> = {
    '/api/games': catalog.games, '/api/users': catalog.users, '/api/userinfo': account, '/api/user/roles': { roles: catalog.account.roles }, '/api/permissions': permissions,
    '/api/workflow/filters': { types: catalog.types, currencies: catalog.currencies, company: catalog.companies, departments: catalog.departments },
    '/api/workflow/directs': catalog.directions,
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = new URL(request.url ?? '/', 'http://x').pathname;
      state.requests.push({ method: request.method ?? '', path, authorization: request.headers.authorization });
      const send = (data: unknown, status = 200, code = 0) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code, data })); };
      if (request.headers.authorization !== 'Bearer good') return send(null, 401, 401);
      if (request.method === 'GET' && path in reads) return send(reads[path]);
      const draft = /^\/api\/workflow\/script\/(\d+)$/.exec(path);
      if (request.method === 'GET' && draft) {
        const script = state.drafts.get(Number(draft[1]));
        return script ? send({ script }) : send(null, 200, 404);
      }
      if (request.method === 'POST') {
        if (state.postMode === 'hang-up') { request.socket.destroy(); return; }
        if (path === '/api/workflow/script/save') {
          const payload = JSON.parse(body.toString('utf8'));
          const script = { ...payload, id: nextId++, number: 'GOFCN20260100009', is_edit: true, user_id: account.id, for_internal: 0, sub_scripts: [] as Obj[] };
          state.drafts.set(script.id, script);
          return send({ id: script.id, status: script.status });
        }
        if (path === '/api/workflow/sub-script/multiple-add') {
          const text = body.toString('utf8');
          const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(text)?.[1];
          const file = /name="file"; filename="[^"]+"\r\nContent-Type: [^\r]+\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1];
          const script = state.drafts.get(Number(field('script_id')));
          if (!script || !file) return send(null, 200, 400);
          const rows = parseCsv(file.replace(/^﻿/, '')).slice(1);
          script.sub_scripts = rows.map(row => ({ id: nextScript++, script_id: script.id, name: row[0], data: row[1], user_id: Number(field('user_id')), tags: [{ id: 1, full_name: row[2] }] }));
          return send({ added: rows.length });
        }
      }
      return send(null, 404, 404);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => { server.closeAllConnections(); server.close(); };
  return state;
}
