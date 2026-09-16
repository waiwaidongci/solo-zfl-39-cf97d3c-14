import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "days": 5,
      "owner": "林素",
      "status": "发酵中",
      "logs": [
        {
          "at": "2026-06-15",
          "step": "观察",
          "note": "温度24.6，气味微酸，纤维开始松散",
          "abnormal": false
        }
      ]
    }
  ]
};
const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","可抄纸","异常观察"];
const statLabels = ["入缸","发酵中","可抄纸","异常观察"];
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];

// 内部质量审核常量
const AUDIT_STATUSES = ["计划中", "审核中", "已完成"];
const NC_STATUSES = ["待整改", "待复核", "已复核", "已关闭"];
const SEVERITIES = ["高", "中", "低"];
const HIGH_SEVERITY = "高";

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const bad = (message, details) => new HttpError(400, "validation_failed", message, details);
const conflict = (code, message, details) => new HttpError(409, code, message, details);
const notFound = (what) => new HttpError(404, "not_found", what + "不存在");

const s = (v) => String(v ?? "").trim();
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
let uidCounter = 0;
function uid(prefix) {
  return prefix + "-" + Date.now().toString(36) + (uidCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
}
function requireFields(input, fieldLabels) {
  const missing = Object.entries(fieldLabels).filter(([key]) => !s(input[key])).map(([, label]) => label);
  if (missing.length) throw bad("缺少必填字段: " + missing.join("、"), { missing });
}
// 只接受真实存在的日历日期（YYYY-MM-DD），拒绝 2026-02-30、2026-13-01 之类
function isCalendarDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}
function requireDate(input, key, label) {
  if (!isCalendarDate(s(input[key]))) throw bad(label + "必须是真实存在的日历日期（YYYY-MM-DD）");
}
// 幂等键按操作范围隔离：方法 + 路径 + 规范化请求体 的指纹一致才允许回放
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}
function requestFingerprint(method, path, input) {
  return createHash("sha256").update(method + " " + path + " " + canonical(input)).digest("hex");
}

// 升级迁移：保留已有台账、审核、不符合项与幂等数据，历史项标“待复核”，绝不自动关闭任何记录
function migrate(db) {
  let changed = false;
  if (!Array.isArray(db.items)) { db.items = []; changed = true; }
  for (const item of db.items) {
    if (!item.reviewStatus) { item.reviewStatus = "待复核"; changed = true; }
  }
  if (!Array.isArray(db.audits)) { db.audits = []; changed = true; }
  if (!Array.isArray(db.nonconformities)) { db.nonconformities = []; changed = true; }
  if (!db.idempotency || typeof db.idempotency !== "object" || Array.isArray(db.idempotency)) { db.idempotency = {}; changed = true; }
  // 旧版幂等记录没有请求指纹，标记为 legacy：保留不丢失，但因无法校验请求一致性，一律不得回放
  for (const rec of Object.values(db.idempotency)) {
    if (rec && typeof rec === "object" && !rec.fingerprint && !rec.legacy) { rec.legacy = true; changed = true; }
  }
  if (db.schemaVersion !== 3) { db.schemaVersion = 3; changed = true; }
  return changed;
}

