import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";

const cleanups = [];
after(async () => { await Promise.all(cleanups.map(fn => fn())); });

const ledgerSeed = () => ({
  items: [
    { id: "it-1", code: "PF-001", source: "构树皮", vat: "三号缸", days: 5, owner: "林素", status: "发酵中", logs: [{ at: "2026-06-15", step: "观察", note: "温度24.6" }] },
    { id: "it-2", code: "PF-002", source: "桑皮", vat: "一号缸", days: 3, owner: "陈岩", status: "入缸", logs: [] }
  ]
});

async function setup(seedData = ledgerSeed()) {
  const dir = await mkdtemp(join(tmpdir(), "audit-test-"));
  const dbPath = join(dir, "db.json");
  if (seedData) await writeFile(dbPath, JSON.stringify(seedData, null, 2));
  const server = createApp({ dbPath });
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  cleanups.push(async () => { await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { base, dbPath };
}

async function api(base, path, { method = "GET", body, key } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

const auditBody = (over = {}) => ({
  standardVersion: "QMS-2026-A", scope: "浸泡车间", auditor: "王敏",
  startDate: "2026-09-01", endDate: "2026-09-30", samples: ["PF-001", "PF-002"], ...over
});
const ncBody = (over = {}) => ({
  clause: "7.5.1", severity: "高", evidence: "现场无温度记录", responsible: "林素",
  deadline: "2027-01-01", batch: "PF-001", ...over
});

async function makeAudit(base, over = {}) {
  const res = await api(base, "/api/audits", { method: "POST", body: auditBody(over) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}
async function makeNc(base, auditId, over = {}) {
  const res = await api(base, `/api/audits/${auditId}/nonconformities`, { method: "POST", body: ncBody(over) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}
async function toReviewed(base, nc, { independent = true } = {}) {
  const sub = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "记录缺失", evidence: "已补记录并培训", submittedBy: nc.responsible } });
  assert.equal(sub.status, 200, JSON.stringify(sub.json));
  const rev = await api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: true, independentConfirmation: independent } });
  assert.equal(rev.status, 200, JSON.stringify(rev.json));
  return rev.json;
}

test("升级迁移：保留已有台账，历史项标待复核，不自动关闭", async () => {
  const { base, dbPath } = await setup();
  const items = (await api(base, "/api/items")).json;
  assert.equal(items.length, 2);
  assert.equal(items[0].code, "PF-001");
  assert.equal(items[0].reviewStatus, "待复核");
  assert.equal(items[1].reviewStatus, "待复核");
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  assert.deepEqual(db.audits, []);
  assert.deepEqual(db.nonconformities, []);
  assert.equal(db.items[0].logs.length, 1, "原有日志保留");
  assert.ok(!db.items.some(i => i.reviewStatus === "已关闭"), "不得自动关闭");
  assert.ok(!db.nonconformities.some(n => n.status === "已关闭"), "不得自动关闭");
});

test("审核计划：绑定标准版本、范围、审核员、日期，样本可追溯到批次", async () => {
  const { base } = await setup();
  const missing = await api(base, "/api/audits", { method: "POST", body: { scope: "x" } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, "validation_failed");
  const badDate = await api(base, "/api/audits", { method: "POST", body: auditBody({ startDate: "2026-09-10", endDate: "2026-09-01" }) });
  assert.equal(badDate.status, 400);
  const badSample = await api(base, "/api/audits", { method: "POST", body: auditBody({ samples: ["PF-999"] }) });
  assert.equal(badSample.status, 400);
  const audit = await makeAudit(base);
  assert.equal(audit.status, "计划中");
  assert.equal(audit.standardVersion, "QMS-2026-A");
  assert.deepEqual(audit.samples.map(sm => sm.batch), ["PF-001", "PF-002"]);
  assert.equal(audit.samples[0].source, "构树皮", "样本快照可追溯批次信息");
});

test("审核计划状态只能顺序推进", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const skip = await api(base, `/api/audits/${audit.id}`, { method: "PATCH", body: { status: "已完成" } });
  assert.equal(skip.status, 409);
  const active = await api(base, `/api/audits/${audit.id}`, { method: "PATCH", body: { status: "审核中" } });
  assert.equal(active.status, 200);
  const back = await api(base, `/api/audits/${audit.id}`, { method: "PATCH", body: { status: "计划中" } });
  assert.equal(back.status, 409);
  const done = await api(base, `/api/audits/${audit.id}`, { method: "PATCH", body: { status: "已完成" } });
  assert.equal(done.status, 200);
  const late = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody() });
  assert.equal(late.status, 409, "已完成的审核不能登记不符合项");
});

