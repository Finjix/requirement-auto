import { AccessTokenError } from '@larksuiteoapi/node-sdk';
import { BridgeError } from './errors.ts';
import { FEISHU, OFFLINE_SCOPE, REQUIRED_SCOPES, scopeList, type AppCredentials, type Endpoints } from './config.ts';
import { createClient, lark } from './client.ts';
import { readJson, removeFile, withLock, writeJsonAtomic } from './fsutil.ts';
import type { DataPaths } from './paths.ts';

/** The access token is renewed this long before it runs out, so a call never starts with a token about to die. */
const SKEW_MS = 5 * 60_000;
const DEVICE_PATH = '/oauth/v1/device_authorization';
const TOKEN_PATH = '/oauth/v3/token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_WAIT_MS = 50_000;
const MAX_INTERVAL_S = 60;

interface StoredToken {
  v: 1;
  app_id: string;
  open_id: string;
  name?: string;
  access_token: string;
  refresh_token?: string;
  access_expires_at: number;
  refresh_expires_at: number;
  scope: string;
  granted_at: number;
  refreshed_at: number;
}

interface PendingLogin {
  v: 1;
  app_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  scope: string;
  expires_at: number;
  interval_s: number;
  next_poll_at: number;
}

export interface LoginPrompt {
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  expires_in_s: number;
  interval_s: number;
  /** An earlier, still valid request was returned instead of asking Feishu for a new one. */
  reused: boolean;
}

export type PollResult =
  | { state: 'authorized'; open_id: string; name?: string; scopes: string[]; refreshable: boolean }
  | { state: 'pending'; retry_after_s: number; expires_in_s: number }
  | { state: 'denied' }
  | { state: 'expired' };

export interface AuthStatus {
  logged_in: boolean;
  app_configured: boolean;
  storage: DataPaths['mode'];
  open_id?: string;
  name?: string;
  scopes?: string[];
  missing_scopes?: string[];
  access_expires_at?: number;
  refresh_expires_at?: number;
  /** The login cannot be renewed (no refresh token was issued): it ends when the access token does. */
  refreshable?: boolean;
  /** A device authorization the user has not completed yet. */
  pending_login?: { user_code: string; verification_uri_complete: string; expires_at: number };
}

export interface AuthOptions {
  paths: DataPaths;
  app: AppCredentials | undefined;
  endpoints?: Endpoints;
  /** The Open ID the host says this process serves; a login or a stored token of anybody else is refused. */
  expectedOpenId?: string | undefined;
  /** What to tell the user when no app is configured (where the host or the standalone user should put it). */
  missingApp?: string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const unique = (items: Iterable<string>) => [...new Set(items)];
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(item => b.includes(item));
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function describe(body: any, fallback: string): string {
  const text = [body?.error_description, body?.error, body?.msg].find(value => typeof value === 'string' && value);
  return text ?? fallback;
}

export class FeishuAuth {
  readonly paths: DataPaths;
  readonly endpoints: Endpoints;
  private app: AppCredentials | undefined;
  private expected: string | undefined;
  private missingApp: string;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private sdk: ReturnType<typeof createClient> | undefined;