async function saveDb(dbPath, db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}
async function loadDb(dbPath) {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveDb(dbPath, seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (migrate(db)) await saveDb(dbPath, db);
  return db;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法JSON");
  }
}
function send(res, status, data, headers) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(headers || {}) });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function fail(res, error) {
  if (error instanceof HttpError) {
    return send(res, error.status, { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
  }
  send(res, 500, { error: error.message });
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

// ---------- 质量审核领域逻辑（在串行队列内执行，先校验后落库，失败不留半项） ----------
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function findAudit(db, id) {
  const audit = db.audits.find(x => x.id === id);
  if (!audit) throw notFound("审核计划");
  return audit;
}
function findNc(db, id) {
  const nc = db.nonconformities.find(x => x.id === id);
  if (!nc) throw notFound("不符合项");
  return nc;
}
function pushHistory(nc, action, by, note, extra) {
  nc.history.push({ at: now(), action, by: s(by), note: s(note), ...(extra || {}) });
}

function createAudit(db, input) {
  requireFields(input, { standardVersion: "标准版本", scope: "审核范围", auditor: "审核员", startDate: "开始日期" });
  requireDate(input, "startDate", "开始日期");
  if (s(input.endDate)) requireDate(input, "endDate", "结束日期");
  if (s(input.endDate) && s(input.endDate) < s(input.startDate)) throw bad("结束日期不能早于开始日期");
  const samples = (Array.isArray(input.samples) ? input.samples : []).map(key => {
    const item = findItem(db, key);
    if (!item) throw bad("样本批次不存在: " + key);
    return { batch: item.code || item.id, itemId: item.id || null, source: item.source || "", vat: item.vat || "" };
  });
  const audit = {
    id: uid("AUD"),
    standardVersion: s(input.standardVersion),
    scope: s(input.scope),
    auditor: s(input.auditor),
    startDate: s(input.startDate),
    endDate: s(input.endDate),
    samples,
    status: "计划中",
    createdAt: now()
  };
  db.audits.unshift(audit);
  return audit;
}

function transitionAudit(db, id, input) {
  const audit = findAudit(db, id);
  const next = s(input.status);
  const from = AUDIT_STATUSES.indexOf(audit.status);
  const to = AUDIT_STATUSES.indexOf(next);
  if (to === -1) throw bad("未知审核状态: " + next);
  if (to !== from + 1) throw conflict("invalid_status", "审核状态只能从「" + audit.status + "」顺序推进，不能跳到「" + next + "」");
  audit.status = next;
  return audit;
}

function registerNc(db, auditId, input) {
  const audit = findAudit(db, auditId);
  if (audit.status !== "审核中") throw conflict("invalid_status", "只有审核中的计划才能登记不符合项（当前为「" + audit.status + "」）");
  requireFields(input, { clause: "条款", severity: "严重度", evidence: "证据", responsible: "责任人", deadline: "整改期限", batch: "样本批次" });
  if (!SEVERITIES.includes(input.severity)) throw bad("严重度必须是: " + SEVERITIES.join("/"));
  requireDate(input, "deadline", "整改期限");
  const item = findItem(db, input.batch);
  if (!item) throw bad("样本批次不存在: " + input.batch);
  const batchKey = item.code || item.id;
  if (audit.samples.length && !audit.samples.some(sm => sm.batch === batchKey)) {
    throw bad("批次 " + batchKey + " 不在审核计划的样本范围内");
  }
  const nc = {
    id: uid("NC"),
    auditId,
    batch: batchKey,
    clause: s(input.clause),
    severity: input.severity,
    evidence: s(input.evidence),
    description: s(input.description),
    responsible: s(input.responsible),
    deadline: s(input.deadline),
    status: "待整改",
    rectification: null,
    review: null,
    closedAt: null,
    closedBy: null,
    reopenCount: 0,
    version: 1,
    corrections: [],
    history: [],
    createdAt: now()
  };
  pushHistory(nc, "登记", input.createdBy || audit.auditor, "登记不符合项");
  db.nonconformities.unshift(nc);
  return nc;
}

function submitRectification(db, id, input) {
  const nc = findNc(db, id);
  if (nc.status !== "待整改") throw conflict("invalid_status", "当前状态为「" + nc.status + "」，不能提交整改");
  requireFields(input, { cause: "原因分析", evidence: "整改证据", submittedBy: "提交人" });
  if (s(input.submittedBy) !== nc.responsible) throw bad("整改必须由责任人「" + nc.responsible + "」本人提交");
  nc.rectification = { cause: s(input.cause), evidence: s(input.evidence), submittedBy: s(input.submittedBy), submittedAt: now() };
  nc.status = "待复核";
  nc.version += 1;
  pushHistory(nc, "提交整改", nc.rectification.submittedBy, "提交原因分析与整改证据");
  return nc;
}

function reviewNc(db, id, input) {
  const nc = findNc(db, id);
  if (nc.status !== "待复核") throw conflict("invalid_status", "当前状态为「" + nc.status + "」，不能复核");
  requireFields(input, { reviewer: "复核人" });
  const audit = findAudit(db, nc.auditId);
  const reviewer = s(input.reviewer);
  if (reviewer === nc.responsible) throw new HttpError(400, "reviewer_conflict", "复核人不得与责任人相同");
  if (reviewer === audit.auditor) throw new HttpError(400, "reviewer_conflict", "复核人不得与原审核员相同");
  const approved = input.approved === true || input.approved === "true";
  nc.review = {
    reviewer,
    approved,
    independentConfirmation: approved && (input.independentConfirmation === true || input.independentConfirmation === "true"),
    note: s(input.note),
    at: now()
  };
  nc.status = approved ? "已复核" : "待整改";
  nc.version += 1;
  pushHistory(nc, approved ? "复核通过" : "复核驳回", reviewer, nc.review.note);
  return nc;
}

function closeNc(db, id, input) {
  const nc = findNc(db, id);
  if (nc.status !== "已复核") throw conflict("invalid_status", "当前状态为「" + nc.status + "」，不能关闭");
  if (nc.severity === HIGH_SEVERITY) {
    const problems = [];
    if (!nc.rectification || !nc.rectification.cause) problems.push("缺少原因分析");
    if (!nc.rectification || !nc.rectification.evidence) problems.push("缺少整改证据");
    if (!nc.review || !nc.review.independentConfirmation) problems.push("缺少独立确认");
    const overdue = db.nonconformities.filter(o => o.id !== nc.id && o.auditId === nc.auditId && o.status !== "已关闭" && o.deadline < today());
    if (overdue.length) problems.push("存在逾期关联项: " + overdue.map(o => o.id).join("、"));
    if (problems.length) throw new HttpError(409, "close_blocked", "高等级不符合项关闭被阻止", { problems });
  }
  nc.status = "已关闭";
  nc.closedAt = now();
  nc.closedBy = s(input.closedBy) || (nc.review && nc.review.reviewer) || "";
  nc.version += 1;
  pushHistory(nc, "关闭", nc.closedBy, "关闭不符合项");
  return nc;
}

function reopenNc(db, id, input) {
  const nc = findNc(db, id);
  if (nc.status !== "已关闭") throw conflict("invalid_status", "只有已关闭的不符合项可以重开");
  requireFields(input, { reason: "重开原因", reopenedBy: "操作人" });
  pushHistory(nc, "重开", input.reopenedBy, input.reason, {
    archived: { rectification: nc.rectification, review: nc.review, closedAt: nc.closedAt, closedBy: nc.closedBy }
  });
  nc.rectification = null;
  nc.review = null;
  nc.closedAt = null;
  nc.closedBy = null;
  nc.status = "待整改";
  nc.reopenCount += 1;
  nc.version += 1;
  return nc;
}

function addCorrection(db, id, input) {
  const nc = findNc(db, id);
  if (nc.status !== "已关闭") throw conflict("invalid_status", "记录未关闭，请走正常流程修改；只有已关闭的记录需要追加更正");
  requireFields(input, { note: "更正内容", by: "更正人" });
  const correction = { version: nc.corrections.length + 1, note: s(input.note), by: s(input.by), at: now() };
  nc.corrections.push(correction);
  nc.version += 1;
  pushHistory(nc, "追加更正", correction.by, "更正 v" + correction.version);
  return nc;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .tabs { display:flex; gap:8px; } .tabs button { background:#e4e9e2; color:var(--ink); } .tabs button.active { background:var(--accent); color:#fff; }
    .inline { border:1px dashed var(--line); border-radius:6px; padding:10px; display:grid; gap:2px; } .inline button { margin-top:8px; }
    .row { display:flex; gap:8px; } .row button { flex:1; }
    details.logs summary { cursor:pointer; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古法纸浆发酵记录</h1><div class="meta">纸浆批次、浸泡缸、换水和异常观察 · 内部质量审核与整改复核</div></div>
    <nav class="tabs"><button data-tab="ledger" class="active">发酵台账</button><button data-tab="quality">质量审核</button></nav>
    <button id="reload">刷新</button>
  </header>
  <section id="tab-ledger">
    <main>
      <section>
        <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
        <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      </section>
      <section>
        <div class="stats" id="stats"></div>
        <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
        <div class="panel"><h2>每天记录温度、气味、纤维状态和换水情况，系统统计发酵进度与异常次数。</h2><div class="grid" id="cards"></div></div>
      </section>
    </main>
  </section>
  <section id="tab-quality" hidden>
    <main>
      <section>
        <form id="auditForm"><h2>新增审核计划</h2>
          <label>标准版本</label><input name="standardVersion" required placeholder="如 QMS-2026-A">
          <label>审核范围</label><input name="scope" required placeholder="如 浸泡车间 / 三号缸区">
          <label>审核员</label><input name="auditor" required>
          <label>开始日期</label><input name="startDate" type="date" required>
          <label>结束日期</label><input name="endDate" type="date">
          <label>样本批次（可多选，追溯到台账批次）</label><select name="samples" id="sampleSelect" multiple size="4"></select>
          <button>保存审核计划</button>
        </form>
        <form id="ncForm" style="margin-top:14px"><h2>登记不符合项</h2>
          <label>所属审核计划</label><select name="auditId" id="ncAudit"></select>
          <label>样本批次</label><select name="batch" id="ncBatch"></select>
          <label>条款</label><input name="clause" required placeholder="如 7.5.1 温度记录">
          <label>严重度</label><select name="severity">${SEVERITIES.map(v => '<option>'+v+'</option>').join('')}</select>
          <label>证据</label><textarea name="evidence" required placeholder="现场观察到的事实证据"></textarea>
          <label>责任人</label><input name="responsible" required>
          <label>整改期限</label><input name="deadline" type="date" required>
          <label>问题描述</label><textarea name="description"></textarea>
          <button>登记不符合项</button>
        </form>
      </section>
      <section>
        <div class="stats" id="qStats"></div>
        <div class="panel" style="margin-bottom:14px"><h2>审核计划</h2><div class="grid" id="auditList"></div></div>
        <div class="panel"><h2>不符合项</h2>
          <div class="toolbar"><select id="ncStatusFilter"><option value="">全部状态</option>${NC_STATUSES.map(v => '<option>'+v+'</option>').join('')}</select><select id="ncSeverityFilter"><option value="">全部严重度</option>${SEVERITIES.map(v => '<option>'+v+'</option>').join('')}</select></div>
          <div class="grid" id="ncList"></div>
        </div>
      </section>
    </main>
  </section>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render;

    // ===== 内部质量审核与整改复核 =====
    const NC_STATUSES = ${JSON.stringify(NC_STATUSES)};
    const auditForm = document.querySelector('#auditForm');
    const ncForm = document.querySelector('#ncForm');
    const auditListEl = document.querySelector('#auditList');
    const ncListEl = document.querySelector('#ncList');
    const qStatsEl = document.querySelector('#qStats');
    let audits = [], ncs = [];
    const todayStr = new Date().toISOString().slice(0, 10);
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    function idemKey() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'k' + Date.now() + Math.random(); }
    async function qapi(path, options) {
      const opts = options && options.body ? Object.assign({}, options, { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey() } }) : options;
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) { alert(data.message || data.error || '请求失败'); throw new Error(data.error || 'request_failed'); }
      return data;
    }
    function auditCard(a) {
      const samples = (a.samples || []).map(sm => '<span class="pill">'+esc(sm.batch)+'</span>').join(' ') || '<span class="meta">未抽样</span>';
      let btn = '';
      if (a.status === '计划中') btn = '<button data-audit-start="'+a.id+'">开始审核</button>';
      else if (a.status === '审核中') btn = '<button class="secondary" data-audit-done="'+a.id+'">完成审核</button>';
      return '<article class="card"><h3>'+esc(a.scope)+'</h3><span class="pill">'+a.status+'</span>'
        + '<div class="meta">标准版本 '+esc(a.standardVersion)+' · 审核员 '+esc(a.auditor)+'</div>'
        + '<div class="meta">'+esc(a.startDate)+' ~ '+esc(a.endDate || '未定')+'</div>'
        + '<div>样本 '+samples+'</div>'
        + '<div class="meta">不符合项 '+a.ncCount+'（未关闭 '+a.openNcCount+'）</div>'+btn+'</article>';
    }
    function ncActions(nc) {
      if (nc.status === '待整改') return '<form class="inline" data-submit="'+nc.id+'"><label>原因分析</label><input name="cause" required><label>整改证据</label><input name="evidence" required><button>提交整改（'+esc(nc.responsible)+'）</button></form>';
      if (nc.status === '待复核') return '<form class="inline" data-review="'+nc.id+'"><label>复核人（不得为责任人或原审核员）</label><input name="reviewer" required><label><input type="checkbox" name="independentConfirmation" style="width:auto"> 已独立确认</label><label>复核意见</label><input name="note"><div class="row"><button type="submit">复核通过</button><button type="button" class="secondary" data-reject="1">驳回</button></div></form>';
      if (nc.status === '已复核') return '<button data-close="'+nc.id+'">关闭</button>';
      if (nc.status === '已关闭') return '<div class="row"><button class="secondary" data-reopen="'+nc.id+'">重开</button><button class="secondary" data-correct="'+nc.id+'">追加更正</button></div>';
      return '';
    }
    function ncCard(nc) {
      const overdue = nc.status !== '已关闭' && nc.deadline && nc.deadline < todayStr;
      const rect = nc.rectification ? '<div class="meta">整改：'+esc(nc.rectification.cause)+'；证据 '+esc(nc.rectification.evidence)+'（'+esc(nc.rectification.submittedBy)+'）</div>' : '';
      const rev = nc.review ? '<div class="meta">复核：'+esc(nc.review.reviewer)+' · '+(nc.review.approved ? '通过' : '驳回')+(nc.review.independentConfirmation ? ' · 独立确认' : '')+(nc.review.note ? ' · '+esc(nc.review.note) : '')+'</div>' : '';
      const corr = (nc.corrections || []).map(c => '<div class="meta">更正v'+c.version+'：'+esc(c.note)+'（'+esc(c.by)+'）</div>').join('');
      const hist = (nc.history || []).map(h => '<div>'+h.action+' · '+esc(h.by || '')+' · '+esc(h.note || '')+'</div>').join('');
      return '<article class="card"><h3>'+nc.id+' <span class="pill">'+nc.severity+'</span> <span class="pill">'+nc.status+'</span></h3>'
        + '<div><b>条款</b> '+esc(nc.clause)+' · <b>批次</b> '+esc(nc.batch)+'</div>'
        + '<div><b>责任人</b> '+esc(nc.responsible)+' · <b>期限</b> '+esc(nc.deadline)+(overdue ? ' <span class="warn">已逾期</span>' : '')+'</div>'
        + '<div class="meta">证据：'+esc(nc.evidence)+'</div>'
        + (nc.description ? '<div class="meta">'+esc(nc.description)+'</div>' : '')
        + rect + rev + corr
        + (nc.reopenCount ? '<div class="meta">重开次数 '+nc.reopenCount+'</div>' : '')
        + ncActions(nc)
        + '<details class="logs meta"><summary>流转记录</summary>'+hist+'</details></article>';
    }
    function renderBatchOptions() {
      const a = audits.find(x => x.id === document.querySelector('#ncAudit').value);
      const batches = a && a.samples && a.samples.length ? a.samples.map(sm => sm.batch) : items.map(it => it.code || it.id);
      document.querySelector('#ncBatch').innerHTML = batches.map(b => '<option>'+esc(b)+'</option>').join('');
    }
    function renderQuality() {
      qStatsEl.innerHTML = NC_STATUSES.map(st => '<div class="stat"><span>'+st+'</span><strong>'+ncs.filter(n => n.status === st).length+'</strong></div>').join('');
      const auditSel = document.querySelector('#ncAudit');
      const keep = auditSel.value;
      const registerable = audits.filter(a => a.status === '审核中');
      auditSel.innerHTML = registerable.map(a => '<option value="'+a.id+'">'+esc(a.scope)+' · '+esc(a.standardVersion)+'（'+a.status+'）</option>').join('')
        || '<option value="">（暂无审核中的计划，请先开始审核）</option>';
      if (keep) auditSel.value = keep;
      renderBatchOptions();
      document.querySelector('#sampleSelect').innerHTML = items.map(it => '<option value="'+(it.code || it.id)+'">'+(it.code || it.id)+' · '+(it.source || '')+'</option>').join('');
      auditListEl.innerHTML = audits.map(auditCard).join('') || '<div class="meta">暂无审核计划</div>';
      const fs = document.querySelector('#ncStatusFilter').value, fv = document.querySelector('#ncSeverityFilter').value;
      const visible = ncs.filter(n => (!fs || n.status === fs) && (!fv || n.severity === fv));
      ncListEl.innerHTML = visible.map(ncCard).join('') || '<div class="meta">暂无不符合项</div>';
    }
    async function qload() { items = await api('/api/items'); audits = await api('/api/audits'); ncs = await api('/api/nonconformities'); renderQuality(); }
    auditForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(auditForm);
      await qapi('/api/audits', { method:'POST', body: JSON.stringify({ standardVersion: fd.get('standardVersion'), scope: fd.get('scope'), auditor: fd.get('auditor'), startDate: fd.get('startDate'), endDate: fd.get('endDate'), samples: fd.getAll('samples') }) });
      auditForm.reset(); await qload();
    };
    ncForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(ncForm);
      if (!fd.get('auditId')) { alert('没有审核中的计划，请先在上方创建并「开始审核」'); return; }
      await qapi('/api/audits/'+fd.get('auditId')+'/nonconformities', { method:'POST', body: JSON.stringify({ batch: fd.get('batch'), clause: fd.get('clause'), severity: fd.get('severity'), evidence: fd.get('evidence'), responsible: fd.get('responsible'), deadline: fd.get('deadline'), description: fd.get('description') }) });
      ncForm.reset(); await qload();
    };
    document.querySelector('#ncAudit').addEventListener('change', renderBatchOptions);
    auditListEl.addEventListener('click', async event => {
      const t = event.target;
      if (t.dataset.auditStart) { await qapi('/api/audits/'+t.dataset.auditStart, { method:'PATCH', body: JSON.stringify({ status:'审核中' }) }); await qload(); }
      if (t.dataset.auditDone) { await qapi('/api/audits/'+t.dataset.auditDone, { method:'PATCH', body: JSON.stringify({ status:'已完成' }) }); await qload(); }
    });
    ncListEl.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, fd = new FormData(form);
      if (form.dataset.submit) {
        const nc = ncs.find(n => n.id === form.dataset.submit);
        await qapi('/api/nonconformities/'+form.dataset.submit+'/submit', { method:'POST', body: JSON.stringify({ cause: fd.get('cause'), evidence: fd.get('evidence'), submittedBy: nc ? nc.responsible : '' }) });
      } else if (form.dataset.review) {
        await qapi('/api/nonconformities/'+form.dataset.review+'/review', { method:'POST', body: JSON.stringify({ reviewer: fd.get('reviewer'), approved: true, independentConfirmation: !!fd.get('independentConfirmation'), note: fd.get('note') }) });
      }
      await qload();
    });
    ncListEl.addEventListener('click', async event => {
      const t = event.target.closest('[data-reject],[data-close],[data-reopen],[data-correct]');
      if (!t) return;
      if (t.dataset.reject) {
        const form = t.closest('form'), fd = new FormData(form);
        await qapi('/api/nonconformities/'+form.dataset.review+'/review', { method:'POST', body: JSON.stringify({ reviewer: fd.get('reviewer'), approved: false, note: fd.get('note') }) });
      } else if (t.dataset.close) {
        await qapi('/api/nonconformities/'+t.dataset.close+'/close', { method:'POST', body:'{}' });
      } else if (t.dataset.reopen) {
        const reason = prompt('重开原因（复发情况）'); if (!reason) return;
        const by = prompt('操作人') || '';
        await qapi('/api/nonconformities/'+t.dataset.reopen+'/reopen', { method:'POST', body: JSON.stringify({ reason: reason, reopenedBy: by }) });
      } else if (t.dataset.correct) {
        const note = prompt('更正内容'); if (!note) return;
        const by = prompt('更正人') || '';
        await qapi('/api/nonconformities/'+t.dataset.correct+'/corrections', { method:'POST', body: JSON.stringify({ note: note, by: by }) });
      }
      await qload();
    });
    document.querySelector('#ncStatusFilter').onchange = renderQuality;
    document.querySelector('#ncSeverityFilter').onchange = renderQuality;

    // 页签切换
    document.querySelectorAll('[data-tab]').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelector('#tab-ledger').hidden = btn.dataset.tab !== 'ledger';
      document.querySelector('#tab-quality').hidden = btn.dataset.tab !== 'quality';
      if (btn.dataset.tab === 'quality') qload();
    });
    document.querySelector('#reload').onclick = () => { load(); if (!document.querySelector('#tab-quality').hidden) qload(); };
    renderForms(); load();
  </script>
