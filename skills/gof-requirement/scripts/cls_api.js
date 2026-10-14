"use strict";
// Loaded in a lexical module wrapper by cua_repl/CDP. No DOM edits or credential storage.
function createClsAdapter(config) {
  const ORIGIN = "https://creative.centurygames.cn";
  if (config.origin !== ORIGIN || typeof config.authorization !== "string" || !config.authorization) {
    throw new Error("必须使用 CLS 当前同源登录会话");
  }
  const fetcher = config.fetch;
  const webCrypto = config.crypto;
  if (typeof fetcher !== "function" || !webCrypto?.subtle) throw new Error("缺少受支持的 HTTP/摘要能力");
  const calls = [];
  const attempted = new Set();
  const fields = ["game_id", "direct_id", "asset_data", "name", "type", "company", "departments",
    "marketing_user_id", "third_user_id", "currency", "price", "price_reason", "expect_end_date",
    "storyboard_end_date", "storyboard_attaches", "draft_end_date", "draft_attaches", "film_end_date", "film_attaches", "status"];
  const fixedTags = ["玩法卖点（单选，必选）/展示向/展示向", "玩法卖点（单选必选）/展示向/展示向"];
  const fail = (message, kind = "blocked") => { const e = new Error(message); e.kind = kind; throw e; };
  const assert = (condition, message) => { if (!condition) fail(message); };
  const id = value => { assert(Number.isSafeInteger(value) && value > 0, "ID 无效"); return value; };
  const canonical = value => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
    return JSON.stringify(value);
  };
  const sha = async bytes => Array.from(new Uint8Array(await webCrypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  async function request(method, path, body) {
    const readPaths = ["/api/games", "/api/users", "/api/userinfo", "/api/user/roles", "/api/permissions", "/api/workflow/filters", "/api/workflow/directs"];
    const allowed = method === "GET" && (readPaths.includes(path) || /^\/api\/workflow\/script\/[1-9]\d*$/.test(path)) ||
      method === "POST" && ["/api/workflow/script/save", "/api/workflow/sub-script/multiple-add"].includes(path);
    assert(allowed, "发布、素材上传、删除和未知路径均被禁止");
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs || 30000);
    const headers = { Authorization: config.authorization };
    const init = { method, headers, credentials: "same-origin", redirect: "error", signal: controller.signal };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    let response, json;
    try {
      response = await fetcher(path, init);
      json = await response.json();
    } catch {
      fail(method === "POST" ? "写入结果未知；先回读，不重试" : "CLS 读取失败", method === "POST" ? "unknown" : "blocked");
    } finally { clearTimeout(timer); }
    calls.push({ method, path, http_status: response.status, business_code: json.code, elapsed_ms: Date.now() - start });
    assert(response.status >= 200 && response.status < 300 && json.code === 0, "CLS HTTP/业务码失败；停止并核对现状");
    return json.data;
  }
  async function readCatalog() {
    const [games, users, account, roles, permissions, filters, directions] = await Promise.all([
      "/api/games", "/api/users", "/api/userinfo", "/api/user/roles", "/api/permissions", "/api/workflow/filters", "/api/workflow/directs"
    ].map(path => request("GET", path)));
    assert(Array.isArray(games) && Array.isArray(users) && Array.isArray(directions) && Array.isArray(roles.roles), "CLS 选项结构变化，停止");
    assert(account.status === 1 && Array.isArray(account.game_ids) && account.roles?.every(x => roles.roles.includes(x)), "当前账号/角色无法核对");
    const granted = new Set(roles.roles.flatMap(role => permissions[role] || []));
    return { schema: 1, observed_at: new Date().toISOString(),
      account: { id: account.id, name: account.name, status: account.status, roles: roles.roles, game_ids: account.game_ids },
      can_create: granted.has("workflow.script.save"), can_import: granted.has("workflow.script.edit"),
      games: games.map(({ id, name, code }) => ({ id, name, code })),
      users: users.map(({ id, name, status, roles }) => ({ id, name, status, roles })),
      directions: directions.map(({ id, name, game_id }) => ({ id, name, game_id })),
      types: filters.types, currencies: filters.currencies, companies: filters.company, departments: filters.departments };
  }
  async function validateOperation(op) {
    assert(op?.schema === 1 && ["save_draft", "import_scripts"].includes(op.action), "只允许新建草稿及本批脚本导入");
    const unsealed = { ...op }; delete unsealed.operation_id;
    assert(await sha(new TextEncoder().encode(canonical(unsealed))) === op.operation_id, "操作文件摘要错误");
    assert(op.payload && Object.keys(op.payload).length === fields.length && fields.every(k => Object.hasOwn(op.payload, k)), "草稿字段未知或缺失");
    assert(op.payload.status === -2 && !Object.hasOwn(op.payload, "id") && op.payload.asset_data === "", "只允许创建未发布草稿，禁止更新已有需求");
    assert(["storyboard_attaches", "draft_attaches", "film_attaches"].every(k => Array.isArray(op.payload[k]) && op.payload[k].length === 0), "素材/附件上传不在范围内");
    assert(op.expected.names.length === op.expected.quantity && new Set(op.expected.names).size === op.expected.quantity && op.expected.quantity > 0, "脚本数量/名称不符");
    id(op.account_id); id(op.expected.creator_id); id(op.payload.game_id); id(op.payload.direct_id); id(op.payload.third_user_id);
    const current = await readCatalog();
    assert(current.account.id === op.account_id && current.can_create, "账号或建单权限变化");
    assert(current.account.game_ids.includes(op.payload.game_id) && current.games.some(g => g.id === op.payload.game_id && g.code === "GOFCN"), "不是获批 GOFCN 项目");
    assert(current.directions.some(d => d.id === op.payload.direct_id && d.game_id === op.payload.game_id), "创意方向变化");
    assert(current.users.some(u => u.id === op.payload.third_user_id && u.status === 1 && u.roles.includes("outsource")) &&
      current.users.some(u => u.id === op.expected.creator_id && u.status === 1), "供应商/创意人失效");
    if (op.action === "import_scripts") { id(op.draft_id); assert(current.can_import, "没有脚本编辑/导入权限"); }
  }
  async function readDraft(draftId) {
    const data = await request("GET", "/api/workflow/script/" + id(draftId));
    const source = data?.script;
    assert(source && source.id === draftId && Array.isArray(source.sub_scripts), "草稿回读结构变化");
    const parent = { id: source.id, number: source.number, is_edit: source.is_edit,
      user_id: source.user_id, for_internal: source.for_internal };
    for (const key of fields.filter(k => k !== "asset_data")) parent[key] = source[key];
    parent.sub_scripts = source.sub_scripts.map(s => ({ id: s.id, script_id: s.script_id, name: s.name,
      data: s.data, user_id: s.user_id, tags: s.tags?.map(t => ({ id: t.id, full_name: t.full_name })) }));
    return parent;
  }
  function assertParent(parent, op) {
    assert(parent.status === -2, "需求不是未发布草稿");
    assert(parent.user_id === op.account_id && (parent.for_internal === 0 || parent.for_internal === false), "不是本账号的外包需求草稿");
    for (const key of fields.filter(k => k !== "asset_data")) {
      const value = parent[key], wanted = op.payload[key];
      const equal = key === "price" ? value !== null && Number.isFinite(Number(value)) && Number(value) === Number(wanted) :
        wanted === "" && value == null ? true : canonical(value) === canonical(wanted);
      assert(equal, "草稿回读字段不符：" + key);
    }
  }
  function assertScripts(parent, op) {
    const scripts = parent.sub_scripts;
    assert(scripts.length === op.expected.quantity && new Set(scripts.map(s => s.id)).size === scripts.length, "导入条数/脚本 ID 不符");
    scripts.forEach((s, i) => {
      assert(s.script_id === parent.id && s.name === op.expected.names[i] && s.user_id === op.expected.creator_id &&
        s.data === (i === 0 ? op.expected.link : "同上") && s.tags?.some(t => fixedTags.includes(t.full_name)), "导入名称/归属/链接/标签不符");
    });
  }
  async function verify(op, draftId, start = calls.length) {
    const parent = await readDraft(draftId);
    assertParent(parent, op);
    if (op.action === "save_draft") assert(parent.sub_scripts.length === 0, "新草稿已有脚本，停止");
    else assertScripts(parent, op);
    return { schema: 1, transport: "cls_api", status: "verified", action: op.action,
      operation_id: op.operation_id, unpublished: true, parent, calls: calls.slice(start) };
  }
  function csvRows(text) {
    const rows = []; let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
      else if (!quoted && c === ",") { row.push(cell); cell = ""; }
      else if (!quoted && c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
      else cell += c;
    }
    assert(!quoted && row.length === 0 && cell === "", "CSV 转义或 CRLF 结尾异常");
    return rows;
  }
  async function createDraft(op) {
    assert(op.action === "save_draft", "请求动作不符");
    await validateOperation(op);
    assert(!attempted.has(op.operation_id), "本会话已尝试此请求，不自动重试");
    attempted.add(op.operation_id);
    const start = calls.length;
    const created = await request("POST", "/api/workflow/script/save", op.payload);
    const draftId = id(created?.id);
    assert(created.status === -2, "创建结果不是草稿，停止");
    try { return await verify(op, draftId, start); }
    catch (e) { e.draft_id = draftId; e.operation_id = op.operation_id; throw e; }
  }
  async function importScripts(op) {
    assert(op.action === "import_scripts", "请求动作不符");
    await validateOperation(op);
    const start = calls.length;
    const parent = await readDraft(op.draft_id);
    assertParent(parent, op);
    assert(parent.is_edit === true || parent.is_edit === 1, "当前草稿不可编辑");
    assert(parent.sub_scripts.length === 0, "草稿已有脚本；先核对，不导入");
    assert(!attempted.has(op.operation_id), "本会话已尝试此导入，不自动重试");
    assert(typeof op.csv?.filename === "string" && /^[^/\\\r\n]+\.csv$/i.test(op.csv.filename), "只允许本批 CSV 脚本文件");
    const binary = atob(op.csv.base64), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && await sha(bytes) === op.csv.sha256, "CSV 编码/摘要错误");
    const rows = csvRows(new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(3)));
    const expected = [["脚本名称", "脚本内容", "创意标签"], ...op.expected.names.map((n, i) => [n, i === 0 ? op.expected.link : "同上", fixedTags[0]])];
    assert(canonical(rows) === canonical(expected), "CSV 与获批需求不一致");
    const form = new FormData();
    form.append("script_id", String(op.draft_id));
    form.append("file", new File([bytes], op.csv.filename, { type: "text/csv" }));
    form.append("user_id", String(op.expected.creator_id));
    attempted.add(op.operation_id);
    await request("POST", "/api/workflow/sub-script/multiple-add", form);
    try { return await verify(op, op.draft_id, start); }
    catch (e) { e.draft_id = op.draft_id; e.operation_id = op.operation_id; throw e; }
  }
  return Object.freeze({ readCatalog, readDraft, createDraft, importScripts, verify });
}
module.exports = { createClsAdapter };
