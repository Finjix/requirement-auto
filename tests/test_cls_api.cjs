const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
const { createClsAdapter } = require('../skills/gof-requirement/scripts/cls_api.js');

const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' :
  v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const hash = v => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
function op(action = 'save_draft', quantity = 60) {
  const value = { schema: 1, action, plan_id: 'plan', group: '01', account_id: 1565,
    payload: { game_id: 94, direct_id: 390, asset_data: '', name: '独立接口测试', type: 'video', company: '', departments: [],
      marketing_user_id: '', third_user_id: 663, currency: 'cny', price: 0, price_reason: '需求说明', expect_end_date: '',
      storyboard_end_date: '', storyboard_attaches: [], draft_end_date: '', draft_attaches: [], film_end_date: '', film_attaches: [], status: -2 },
    native_defaults: { currency: 'cny', price: 0 },
    expected: { quantity, creator_id: 653, names: Array.from({ length: quantity }, (_, i) => `GOFCN${1002 + i}_中文_"A,B"_关键词`),
      link: 'https://centurygames.feishu.cn/docx/ConfirmedScript', tag_names: ['玩法卖点（单选，必选）/展示向/展示向'] } };
  if (action === 'import_scripts') {
    value.draft_id = 10224;
    const quote = s => '"' + s.replaceAll('"', '""') + '"';
    const rows = [['脚本名称', '脚本内容', '创意标签'], ...value.expected.names.map((name, i) => [name, i ? '同上' : value.expected.link, value.expected.tag_names[0]])];
    const bytes = Buffer.from('\uFEFF' + rows.map(r => r.map(quote).join(',')).join('\r\n') + '\r\n', 'utf8');
    value.csv = { filename: '中文测试.csv', base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  value.operation_id = hash(value);
  return value;
}
function setup(operation, options = {}) {
  const posted = [], calls = [];
  let parent = { ...operation.payload, price: '0.00', id: 10224, number: 'GOFCN20261013003', is_edit: true,
    user_id: 1565, for_internal: 0, sub_scripts: options.existing || [] };
  const data = {
    '/api/games': [{ id: 94, name: '无尽冬日', code: 'GOFCN' }],
    '/api/users': [{ id: 653, name: '张天伟', status: 1, roles: ['creative_plan'] }, { id: 663, name: '供应商（丁杰）', status: 1, roles: ['outsource'] }],
    '/api/userinfo': { id: 1565, name: '测试账号', status: 1, roles: ['creative_plan'], game_ids: [94] },
    '/api/user/roles': { roles: ['creative_plan'] },
    '/api/permissions': { creative_plan: options.noPermission ? [] : ['workflow.script.save', 'workflow.script.edit'] },
    '/api/workflow/filters': { types: [{ key: '视频', value: 'video', type: 'creative' }], currencies: [], company: [], departments: [] },
    '/api/workflow/directs': [{ id: 390, name: '2D剪辑', game_id: 94 }] };
  const fetch = async (path, init) => {
    calls.push({ path, method: init.method });
    assert.equal(init.redirect, 'error');
    if (init.method === 'POST') {
      posted.push({ path, init });
      if (options.unknown) throw new Error('Network failed');
      if (options.businessFailure) return { status: 200, json: async () => ({ code: 403, data: null }) };
      if (path === '/api/workflow/script/save') {
        const payload = JSON.parse(init.body);
        assert.equal(payload.status, -2);
        assert.equal(Object.hasOwn(payload, 'id'), false);
        parent = { ...parent, ...payload };
        return { status: 200, json: async () => ({ code: 0, data: { id: 10224, status: -2 } }) };
      }
      assert.equal(path, '/api/workflow/sub-script/multiple-add');
      assert.deepEqual([...init.body.keys()], ['script_id', 'file', 'user_id']);
      assert.equal(init.headers['Content-Type'], undefined);
      assert.equal(init.body.get('user_id'), '653');
      parent.sub_scripts = operation.expected.names.map((name, i) => ({ id: 200000 + i, script_id: 10224, name,
        data: i ? '同上' : operation.expected.link, user_id: options.wrongCreator ? 1 : 653,
        tags: [{ id: 2257, full_name: '玩法卖点（单选必选）/展示向/展示向' }] }));
      if (options.wrongCount) parent.sub_scripts.pop();
      return { status: 200, json: async () => ({ code: 0, data: parent.sub_scripts.map(s => s.id) }) };
    }
    if (path === '/api/workflow/script/10224') {
      const result = { ...parent, status: options.published ? -1 : parent.status };
      return { status: 200, json: async () => ({ code: 0, data: { script: result } }) };
    }
    assert.ok(Object.hasOwn(data, path), path);
    return { status: 200, json: async () => ({ code: 0, data: data[path] }) };
  };
  return { api: createClsAdapter({ origin: 'https://creative.centurygames.cn', authorization: 'SESSION_TEST_ONLY', crypto: webcrypto, fetch }), posted, calls };
}
test('catalog contains current role permissions and no credentials', async () => {
  const { api } = setup(op());
  const c = await api.readCatalog();
  assert.equal(c.can_create, true);
  assert.equal(c.account.id, 1565);
  assert.equal(JSON.stringify(c).includes('SESSION_TEST_ONLY'), false);
});
test('create draft forces status -2, readback, safe receipts, no duplicate save', async () => {
  const operation = op(), { api, posted } = setup(operation);
  const receipt = await api.createDraft(operation);
  assert.equal(receipt.parent.status, -2);
  assert.equal(receipt.parent.number, 'GOFCN20261013003');
  assert.equal(receipt.calls.length, 2);
  assert.equal(JSON.stringify(receipt).includes('SESSION_TEST_ONLY'), false);
  await assert.rejects(api.createDraft(operation), /已尝试/);
  assert.equal(posted.length, 1);
});
test('60-script CSV Chinese, comma and quote escaping; multipart and all names checked', async () => {
  const operation = op('import_scripts'), { api, posted } = setup(operation);
  const receipt = await api.importScripts(operation);
  assert.equal(receipt.parent.sub_scripts.length, 60);
  assert.equal(receipt.parent.sub_scripts[59].name, operation.expected.names[59]);
  assert.equal(posted.length, 1);
  await assert.rejects(api.importScripts(operation), /已有脚本/);
  assert.equal(posted.length, 1);
});
test('publish, existing-id update, attachment upload and tampered inputs are refused before POST', async () => {
  for (const mutate of [o => o.action = 'publish', o => o.payload.status = -1, o => o.payload.id = 10224,
    o => o.payload.film_attaches = ['file'], o => o.payload.name = 'tampered']) {
    const operation = op(); mutate(operation);
    if (operation.payload.id || operation.payload.status !== -2 || operation.payload.film_attaches.length) {
      delete operation.operation_id; operation.operation_id = hash(operation);
    }
    const { api, posted } = setup(operation);
    await assert.rejects(api.createDraft(operation));
    assert.equal(posted.length, 0);
  }
});
test('no permission, wrong origin and existing scripts do not submit', async () => {
  const operation = op('import_scripts');
  for (const options of [{ noPermission: true }, { existing: [{ id: 1 }] }, { published: true }]) {
    const { api, posted } = setup(operation, options);
    await assert.rejects(api.importScripts(operation));
    assert.equal(posted.length, 0);
  }
  assert.throws(() => createClsAdapter({ origin: 'https://evil.example', authorization: 'SESSION' }));
});
test('unknown create result and business failure are never blindly retried', async () => {
  for (const options of [{ unknown: true }, { businessFailure: true }]) {
    const operation = op(), { api, posted } = setup(operation, options);
    await assert.rejects(api.createDraft(operation));
    await assert.rejects(api.createDraft(operation), /已尝试/);
    assert.equal(posted.length, 1);
  }
});
test('changed creator or count is not a verified import', async () => {
  for (const options of [{ wrongCreator: true }, { wrongCount: true }]) {
    const operation = op('import_scripts'), { api, posted } = setup(operation, options);
    await assert.rejects(api.importScripts(operation));
    assert.equal(posted.length, 1);
  }
});
test('CSV corruption is refused before upload', async () => {
  const operation = op('import_scripts');
  operation.csv.base64 = Buffer.from('bad').toString('base64');
  delete operation.operation_id; operation.operation_id = hash(operation);
  const { api, posted } = setup(operation);
  await assert.rejects(api.importScripts(operation), /CSV/);
  assert.equal(posted.length, 0);
});