test("不符合项登记：条款、严重度、证据、责任人、期限必填，批次须在样本范围内", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base, { samples: ["PF-001"] });
  const missing = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: { severity: "高" } });
  assert.equal(missing.status, 400);
  const badSeverity = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody({ severity: "严重" }) });
  assert.equal(badSeverity.status, 400);
  const badDeadline = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody({ deadline: "十月一日" }) });
  assert.equal(badDeadline.status, 400);
  const outOfScope = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody({ batch: "PF-002" }) });
  assert.equal(outOfScope.status, 400);
  const ghost = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody({ batch: "PF-999" }) });
  assert.equal(ghost.status, 400);
  const nc = await makeNc(base, audit.id);
  assert.equal(nc.status, "待整改");
  assert.equal(nc.batch, "PF-001");
  assert.equal(nc.history[0].action, "登记");
});

test("整改提交：需原因与证据，须责任人本人，重复提交只有一次生效", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  const noCause = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { evidence: "x", submittedBy: "林素" } });
  assert.equal(noCause.status, 400);
  const wrongPerson = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "陈岩" } });
  assert.equal(wrongPerson.status, 400);
  let cur = (await api(base, `/api/nonconformities/${nc.id}`)).json;
  assert.equal(cur.status, "待整改");
  assert.equal(cur.rectification, null, "失败不留半项");
  const ok = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "培训不足", evidence: "已补培训记录", submittedBy: "林素" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, "待复核");
  const dup = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" } });
  assert.equal(dup.status, 409);
});

test("复核人不得与责任人或原审核员相同；驳回回到待整改", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" } });
  const asResponsible = await api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "林素", approved: true } });
  assert.equal(asResponsible.status, 400);
  assert.equal(asResponsible.json.error, "reviewer_conflict");
  const asAuditor = await api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "王敏", approved: true } });
  assert.equal(asAuditor.status, 400);
  assert.equal(asAuditor.json.error, "reviewer_conflict");
  const reject = await api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: false, note: "证据不足" } });
  assert.equal(reject.status, 200);
  assert.equal(reject.json.status, "待整改");
  await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c2", evidence: "e2", submittedBy: "林素" } });
  const approve = await api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: true, independentConfirmation: true } });
  assert.equal(approve.json.status, "已复核");
});

test("高等级缺独立确认不得关闭，失败后状态不变", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  await toReviewed(base, nc, { independent: false });
  const blocked = await api(base, `/api/nonconformities/${nc.id}/close`, { method: "POST", body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, "close_blocked");
  assert.ok(blocked.json.details.problems.some(p => p.includes("独立确认")));
  const cur = (await api(base, `/api/nonconformities/${nc.id}`)).json;
  assert.equal(cur.status, "已复核");
  assert.equal(cur.closedAt, null, "失败不留半项");
});