</body>
</html>`;
}

export function createApp(options = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || defaultDbPath;
  // 串行化所有写操作：校验-变更-落库在同一微任务链内完成，并发与重复请求只有一次能生效
  let chain = Promise.resolve();
  function mutate(fn) {
    const p = chain.then(async () => {
      const db = await loadDb(dbPath);
      const out = await fn(db);
      await saveDb(dbPath, db);
      return out;
    });
    chain = p.catch(() => {});
    return p;
  }
  async function handleMutation(req, res, path, fn) {
    try {
      const input = await body(req);
      const idemKey = req.headers["idempotency-key"];
      const fingerprint = idemKey ? requestFingerprint(req.method, path, input) : null;
      const out = await mutate(async (db) => {
        if (idemKey) {
          const rec = db.idempotency[idemKey];
          if (rec && typeof rec === "object") {
            // 同一操作同一请求：回放原响应；不同接口/不同内容或无法校验的遗留记录：拒绝，绝不误回放
            if (rec.fingerprint && rec.fingerprint === fingerprint) {
              return { status: rec.status, body: rec.body, replay: true };
            }
            throw new HttpError(409, "idempotency_conflict", "幂等键已被其他请求占用，请更换新键");
          }
        }
        const result = await fn(db, input);
        if (idemKey) db.idempotency[idemKey] = { fingerprint, status: result.status, body: result.body, at: now() };
        return result;
      });
      send(res, out.status, out.body, out.replay ? { "Idempotent-Replay": "true" } : undefined);
    } catch (error) {
      fail(res, error);
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET") {
        const db = await loadDb(dbPath);
        if (url.pathname === "/") return html(res, page());
        if (url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
        if (url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
        if (url.pathname === "/api/audits") {
          const list = db.audits.map(a => ({
            ...a,
            ncCount: db.nonconformities.filter(n => n.auditId === a.id).length,
            openNcCount: db.nonconformities.filter(n => n.auditId === a.id && n.status !== "已关闭").length
          }));
          return send(res, 200, list);
        }
        const auditGet = url.pathname.match(/^\/api\/audits\/([^/]+)$/);
        if (auditGet) {
          const audit = db.audits.find(x => x.id === auditGet[1]);
          if (!audit) return send(res, 404, { error: "not_found", message: "审核计划不存在" });
          return send(res, 200, { ...audit, nonconformities: db.nonconformities.filter(n => n.auditId === audit.id) });
        }
        if (url.pathname === "/api/nonconformities") {
          const q = (k) => url.searchParams.get(k);
          let list = db.nonconformities;
          if (q("auditId")) list = list.filter(n => n.auditId === q("auditId"));
          if (q("status")) list = list.filter(n => n.status === q("status"));
          if (q("severity")) list = list.filter(n => n.severity === q("severity"));
          if (q("batch")) list = list.filter(n => n.batch === q("batch"));
          return send(res, 200, list);
        }
        const ncGet = url.pathname.match(/^\/api\/nonconformities\/([^/]+)$/);
        if (ncGet) {
          const nc = db.nonconformities.find(x => x.id === ncGet[1]);
          if (!nc) return send(res, 404, { error: "not_found", message: "不符合项不存在" });
          return send(res, 200, nc);
        }
        return send(res, 404, { error: "not_found" });
      }

      if (req.method === "POST" && url.pathname === "/api/items") {
        return handleMutation(req, res, url.pathname, async (db, input) => {
          const item = { id: uid("PF"), ...input, reviewStatus: "待复核", logs: [{ at: now(), step: "建档", note: "创建纸浆批次" }] };
          db.items.unshift(item);
          return { status: 201, body: item };
        });
      }
      const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
      if (patch && req.method === "PATCH") {
        return handleMutation(req, res, url.pathname, async (db, input) => {
          const item = findItem(db, patch[1]);
          if (!item) throw notFound("批次");
          Object.assign(item, input);
          item.logs ||= [];
          item.logs.push({ at: now(), step: "状态", note: "更新为" + item.status });
          return { status: 200, body: item };
        });
      }
      const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
      if (log && req.method === "POST") {
        return handleMutation(req, res, url.pathname, async (db, input) => {
          const item = findItem(db, log[1]);
          if (!item) throw notFound("批次");
          item.logs ||= [];
          item.logs.push({ at: now(), step: input.step || "记录", note: input.note || "" });
          return { status: 201, body: item };
        });
      }
      const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
      if (action && req.method === "POST") {
        return handleMutation(req, res, url.pathname, async (db, input) => {
          const item = findItem(db, action[1]);
          if (!item) throw notFound("批次");
          item.logs ||= [];
          const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
          item.observations ||= [];
          item.observations.push({ at: now(), ...input, abnormal });
          item.days = Number(item.days || 0) + 1;
          item.status = abnormal ? "异常观察" : Number(item.days) >= 7 ? "可抄纸" : "发酵中";
          item.logs.push({ at: now(), step: "观察", note: "温度" + (input.temperature || "") + "，" + (input.smell || "") + "，" + (input.fiber || "") });
          return { status: 201, body: item };
        });
      }
      if (req.method === "POST" && url.pathname === "/api/audits") {
        return handleMutation(req, res, url.pathname, async (db, input) => ({ status: 201, body: createAudit(db, input) }));
      }
      const auditPatch = url.pathname.match(/^\/api\/audits\/([^/]+)$/);
      if (auditPatch && req.method === "PATCH") {
        return handleMutation(req, res, url.pathname, async (db, input) => ({ status: 200, body: transitionAudit(db, auditPatch[1], input) }));
      }
      const ncRegister = url.pathname.match(/^\/api\/audits\/([^/]+)\/nonconformities$/);
      if (ncRegister && req.method === "POST") {
        return handleMutation(req, res, url.pathname, async (db, input) => ({ status: 201, body: registerNc(db, ncRegister[1], input) }));
      }
      const ncAction = url.pathname.match(/^\/api\/nonconformities\/([^/]+)\/(submit|review|close|reopen|corrections)$/);
      if (ncAction && req.method === "POST") {
        return handleMutation(req, res, url.pathname, async (db, input) => {
          const [, id, act] = ncAction;
          if (act === "submit") return { status: 200, body: submitRectification(db, id, input) };
          if (act === "review") return { status: 200, body: reviewNc(db, id, input) };
          if (act === "close") return { status: 200, body: closeNc(db, id, input) };
          if (act === "reopen") return { status: 200, body: reopenNc(db, id, input) };
          return { status: 201, body: addCorrection(db, id, input) };
        });
      }
      send(res, 404, { error: "not_found" });
    } catch (error) {
      fail(res, error);
    }
  });
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isMain) {
  const port = Number(process.env.PORT || 3039);
  createApp().listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));
}
