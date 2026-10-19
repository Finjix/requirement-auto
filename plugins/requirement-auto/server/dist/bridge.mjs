import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameOf } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirnameOf(__filename);
import {
  BridgeError,
  FeishuAuth,
  REQUIRED_SCOPES,
  expectedOpenId,
  lark,
  loadApp,
  resolveDataPaths,
  toPayload
} from "./shared.mjs";

// src/api.ts
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
var TOKEN = /^[A-Za-z0-9]{8,64}$/;
var SHEET_ID = /^[A-Za-z0-9_-]{1,64}$/;
var A1 = /^[A-Za-z]{1,3}[0-9]{1,7}(:[A-Za-z]{1,3}[0-9]{1,7})?$/;
var OCCUPIED = /non[- ]?empty|occupied|cannot overwrite|not allowed to overwrite|already (has|contains)|非空|已有内容|不为空|禁止覆盖/i;
var TOKEN_REJECTED = /* @__PURE__ */ new Set([99991668, 99991677]);
var SCOPE_MISSING = /* @__PURE__ */ new Set([99991679, 99991672]);
var MAX_WRITES = 100;
var READ_ALLOWLIST = [
  /^\/open-apis\/wiki\/v2\/spaces\/get_node$/,
  /^\/open-apis\/sheets\/v3\/spreadsheets\/[A-Za-z0-9]+\/sheets\/query$/,
  /^\/open-apis\/sheets\/v2\/spreadsheets\/[A-Za-z0-9]+\/(dataValidation|values_batch_get|metainfo)$/,
  /^\/open-apis\/docx\/v1\/documents\/[A-Za-z0-9]+\/raw_content$/
];
var FeishuApi = class {
  auth;
  sleep;
  constructor(auth, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.auth = auth;
    this.sleep = sleep;
  }
  async send(call, again = true) {
    const token = await this.auth.accessToken();
    let result;
    try {
      const payload = { method: call.method, url: call.url };
      if (call.params) payload.params = call.params;
      if (call.data !== void 0) payload.data = call.data;
      if (call.stream) payload.responseType = "stream";
      result = await this.auth.client.request(payload, lark.withUserAccessToken(token));
    } catch (e) {
      if (e?.response) {
        const body = e.response.data;
        const parsed = body && typeof body === "object" && !("pipe" in body) ? body : {};
        return this.failure(call, parsed, e.response.status, again);
      }
      throw new BridgeError(
        call.write ? "unknown_result" : "network",
        call.write ? "\u98DE\u4E66\u5199\u5165\u8BF7\u6C42\u6CA1\u6709\u6536\u5230\u7ED3\u679C\uFF0C\u5199\u5165\u53EF\u80FD\u5DF2\u751F\u6548\uFF1B\u5FC5\u987B\u56DE\u8BFB\u6838\u5BF9\uFF0C\u4E0D\u53EF\u91CD\u53D1" : "\u65E0\u6CD5\u8FDE\u63A5\u98DE\u4E66"
      );
    }
    if (call.stream) return result;
    if (result && typeof result === "object" && typeof result.code === "number" && result.code !== 0) return this.failure(call, result, 200, again);
    return result && typeof result === "object" && "data" in result ? result.data : result;
  }
  async failure(call, body, status, again) {
    const code = typeof body?.code === "number" ? body.code : void 0;
    const message = String(body?.msg ?? body?.message ?? body?.error_description ?? `HTTP ${status}`);
    if (code !== void 0 && TOKEN_REJECTED.has(code)) {
      if (again && !call.write) {
        await this.auth.refresh(true);
        return this.send(call, false);
      }
      throw new BridgeError("auth_required", "\u98DE\u4E66\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u6388\u6743", code);
    }
    if (code !== void 0 && SCOPE_MISSING.has(code)) throw new BridgeError("scope_missing", `\u98DE\u4E66\u767B\u5F55\u7F3A\u5C11\u8C03\u7528\u6240\u9700\u7684\u6743\u9650\uFF1B\u8BF7\u5728\u5E94\u7528\u540E\u53F0\u5F00\u901A\u5E76\u91CD\u65B0\u6388\u6743\uFF08${message}\uFF09`, code);
    if (call.write && OCCUPIED.test(message)) throw new BridgeError("occupied", "\u670D\u52A1\u7AEF\u62D2\u7EDD\u5199\u5165\u975E\u7A7A\u76EE\u6807", code);
    if (call.write && status >= 500) throw new BridgeError("unknown_result", `\u98DE\u4E66\u5199\u5165\u8FD4\u56DE ${status}\uFF0C\u5199\u5165\u53EF\u80FD\u5DF2\u751F\u6548\uFF1B\u5FC5\u987B\u56DE\u8BFB\u6838\u5BF9\uFF0C\u4E0D\u53EF\u91CD\u53D1`, code);
    throw new BridgeError("api", `\u98DE\u4E66\u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF\uFF1A${message}`, code);
  }
  /** A read-only call to one of the endpoints the workflow uses. */
  async get(urlPath, params) {
    if (typeof urlPath !== "string" || urlPath.includes("..") || urlPath.includes("?") || !urlPath.startsWith("/open-apis/") || !READ_ALLOWLIST.some((pattern) => pattern.test(urlPath))) {
      throw new BridgeError("invalid_request", "\u672A\u8BB8\u53EF\u7684\u98DE\u4E66\u8BFB\u53D6\u8DEF\u5F84");
    }
    const query = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new BridgeError("invalid_request", `\u53C2\u6570 ${key} \u7C7B\u578B\u4E0D\u652F\u6301`);
      query[key] = value;
    }
    return this.send({ method: "GET", url: urlPath, params: query });
  }
  /** The workbook version. The same endpoint is read before and after, so only the change matters, not what the number means. */
  async revision(token) {
    this.checkToken(token);
    const data = await this.send({ method: "GET", url: `/open-apis/sheets/v2/spreadsheets/${token}/metainfo` });
    const value = data?.properties?.revision;
    if (!Number.isSafeInteger(value) || value < 0) throw new BridgeError("api", "\u65E0\u6CD5\u8BFB\u53D6\u6587\u6863\u7248\u672C");
    return value;
  }
  /** Exports the whole workbook as a new XLSX file; an existing file is never replaced. */
  async exportXlsx(token, output) {
    this.checkToken(token);
    if (!path.isAbsolute(output) || !output.toLowerCase().endsWith(".xlsx")) throw new BridgeError("invalid_request", "\u5BFC\u51FA\u8DEF\u5F84\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84\u7684 .xlsx \u6587\u4EF6");
    if (await fs.stat(output).then(() => true, () => false)) throw new BridgeError("invalid_request", "\u5BFC\u51FA\u76EE\u6807\u6587\u4EF6\u5DF2\u5B58\u5728\uFF0C\u4E0D\u4F1A\u8986\u76D6");
    await fs.mkdir(path.dirname(output), { recursive: true });
    const created = await this.send({ method: "POST", url: "/open-apis/drive/v1/export_tasks", data: { file_extension: "xlsx", token, type: "sheet" } });
    const ticket = created?.ticket;
    if (typeof ticket !== "string" || !ticket) throw new BridgeError("api", "\u5BFC\u51FA\u4EFB\u52A1\u6CA1\u6709\u8FD4\u56DE\u7F16\u53F7");
    let fileToken = "";
    for (let attempt = 0; attempt < 40 && !fileToken; attempt++) {
      if (attempt) await this.sleep(Math.min(3e3, 500 + attempt * 250));
      const polled = await this.send({ method: "GET", url: `/open-apis/drive/v1/export_tasks/${encodeURIComponent(ticket)}`, params: { token } });
      const job = polled?.result;
      if (job?.job_status === 0 && typeof job.file_token === "string") fileToken = job.file_token;
      else if (job && job.job_status !== 1 && job.job_status !== 2) throw new BridgeError("api", `\u5BFC\u51FA\u5931\u8D25\uFF1A${job.job_error_msg ?? job.job_status}`);
    }
    if (!fileToken) throw new BridgeError("api", `\u5BFC\u51FA\u4EFB\u52A1\u4ECD\u672A\u5B8C\u6210\uFF08ticket=${ticket}\uFF09\uFF1B\u7A0D\u540E\u53EA\u8BFB\u67E5\u8BE2\u8BE5\u4EFB\u52A1\uFF0C\u4E0D\u8981\u91CD\u65B0\u63D0\u4EA4`);
    const stream = await this.send({ method: "GET", url: `/open-apis/drive/v1/export_tasks/file/${encodeURIComponent(fileToken)}/download`, stream: true });
    try {
      await pipeline(stream, createWriteStream(output, { flags: "wx" }));
      const size = (await fs.stat(output)).size;
      const head = Buffer.alloc(2);
      const handle = await fs.open(output, "r");
      try {
        await handle.read(head, 0, 2, 0);
      } finally {
        await handle.close();
      }
      if (size < 22 || head.toString("latin1") !== "PK") throw new BridgeError("api", "\u5BFC\u51FA\u7684\u6587\u4EF6\u4E0D\u662F\u6709\u6548\u7684 XLSX");
      return { path: output, bytes: size };
    } catch (e) {
      await fs.rm(output, { force: true });
      throw e;
    }
  }
  /**
   * Writes cell ranges without ever overwriting: the server is told allow_overwrite=false for every range and refuses when a
   * target cell is not empty. Same request as `lark-cli sheets +cells-set --allow-overwrite=false` (captured with its --dry-run).
   */
  async cellsSet(token, writes) {
    this.checkToken(token);
    if (!Array.isArray(writes) || writes.length < 1 || writes.length > MAX_WRITES) throw new BridgeError("invalid_request", `\u5199\u5165\u8303\u56F4\u6570\u5FC5\u987B\u5728 1 \u5230 ${MAX_WRITES} \u4E4B\u95F4`);
    const operations = writes.map((write) => {
      if (write?.allow_overwrite !== false) throw new BridgeError("invalid_request", "\u7F3A\u5C11\u4E0D\u53EF\u8986\u76D6\u4FDD\u62A4\uFF08allow_overwrite \u5FC5\u987B\u4E3A false\uFF09");
      if (!SHEET_ID.test(write.sheet_id ?? "") || !A1.test(write.range ?? "")) throw new BridgeError("invalid_request", "\u5199\u5165\u8303\u56F4\u683C\u5F0F\u65E0\u6548");
      if (!Array.isArray(write.cells) || !write.cells.length || !write.cells.every((row) => Array.isArray(row) && row.length)) throw new BridgeError("invalid_request", "\u5199\u5165\u5185\u5BB9\u5FC5\u987B\u662F\u4E8C\u7EF4\u6570\u7EC4");
      return { input: { allow_overwrite: false, cells: write.cells, excel_id: token, range: write.range, sheet_id: write.sheet_id }, tool_name: "set_cell_range" };
    });
    return this.send({
      method: "POST",
      write: true,
      url: `/open-apis/sheet_ai/v2/spreadsheets/${token}/tools/invoke_write`,
      data: { input: JSON.stringify({ excel_id: token, operations }), tool_name: "batch_update" }
    });
  }
  /** Creates a new, empty workbook. Only the isolated safety probe uses it. */
  async createWorkbook(title) {
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new BridgeError("invalid_request", "\u8868\u683C\u6807\u9898\u65E0\u6548");
    const data = await this.send({ method: "POST", write: true, url: "/open-apis/sheets/v3/spreadsheets", data: { title } });
    const sheet = data?.spreadsheet;
    if (typeof sheet?.spreadsheet_token !== "string") throw new BridgeError("unknown_result", "\u65B0\u5EFA\u8868\u683C\u7684\u7ED3\u679C\u65E0\u6CD5\u786E\u8BA4\uFF0C\u4E0D\u8981\u91CD\u590D\u521B\u5EFA");
    return { spreadsheet_token: sheet.spreadsheet_token, ...sheet.url ? { url: sheet.url } : {} };
  }
  checkToken(token) {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new BridgeError("invalid_request", "\u8868\u683C token \u683C\u5F0F\u65E0\u6548");
  }
};