  constructor(options: AuthOptions) {
    this.paths = options.paths;
    this.app = options.app;
    this.endpoints = options.endpoints ?? FEISHU;
    this.expected = options.expectedOpenId;
    this.missingApp = options.missingApp ?? '未配置飞书应用：需要环境变量 FEISHU_APP_ID 和 FEISHU_APP_SECRET（由宿主传入）';
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Every secret this process holds, for scrubbing text before it leaves. */
  async secrets(): Promise<string[]> {
    const token = await readJson<StoredToken>(this.paths.auth);
    return [this.app?.appSecret ?? '', token?.access_token ?? '', token?.refresh_token ?? ''].filter(Boolean);
  }

  get client() {
    if (!this.app) throw new BridgeError('config', this.missingApp);
    this.sdk ??= createClient(this.app, this.endpoints);
    return this.sdk;
  }

  private credentials(): AppCredentials {
    if (!this.app) throw new BridgeError('config', this.missingApp);
    return this.app;
  }

  // ---- stored state -------------------------------------------------------------------------------------------------

  private async readToken(): Promise<StoredToken | undefined> {
    const token = await readJson<StoredToken>(this.paths.auth);
    if (!token || token.v !== 1 || typeof token.access_token !== 'string' || !token.open_id) return undefined;
    // A token belongs to the app that issued it and to the user this process serves.
    if (this.app && token.app_id !== this.app.appId) return undefined;
    if (this.expected && token.open_id !== this.expected) {
      throw new BridgeError('identity_mismatch', '已保存的飞书登录不属于当前用户，已拒绝使用；请退出登录后用本人账号重新授权');
    }
    return token;
  }

  private async readPending(): Promise<PendingLogin | undefined> {
    const pending = await readJson<PendingLogin>(this.paths.login);
    if (!pending || pending.v !== 1 || typeof pending.device_code !== 'string') return undefined;
    if (this.app && pending.app_id !== this.app.appId) return undefined;
    return pending;
  }

  private loggedIn(token: StoredToken): boolean {
    return token.refresh_expires_at > this.now() || token.access_expires_at > this.now();
  }

  // ---- status -------------------------------------------------------------------------------------------------------

  /** Local only: no network, and never a token. */
  async status(required: readonly string[] = REQUIRED_SCOPES): Promise<AuthStatus> {
    const result: AuthStatus = { logged_in: false, app_configured: !!this.app, storage: this.paths.mode };
    const token = await this.readToken();
    if (token && this.loggedIn(token)) {
      const scopes = scopeList(token.scope);
      Object.assign(result, {
        logged_in: true, open_id: token.open_id, scopes, missing_scopes: required.filter(item => !scopes.includes(item)),
        access_expires_at: token.access_expires_at, refresh_expires_at: token.refresh_expires_at,
        refreshable: !!token.refresh_token,
      });
      if (token.name) result.name = token.name;
    }
    const pending = await this.readPending();
    if (pending && pending.expires_at > this.now()) {
      result.pending_login = { user_code: pending.user_code, verification_uri_complete: pending.verification_uri_complete, expires_at: pending.expires_at };
    }
    return result;
  }

  async logout(): Promise<void> {
    await removeFile(this.paths.auth);
    await removeFile(this.paths.login);
  }

  async requireScopes(required: readonly string[]): Promise<void> {
    const token = await this.readToken();
    if (!token) throw new BridgeError('auth_required', '尚未登录飞书');
    const granted = scopeList(token.scope);
    const missing = required.filter(item => !granted.includes(item));
    if (missing.length) throw new BridgeError('scope_missing', `飞书登录缺少权限：${missing.join('、')}；请在应用后台开通后重新授权`);
  }

  // ---- device flow --------------------------------------------------------------------------------------------------

  private async postForm(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    try {
      const body = await this.client.httpInstance.request({
        method: 'post', url, timeout: 20_000, data: new URLSearchParams(form).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      });
      return { status: 200, body };
    } catch (e: any) {
      if (e?.response) return { status: e.response.status, body: e.response.data };
      throw new BridgeError('network', '无法连接飞书账号服务');
    }
  }

  private prompt(pending: PendingLogin, reused: boolean): LoginPrompt {
    return {
      verification_uri: pending.verification_uri, verification_uri_complete: pending.verification_uri_complete,
      user_code: pending.user_code, expires_in_s: Math.max(0, Math.floor((pending.expires_at - this.now()) / 1000)),
      interval_s: pending.interval_s, reused,
    };
  }

  /** Asks Feishu for a device authorization the user confirms in their own browser. Nothing is stored but the pending request. */
  async startLogin(extraScopes: readonly string[] = []): Promise<LoginPrompt> {
    const app = this.credentials();
    const scopes = unique([...REQUIRED_SCOPES, ...extraScopes, OFFLINE_SCOPE]);
    const existing = await this.readPending();
    if (existing && existing.expires_at - 10_000 > this.now() && sameSet(scopeList(existing.scope), scopes)) return this.prompt(existing, true);

    const basic = Buffer.from(`${app.appId}:${app.appSecret}`).toString('base64');
    const { status, body } = await this.postForm(`${this.endpoints.accounts}${DEVICE_PATH}`,
      { client_id: app.appId, scope: scopes.join(' ') }, { Authorization: `Basic ${basic}` });
    if (status >= 400 || body?.error || typeof body?.device_code !== 'string' || typeof body?.user_code !== 'string') {
      const code = body?.error;
      if (code === 'invalid_client') throw new BridgeError('config', '飞书应用凭证无效，请检查 FEISHU_APP_ID / FEISHU_APP_SECRET');
      throw new BridgeError('api', `发起飞书授权失败：${describe(body, `HTTP ${status}`)}`);
    }
    const interval = Math.min(MAX_INTERVAL_S, Math.max(1, Number(body.interval) || 5));
    const pending: PendingLogin = {
      v: 1, app_id: app.appId, device_code: body.device_code, user_code: body.user_code,
      verification_uri: String(body.verification_uri ?? ''),
      verification_uri_complete: String(body.verification_uri_complete || body.verification_uri || ''),
      scope: scopes.join(' '), expires_at: this.now() + (Number(body.expires_in) || 240) * 1000,
      interval_s: interval, next_poll_at: this.now() + interval * 1000,
    };
    if (!pending.verification_uri_complete) throw new BridgeError('api', '飞书没有返回授权链接');
    await writeJsonAtomic(this.paths.login, pending);
    return this.prompt(pending, false);
  }

  /** Waits (at most `waitMs`, never more than 50 s) for the user to confirm; stores the login when they do. */
  async pollLogin(waitMs = 40_000): Promise<PollResult> {
    const app = this.credentials();
    const pending = await this.readPending();
    if (!pending) {
      const token = await this.readToken();
      if (token && this.loggedIn(token)) return this.authorized(token);
      throw new BridgeError('auth_required', '没有进行中的飞书授权，请先发起登录');
    }
    const deadline = this.now() + Math.min(Math.max(0, waitMs), MAX_WAIT_MS);
    const expiresIn = () => Math.max(0, Math.floor((pending.expires_at - this.now()) / 1000));
    const stillPending = (): PollResult => ({ state: 'pending', retry_after_s: Math.max(1, Math.ceil((pending.next_poll_at - this.now()) / 1000)), expires_in_s: expiresIn() });

    for (;;) {
      if (this.now() >= pending.expires_at) { await removeFile(this.paths.login); return { state: 'expired' }; }
      const wait = pending.next_poll_at - this.now();
      if (wait > 0) {
        if (this.now() + wait > deadline) return stillPending();
        await this.sleep(wait);
        continue;
      }
      let reply: { status: number; body: any };
      try {
        reply = await this.postForm(`${this.endpoints.accounts}${TOKEN_PATH}`,
          { grant_type: DEVICE_GRANT, device_code: pending.device_code, client_id: app.appId, client_secret: app.appSecret });
      } catch {
        // No answer: ask again a little later, within the allowed wait.
        pending.interval_s = Math.min(MAX_INTERVAL_S, pending.interval_s + 1);
        pending.next_poll_at = this.now() + pending.interval_s * 1000;
        await writeJsonAtomic(this.paths.login, pending);
        if (this.now() >= deadline) return stillPending();
        continue;
      }
      const { status, body } = reply;
      if (!body?.error && status < 400 && typeof body?.access_token === 'string' && body.access_token) {
        return this.finishLogin(body);
      }
      const error = typeof body?.error === 'string' ? body.error : '';
      if (error === 'authorization_pending' || error === 'slow_down') {
        if (error === 'slow_down') pending.interval_s = Math.min(MAX_INTERVAL_S, pending.interval_s + 5);
        pending.next_poll_at = this.now() + pending.interval_s * 1000;
        await writeJsonAtomic(this.paths.login, pending);
        if (this.now() + pending.interval_s * 1000 > deadline) return stillPending();
        continue;
      }
      await removeFile(this.paths.login);
      if (error === 'access_denied') return { state: 'denied' };
      if (error === 'expired_token' || error === 'invalid_grant') return { state: 'expired' };
      if (error === 'invalid_client') throw new BridgeError('config', '飞书应用凭证无效，请检查 FEISHU_APP_ID / FEISHU_APP_SECRET');
      throw new BridgeError('api', `飞书授权失败：${describe(body, `HTTP ${status}`)}`);
    }
  }

  private authorized(token: StoredToken): PollResult {
    const result: PollResult = { state: 'authorized', open_id: token.open_id, scopes: scopeList(token.scope), refreshable: !!token.refresh_token };
    if (token.name) result.name = token.name;
    return result;
  }

  private async finishLogin(body: any): Promise<PollResult> {
    const app = this.credentials();
    const access = String(body.access_token);
    const refresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined;
    const accessLife = (Number(body.expires_in) || 7200) * 1000;
    const refreshLife = refresh ? (Number(body.refresh_token_expires_in) || 604_800) * 1000 : accessLife;
    let info: any;
    try {
      info = await this.client.request({ method: 'GET', url: '/open-apis/authen/v1/user_info' }, lark.withUserAccessToken(access));
    } catch {
      await removeFile(this.paths.login);
      throw new BridgeError('api', '授权已完成，但无法读取授权账号信息，请重新发起授权');
    }
    const user = info?.data ?? info;
    const openId = typeof user?.open_id === 'string' ? user.open_id : '';
    if (!openId) { await removeFile(this.paths.login); throw new BridgeError('api', '无法确认授权账号，请重新发起授权'); }
    if (this.expected && openId !== this.expected) {
      // The token is dropped unread: somebody else's account must not end up in this user's directory.
      await removeFile(this.paths.login);
      throw new BridgeError('identity_mismatch', '授权的飞书账号与当前用户不是同一个人，已拒绝；请用本人账号重新授权');
    }
    const now = this.now();
    const token: StoredToken = {
      v: 1, app_id: app.appId, open_id: openId, access_token: access,
      access_expires_at: now + accessLife, refresh_expires_at: now + refreshLife,
      scope: typeof body.scope === 'string' ? body.scope : '', granted_at: now, refreshed_at: now,
    };
    if (typeof user?.name === 'string' && user.name) token.name = user.name;
    if (refresh) token.refresh_token = refresh;
    await withLock(this.paths.lock, () => writeJsonAtomic(this.paths.auth, token));
    await removeFile(this.paths.login);
    return this.authorized(token);
  }

  // ---- using the login ----------------------------------------------------------------------------------------------

  /** A user access token that is good for a call, renewed first when it is about to expire. */
  async accessToken(): Promise<string> {
    const token = await this.readToken();
    if (!token) throw new BridgeError('auth_required', '尚未登录飞书，请先授权');
    if (token.access_expires_at - SKEW_MS > this.now()) return token.access_token;
    return this.refresh(false);
  }

  /** Renews the token. The refresh token is single use, so this runs under a lock and checks again once it holds it. */
  async refresh(force: boolean): Promise<string> {
    this.credentials();
    return withLock(this.paths.lock, async () => {
      const current = await this.readToken();
      if (!current) throw new BridgeError('auth_required', '尚未登录飞书，请先授权');
      // Somebody else renewed it while this process waited for the lock.
      if (!force && current.access_expires_at - SKEW_MS > this.now()) return current.access_token;
      if (!current.refresh_token || current.refresh_expires_at <= this.now()) {
        await removeFile(this.paths.auth);
        throw new BridgeError('auth_required', '飞书登录已过期，请重新授权');
      }
      let reply;
      try {
        reply = await this.client.accessToken.refresh({ refreshToken: current.refresh_token });
      } catch (e) {
        if (e instanceof AccessTokenError && e.statusCode > 0) {
          const dead = e.error === 'invalid_grant' || [20037, 20064, 20073].includes(e.code);
          if (dead) {
            await removeFile(this.paths.auth);
            throw new BridgeError('auth_required', '飞书登录已失效（刷新令牌已过期、被撤销或已使用），请重新授权', e.code || undefined);
          }
          if (e.error === 'invalid_client') throw new BridgeError('config', '飞书应用凭证无效，请检查 FEISHU_APP_ID / FEISHU_APP_SECRET');
          throw new BridgeError('api', `刷新飞书登录失败：${e.message}`, e.code || undefined);
        }
        // No answer. The login stays: if the server did rotate the token, the next try says so with invalid_grant and clears it.
        throw new BridgeError('network', '无法连接飞书刷新登录，请稍后重试');
      }
      const now = this.now();
      const next: StoredToken = {
        ...current, access_token: reply.accessToken, access_expires_at: now + (Number(reply.expiresIn) || 7200) * 1000, refreshed_at: now,
        scope: reply.scope ?? current.scope,
      };
      if (reply.refreshToken) {
        next.refresh_token = reply.refreshToken;
        next.refresh_expires_at = now + (Number(reply.refreshTokenExpiresIn) || 604_800) * 1000;
      }
      await writeJsonAtomic(this.paths.auth, next);
      return next.access_token;
    });
  }
}
