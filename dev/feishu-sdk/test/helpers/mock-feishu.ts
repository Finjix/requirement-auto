import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

export interface TokenReply { status: number; body: Record<string, unknown> }

/** A local stand-in for the Feishu endpoints the plugin talks to. Records every request it receives. */
export class MockFeishu {
  server = http.createServer((req, res) => void this.handle(req, res));
  url = '';
  seen: Seen[] = [];
  openId = 'ou_alice';
  name = '李小明';
  appId = 'cli_test';
  appSecret = 'secret-test-123456';
  /** What the token endpoint answers to successive device-code polls; pending when the script is empty. */
  deviceScript: (TokenReply | "issue")[] = [];
  deviceInterval = 1;
  scope = 'wiki:wiki:readonly sheets:spreadsheet offline_access';
  withRefreshToken = true;
  refreshCount = 0;
  refreshDelayMs = 0;
  accessTtl = 7200;
  /** Overrides for the sheet/drive endpoints. */
  revision = 7;
  writeReply: { status: number; body: unknown } | undefined;
  exportJob = [{ job_status: 1 }, { job_status: 0, file_token: 'ft1' }];
  rejectTokenOnce = false;
  private counter = 0;
  private access = '';
  private refresh = '';

  async start(): Promise<this> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  get endpoints() { return { open: this.url, accounts: this.url }; }
  get currentAccess() { return this.access; }
  get currentRefresh() { return this.refresh; }
  requests(pathPrefix: string) { return this.seen.filter(item => item.url.startsWith(pathPrefix)); }

  /** Issues a fresh access/refresh pair, as the token endpoint does. */
  issue(): Record<string, unknown> {
    this.counter++;
    this.access = `u-access${this.counter}${'x'.repeat(24)}`;
    const body: Record<string, unknown> = { access_token: this.access, token_type: 'Bearer', expires_in: this.accessTtl, scope: this.scope };
    if (this.withRefreshToken) {
      this.refresh = `ur-refresh${this.counter}${'y'.repeat(24)}`;
      body.refresh_token = this.refresh;
      body.refresh_token_expires_in = 604800;
    }
    return body;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = req.url ?? '';
    this.seen.push({ method: req.method ?? '', url, headers: req.headers, body });
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const pathname = url.split('?')[0]!;
    const form = () => Object.fromEntries(new URLSearchParams(body));

    if (pathname === '/oauth/v1/device_authorization') {
      const basic = `Basic ${Buffer.from(`${this.appId}:${this.appSecret}`).toString('base64')}`;
      if (req.headers.authorization !== basic) return json(401, { error: 'invalid_client', error_description: 'bad credentials' });
      return json(200, { device_code: 'dev-code-1', user_code: 'ABCD-1234', verification_uri: `${this.url}/verify`,
        verification_uri_complete: `${this.url}/verify?user_code=ABCD-1234`, expires_in: 240, interval: this.deviceInterval });
    }
    if (pathname === '/oauth/v3/token') {
      const grant = req.headers['content-type']?.includes('json') ? JSON.parse(body) : form();
      if (grant.client_id !== this.appId || grant.client_secret !== this.appSecret) return json(401, { error: 'invalid_client' });
      if (grant.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const next = this.deviceScript.shift();
        if (!next) return json(400, { error: 'authorization_pending' });
        if (next === 'issue') return json(200, this.issue());
        return json(next.status, next.body);
      }
      if (grant.grant_type === 'refresh_token') {
        this.refreshCount++;
        if (this.refreshDelayMs) await new Promise(resolve => setTimeout(resolve, this.refreshDelayMs));
        if (grant.refresh_token !== this.refresh) return json(400, { error: 'invalid_grant', error_description: 'refresh token used' });
        return json(200, this.issue());
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    // Everything below is an Open API call with a user access token.
    if (req.headers.authorization !== `Bearer ${this.access}`) return json(401, { code: 99991668, msg: 'invalid access token' });
    if (this.rejectTokenOnce) { this.rejectTokenOnce = false; return json(200, { code: 99991677, msg: 'token expired' }); }
    if (pathname === '/open-apis/authen/v1/user_info') return json(200, { code: 0, data: { open_id: this.openId, name: this.name } });
    if (/\/sheets\/v2\/spreadsheets\/[^/]+\/metainfo$/.test(pathname)) return json(200, { code: 0, data: { properties: { revision: this.revision } } });
    if (pathname.endsWith('/tools/invoke_write')) {
      if (this.writeReply) return json(this.writeReply.status, this.writeReply.body);
      return json(200, { code: 0, data: { ok: true } });
    }
    if (pathname === '/open-apis/drive/v1/export_tasks' && req.method === 'POST') return json(200, { code: 0, data: { ticket: 'tk1' } });
    if (pathname === '/open-apis/drive/v1/export_tasks/tk1') {
      const job = this.exportJob.length > 1 ? this.exportJob.shift()! : this.exportJob[0]!;
      return json(200, { code: 0, data: { result: job } });
    }
    if (pathname === '/open-apis/drive/v1/export_tasks/file/ft1/download') {
      // The smallest valid ZIP: an empty central directory end record.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return void res.end(Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]));
    }
    if (pathname === '/open-apis/wiki/v2/spaces/get_node') return json(200, { code: 0, data: { node: { node_token: 'wiki1', obj_type: 'sheet', obj_token: 'shtABCDEFGH' } } });
    return json(404, { code: 404, msg: `no route ${pathname}` });
  }
}