test("高等级存在逾期关联项不得关闭，关联项处理后可关闭", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc1 = await makeNc(base, audit.id, { batch: "PF-001", deadline: "2027-01-01" });
  const nc2 = await makeNc(base, audit.id, { batch: "PF-002", severity: "低", responsible: "陈岩", deadline: "2020-01-01" });
  await toReviewed(base, nc1);
  const blocked = await api(base, `/api/nonconformities/${nc1.id}/close`, { method: "POST", body: {} });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.json.details.problems.some(p => p.includes("逾期关联项") && p.includes(nc2.id)));
  // 处理掉逾期关联项（低等级：提交→复核→关闭）
  await api(base, `/api/nonconformities/${nc2.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "陈岩" } });
  await api(base, `/api/nonconformities/${nc2.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: true } });
  const close2 = await api(base, `/api/nonconformities/${nc2.id}/close`, { method: "POST", body: {} });
  assert.equal(close2.status, 200);
  const close1 = await api(base, `/api/nonconformities/${nc1.id}/close`, { method: "POST", body: {} });
  assert.equal(close1.status, 200);
  assert.equal(close1.json.status, "已关闭");
  assert.ok(close1.json.closedAt);
});

test("关闭后记录只读，更正追加版本", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  await toReviewed(base, nc);
  await api(base, `/api/nonconformities/${nc.id}/close`, { method: "POST", body: {} });
  const submit = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" } });
  assert.equal(submit.status, 409, "已关闭不可再提交整改");
  const review = await api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: true } });
  assert.equal(review.status, 409, "已关闭不可再复核");
  const reclose = await api(base, `/api/nonconformities/${nc.id}/close`, { method: "POST", body: {} });
  assert.equal(reclose.status, 409, "已关闭不可重复关闭");
  const c1 = await api(base, `/api/nonconformities/${nc.id}/corrections`, { method: "POST", body: { note: "条款编号笔误，应为7.5.1", by: "王敏" } });
  assert.equal(c1.status, 201);
  assert.equal(c1.json.corrections.length, 1);
  assert.equal(c1.json.corrections[0].version, 1);
  const c2 = await api(base, `/api/nonconformities/${nc.id}/corrections`, { method: "POST", body: { note: "补充说明", by: "王敏" } });
  assert.equal(c2.json.corrections[1].version, 2);
  assert.equal(c2.json.clause, "7.5.1", "更正不改原记录，只追加版本");
});

test("未关闭记录不能追加更正", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  const res = await api(base, `/api/nonconformities/${nc.id}/corrections`, { method: "POST", body: { note: "x", by: "王敏" } });
  assert.equal(res.status, 409);
});

test("复发可重开：需原因，归档上一轮整改复核，可再次走完全流程", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  const early = await api(base, `/api/nonconformities/${nc.id}/reopen`, { method: "POST", body: { reason: "r", reopenedBy: "王敏" } });
  assert.equal(early.status, 409, "未关闭不能重开");
  await toReviewed(base, nc);
  await api(base, `/api/nonconformities/${nc.id}/close`, { method: "POST", body: {} });
  const noReason = await api(base, `/api/nonconformities/${nc.id}/reopen`, { method: "POST", body: { reopenedBy: "王敏" } });
  assert.equal(noReason.status, 400);
  const reopened = await api(base, `/api/nonconformities/${nc.id}/reopen`, { method: "POST", body: { reason: "复查发现同类问题复发", reopenedBy: "王敏" } });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.status, "待整改");
  assert.equal(reopened.json.reopenCount, 1);
  assert.equal(reopened.json.rectification, null);
  assert.equal(reopened.json.review, null);
  assert.equal(reopened.json.closedAt, null);
  const reopenEntry = reopened.json.history.find(h => h.action === "重开");
  assert.ok(reopenEntry.archived.rectification, "上一轮整改已归档到流转记录");
  assert.ok(reopenEntry.archived.review, "上一轮复核已归档到流转记录");
  // 重开后重新走完整流程并可再次关闭
  await toReviewed(base, reopened.json);
  const reclosed = await api(base, `/api/nonconformities/${nc.id}/close`, { method: "POST", body: {} });
  assert.equal(reclosed.status, 200);
  assert.equal(reclosed.json.reopenCount, 1);
});

