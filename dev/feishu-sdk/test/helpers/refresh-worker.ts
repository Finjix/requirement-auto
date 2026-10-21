// Child process of the concurrency test: asks for an access token the way a separate bridge or gof process would.
import { FeishuAuth } from '../../src/auth.ts';
import { resolveDataPaths } from '../../src/paths.ts';

const { MOCK_URL, MOCK_APP_ID, MOCK_APP_SECRET, LARK_AGENT_USER_DIR, FAKE_NOW } = process.env;
const offset = Number(FAKE_NOW ?? 0);
const auth = new FeishuAuth({
  paths: resolveDataPaths({ LARK_AGENT_USER_DIR }), app: { appId: MOCK_APP_ID!, appSecret: MOCK_APP_SECRET! },
  endpoints: { open: MOCK_URL!, accounts: MOCK_URL! }, now: () => Date.now() + offset,
});
try {
  process.stdout.write(JSON.stringify({ ok: true, token: await auth.accessToken() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, kind: (error as { kind?: string }).kind, message: (error as Error).message }));
}
