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
async function startAudit(base, id) {
  const res = await api(base, `/api/audits/${id}`, { method: "PATCH", body: { status: "审核中" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}
async function makeActiveAudit(base, over = {}) {
  const audit = await makeAudit(base, over);
  await startAudit(base, audit.id);
  return audit;
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

test("升级迁移：已有审核、不符合项、幂等数据不丢失，遗留幂等记录不误回放", async () => {
  const legacy = {
    ...ledgerSeed(),
    schemaVersion: 2,
    audits: [{ id: "AUD-old", standardVersion: "QMS-2025", scope: "老车间", auditor: "王敏", startDate: "2026-01-05", endDate: "", samples: [], status: "审核中", createdAt: "2026-01-01T00:00:00.000Z" }],
    nonconformities: [{ id: "NC-old", auditId: "AUD-old", batch: "PF-001", clause: "7.1", severity: "中", evidence: "e", description: "", responsible: "林素", deadline: "2026-02-01", status: "待整改", rectification: null, review: null, closedAt: null, closedBy: null, reopenCount: 0, version: 1, corrections: [], history: [], createdAt: "2026-01-06T00:00:00.000Z" }],
    idempotency: { "old-key": { status: 201, body: { id: "AUD-old", scope: "老车间" }, at: "2026-01-01T00:00:00.000Z" } }
  };
  const { base, dbPath } = await setup(legacy);
  const audits = (await api(base, "/api/audits")).json;
  assert.ok(audits.some(a => a.id === "AUD-old"), "已有审核保留");
  const ncs = (await api(base, "/api/nonconformities")).json;
  assert.ok(ncs.some(n => n.id === "NC-old"), "已有不符合项保留");
  // 遗留幂等记录没有请求指纹：同键请求不得回放旧响应，也不得重复执行
  const conflict = await api(base, "/api/audits", { method: "POST", body: auditBody(), key: "old-key" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, "idempotency_conflict");
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  assert.equal(db.idempotency["old-key"].legacy, true, "遗留记录保留并标记，不丢失");
  assert.equal(db.audits.length, 1, "冲突请求未执行，不留半项");
  assert.equal(db.schemaVersion, 3);
  // 新键正常工作
  const created = await api(base, "/api/audits", { method: "POST", body: auditBody(), key: "new-key" });
  assert.equal(created.status, 201);
  const replay = await api(base, "/api/audits", { method: "POST", body: auditBody(), key: "new-key" });
  assert.equal(replay.json.id, created.json.id, "新格式记录正常回放");
});

test("审核计划：绑定标准版本、范围、审核员、日期，样本可追溯到批次", async () => {
  const { base } = await setup();
  const missing = await api(base, "/api/audits", { method: "POST", body: { scope: "x" } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, "validation_failed");
  const badSample = await api(base, "/api/audits", { method: "POST", body: auditBody({ samples: ["PF-999"] }) });
  assert.equal(badSample.status, 400);
  const audit = await makeAudit(base);
  assert.equal(audit.status, "计划中");
  assert.equal(audit.standardVersion, "QMS-2026-A");
  assert.deepEqual(audit.samples.map(sm => sm.batch), ["PF-001", "PF-002"]);
  assert.equal(audit.samples[0].source, "构树皮", "样本快照可追溯批次信息");
});

test("日期只接受真实存在的日历日期，结束日期不得早于开始日期", async () => {
  const { base } = await setup();
  for (const startDate of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-1-01", "20260901", "abc"]) {
    const res = await api(base, "/api/audits", { method: "POST", body: auditBody({ startDate }) });
    assert.equal(res.status, 400, `开始日期 ${startDate} 应被拒绝`);
    assert.equal(res.json.error, "validation_failed");
  }
  for (const endDate of ["2026-02-29", "2026-04-31", "2026-09-31"]) {
    const res = await api(base, "/api/audits", { method: "POST", body: auditBody({ endDate }) });
    assert.equal(res.status, 400, `结束日期 ${endDate} 应被拒绝（2026 年非闰年）`);
  }
  const leap = await api(base, "/api/audits", { method: "POST", body: auditBody({ startDate: "2028-02-28", endDate: "2028-02-29" }) });
  assert.equal(leap.status, 201, "2028 闰年 2-29 合法");
  const order = await api(base, "/api/audits", { method: "POST", body: auditBody({ startDate: "2026-09-10", endDate: "2026-09-01" }) });
  assert.equal(order.status, 400, "结束日期早于开始日期");
  // 整改期限同样校验
  const audit = await makeActiveAudit(base);
  for (const deadline of ["2026-02-30", "2027-02-29", "十月一日", "2027-1-1"]) {
    const res = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody({ deadline }) });
    assert.equal(res.status, 400, `整改期限 ${deadline} 应被拒绝`);
  }
  const ok = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody({ deadline: "2028-02-29" }) });
  assert.equal(ok.status, 201);
});

test("只有审核中才能登记不符合项", async () => {
  const { base } = await setup();
  const audit = await makeAudit(base);
  const planned = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody() });
  assert.equal(planned.status, 409, "计划中不允许登记");
  assert.equal(planned.json.error, "invalid_status");
  await startAudit(base, audit.id);
  const active = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody() });
  assert.equal(active.status, 201, "审核中允许登记");
  await api(base, `/api/audits/${audit.id}`, { method: "PATCH", body: { status: "已完成" } });
  const done = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody() });
  assert.equal(done.status, 409, "已完成不允许登记");
  const all = (await api(base, "/api/nonconformities")).json;
  assert.equal(all.length, 1, "失败的登记不留半项");
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
});