test("并发提交整改只有一次成功", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" } })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 4);
  const cur = (await api(base, `/api/nonconformities/${nc.id}`)).json;
  assert.equal(cur.history.filter(h => h.action === "提交整改").length, 1, "只留一条提交记录");
});

test("并发复核只有一次成功", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" } });
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: true, independentConfirmation: true } })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 4);
});

test("并发关闭只有一次成功", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const nc = await makeNc(base, audit.id);
  await toReviewed(base, nc);
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api(base, `/api/nonconformities/${nc.id}/close`, { method: "POST", body: {} })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 4);
  const cur = (await api(base, `/api/nonconformities/${nc.id}`)).json;
  assert.equal(cur.history.filter(h => h.action === "关闭").length, 1);
});

test("相同幂等键的重复请求只执行一次并回放原响应", async () => {
  const { base } = await setup();
  const key = "audit-key-1";
  const first = await api(base, "/api/audits", { method: "POST", body: auditBody(), key });
  const second = await api(base, "/api/audits", { method: "POST", body: auditBody(), key });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.json.id, first.json.id);
  assert.equal(second.headers.get("idempotent-replay"), "true");
  assert.equal((await api(base, "/api/audits")).json.length, 1, "只创建一份计划");
  // 并发同键
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api(base, "/api/audits", { method: "POST", body: auditBody(), key: "audit-key-2" })));
  assert.ok(results.every(r => r.status === 201));
  assert.ok(results.every(r => r.json.id === results[0].json.id));
  assert.equal((await api(base, "/api/audits")).json.length, 2, "并发同键只生效一次");
  // 整改提交幂等
  const audit = results[0].json;
  const nc = await makeNc(base, audit.id);
  const s1 = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" }, key: "sub-1" });
  const s2 = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" }, key: "sub-1" });
  assert.equal(s1.status, 200);
  assert.equal(s2.status, 200);
  const cur = (await api(base, `/api/nonconformities/${nc.id}`)).json;
  assert.equal(cur.history.filter(h => h.action === "提交整改").length, 1);
});

test("列表接口：审核计划带不符合项统计，不符合项可按状态/严重度/批次过滤", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  await makeNc(base, audit.id, { batch: "PF-001" });
  await makeNc(base, audit.id, { batch: "PF-002", severity: "低", responsible: "陈岩" });
  const audits = (await api(base, "/api/audits")).json;
  assert.equal(audits[0].ncCount, 2);
  assert.equal(audits[0].openNcCount, 2);
  const detail = (await api(base, `/api/audits/${audit.id}`)).json;
  assert.equal(detail.nonconformities.length, 2);
  const high = (await api(base, "/api/nonconformities?severity=" + encodeURIComponent("高"))).json;
  assert.equal(high.length, 1);
  const byBatch = (await api(base, "/api/nonconformities?batch=PF-002")).json;
  assert.equal(byBatch.length, 1);
  const byStatus = (await api(base, "/api/nonconformities?status=" + encodeURIComponent("待整改"))).json;
  assert.equal(byStatus.length, 2);
});

test("既有台账接口行为不变", async () => {
  const { base } = await setup();
  const created = await api(base, "/api/items", { method: "POST", body: { code: "PF-003", source: "楮皮", vat: "二号缸", days: 1, owner: "林素", status: "入缸" } });
  assert.equal(created.status, 201);
  assert.equal(created.json.reviewStatus, "待复核");
  const patched = await api(base, "/api/items/PF-003", { method: "PATCH", body: { status: "发酵中" } });
  assert.equal(patched.status, 200);
  const logged = await api(base, "/api/items/PF-003/logs", { method: "POST", body: { step: "备注", note: "正常" } });
  assert.equal(logged.status, 201);
  const acted = await api(base, "/api/items/PF-003/action", { method: "POST", body: { temperature: "25", smell: "微酸", fiber: "松散" } });
  assert.equal(acted.status, 201);
  const stats = (await api(base, "/api/stats")).json;
  assert.ok("发酵中" in stats);
});
