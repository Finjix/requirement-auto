import * as lark from '@larksuiteoapi/node-sdk';
import type { AppCredentials, Endpoints } from './config.ts';

/**
 * The SDK client every call goes through. Its own logs are discarded: they can carry request details, and stdout belongs to the
 * MCP protocol. Only user access tokens are used, so the client never asks for a tenant token.
 */
export function createClient(app: AppCredentials, endpoints: Endpoints): lark.Client {
  const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  lark.defaultHttpInstance.defaults.timeout = 30_000;
  return new lark.Client({
    appId: app.appId, appSecret: app.appSecret, appType: lark.AppType.SelfBuild,
    domain: endpoints.open, oauthBaseUrl: endpoints.accounts, logger: quiet, disableTokenCache: true,
  });
}

export { lark };