test("不符合项登记：条款、严重度、证据、责任人、期限必填，批次须在样本范围内", async () => {
  const { base } = await setup();
  const audit = await makeActiveAudit(base, { samples: ["PF-001"] });
  const missing = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: { severity: "高" } });
  assert.equal(missing.status, 400);
  const badSeverity = await api(base, `/api/audits/${audit.id}/nonconformities`, { method: "POST", body: ncBody({ severity: "严重" }) });
  assert.equal(badSeverity.status, 400);
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
  const audit = await makeActiveAudit(base);
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
  const audit = await makeActiveAudit(base);
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
  const audit = await makeActiveAudit(base);
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
  const audit = await makeActiveAudit(base);
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
  const audit = await makeActiveAudit(base);
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
  const audit = await makeActiveAudit(base);
  const nc = await makeNc(base, audit.id);
  const res = await api(base, `/api/nonconformities/${nc.id}/corrections`, { method: "POST", body: { note: "x", by: "王敏" } });
  assert.equal(res.status, 409);
});

test("复发可重开：需原因，归档上一轮整改复核，可再次走完全流程", async () => {
  const { base } = await setup();
  const audit = await makeActiveAudit(base);
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
  const audit = await makeActiveAudit(base);
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
  const audit = await makeActiveAudit(base);
  const nc = await makeNc(base, audit.id);
  await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" } });
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: true, independentConfirmation: true } })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 4);
});

test("并发关闭只有一次成功", async () => {
  const { base } = await setup();
  const audit = await makeActiveAudit(base);
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
  // 并发同键同请求
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api(base, "/api/audits", { method: "POST", body: auditBody(), key: "audit-key-2" })));
  assert.ok(results.every(r => r.status === 201));
  assert.ok(results.every(r => r.json.id === results[0].json.id));
  assert.equal((await api(base, "/api/audits")).json.length, 2, "并发同键只生效一次");
  // 字段顺序不同但内容相同的请求视为同一请求
  const shuffled = await api(base, "/api/audits", { method: "POST", key: "audit-key-2", body: {
    samples: ["PF-001", "PF-002"], endDate: "2026-09-30", startDate: "2026-09-01", auditor: "王敏", scope: "浸泡车间", standardVersion: "QMS-2026-A"
  } });
  assert.equal(shuffled.json.id, results[0].json.id, "规范化后同请求回放");
  // 整改提交幂等
  const audit = results[0].json;
  await startAudit(base, audit.id);
  const nc = await makeNc(base, audit.id);
  const s1 = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" }, key: "sub-1" });
  const s2 = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" }, key: "sub-1" });
  assert.equal(s1.status, 200);
  assert.equal(s2.status, 200);
  const cur = (await api(base, `/api/nonconformities/${nc.id}`)).json;
  assert.equal(cur.history.filter(h => h.action === "提交整改").length, 1);
});

test("幂等键按操作范围隔离：不同接口或不同内容不得回放旧响应", async () => {
  const { base } = await setup();
  const audit = await makeActiveAudit(base);
  const nc = await makeNc(base, audit.id);
  // 同键不同接口：先提交整改，再用同键请求复核
  const sub = await api(base, `/api/nonconformities/${nc.id}/submit`, { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" }, key: "scope-1" });
  assert.equal(sub.status, 200);
  const crossPath = await api(base, `/api/nonconformities/${nc.id}/review`, { method: "POST", body: { reviewer: "赵衡", approved: true }, key: "scope-1" });
  assert.equal(crossPath.status, 409);
  assert.equal(crossPath.json.error, "idempotency_conflict");
  let cur = (await api(base, `/api/nonconformities/${nc.id}`)).json;
  assert.equal(cur.status, "待复核", "冲突请求未执行，状态未被误推进");
  assert.equal(cur.review, null, "未留下复核半项");
  // 同键同接口不同内容
  const a1 = await api(base, "/api/audits", { method: "POST", body: auditBody({ scope: "一车间" }), key: "scope-2" });
  assert.equal(a1.status, 201);
  const a2 = await api(base, "/api/audits", { method: "POST", body: auditBody({ scope: "二车间" }), key: "scope-2" });
  assert.equal(a2.status, 409);
  assert.equal(a2.json.error, "idempotency_conflict");
  assert.equal((await api(base, "/api/audits")).json.filter(a => a.scope === "二车间").length, 0, "不同内容未被执行");
  // 失败的请求不占用幂等键：同键修正后可成功
  const bad = await api(base, "/api/audits", { method: "POST", body: { scope: "缺字段" }, key: "scope-3" });
  assert.equal(bad.status, 400);
  const good = await api(base, "/api/audits", { method: "POST", body: auditBody(), key: "scope-3" });
  assert.equal(good.status, 201, "失败请求不留占用，同键可正常执行");
});

test("列表接口：审核计划带不符合项统计，不符合项可按状态/严重度/批次过滤", async () => {
  const { base } = await setup();
  const audit = await makeActiveAudit(base);
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

test("页面与接口一致：登记表单只列审核中的计划，日期用日期控件", async () => {
  const { base } = await setup();
  const res = await fetch(base + "/");
  const html = await res.text();
  assert.ok(html.includes("audits.filter(a => a.status === '审核中')"), "不符合项登记只提供审核中的计划");
  assert.ok(html.includes('name="startDate" type="date"'), "计划开始日期使用日期控件");
  assert.ok(html.includes('name="endDate" type="date"'), "计划结束日期使用日期控件");
  assert.ok(html.includes('name="deadline" type="date"'), "整改期限使用日期控件");
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