// src/bridge.ts
var BRIDGE_VERSION = "feishu-sdk-bridge/1";
var INPUT_COMMANDS = /* @__PURE__ */ new Set([
  "auth-login",
  "auth-poll",
  "auth-check-scopes",
  "api-get",
  "sheets-revision",
  "sheets-export",
  "sheets-cells-set",
  "sheets-create"
]);
function object(input, command2) {
  if (input === void 0 || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new BridgeError("invalid_request", `${command2} \u9700\u8981 JSON \u5BF9\u8C61\u53C2\u6570`);
  return input;
}
function strings(value, name) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length < 200)) throw new BridgeError("invalid_request", `${name} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4`);
  return value;
}
async function runBridge(command2, input, context = {}) {
  const env = context.env ?? process.env;
  let auth;
  try {
    const paths = resolveDataPaths(env);
    let app, missingApp;
    try {
      app = loadApp(env, paths);
    } catch (e) {
      if (command2 !== "auth-status" && command2 !== "auth-logout" && command2 !== "info") throw e;
      missingApp = e.message;
    }
    auth = new FeishuAuth({ paths, app, missingApp, expectedOpenId: expectedOpenId(env), ...context.endpoints ? { endpoints: context.endpoints } : {} });
    const api = new FeishuApi(auth);
    const args = object(input, command2);
    let data;
    switch (command2) {
      case "info":
        data = { bridge: BRIDGE_VERSION, node: process.version, storage: paths.mode, app_configured: !!app, required_scopes: REQUIRED_SCOPES };
        break;
      case "auth-status":
        data = await auth.status();
        break;
      case "auth-login":
        data = await auth.startLogin(strings(args.extra_scopes, "extra_scopes"));
        break;
      case "auth-poll":
        data = await auth.pollLogin(typeof args.wait_ms === "number" ? args.wait_ms : void 0);
        break;
      case "auth-logout":
        await auth.logout();
        data = { logged_in: false };
        break;
      case "auth-check-scopes": {
        const required = strings(args.required, "required");
        const status = await auth.status(required);
        data = { complete: status.logged_in && !status.missing_scopes?.length, granted: status.scopes ?? [], missing: status.logged_in ? status.missing_scopes ?? [] : required };
        break;
      }
      case "api-get":
        data = await api.get(String(args.path ?? ""), object(args.params, "params"));
        break;
      case "sheets-revision":
        data = { revision: await api.revision(String(args.token ?? "")) };
        break;
      case "sheets-export":
        data = await api.exportXlsx(String(args.token ?? ""), String(args.output ?? ""));
        break;
      case "sheets-cells-set":
        data = await api.cellsSet(String(args.token ?? ""), args.writes);
        break;
      case "sheets-create":
        data = await api.createWorkbook(String(args.title ?? ""));
        break;
      default:
        throw new BridgeError("invalid_request", `\u672A\u77E5\u547D\u4EE4\uFF1A${command2}`);
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: toPayload(error, await auth?.secrets().catch(() => []) ?? []) };
  }
}

// src/cli.ts
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
var command = process.argv[2] ?? "";
var reply;
try {
  const text = INPUT_COMMANDS.has(command) ? (await readStdin()).trim() : "";
  reply = await runBridge(command, text ? JSON.parse(text) : void 0);
} catch {
  reply = { ok: false, error: { kind: "invalid_request", message: "\u6807\u51C6\u8F93\u5165\u4E0D\u662F\u6709\u6548\u7684 JSON" } };
}
process.stdout.write(`${JSON.stringify(reply)}
`);
process.exitCode = reply.ok ? 0 : 2;
