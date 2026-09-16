import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createApp } from "../server.js";

const cleanups = [];
after(async () => { await Promise.all(cleanups.map(fn => fn())); });

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function setup(seedData) {
  const dir = await mkdtemp(join(tmpdir(), "persist-test-"));
  const dbPath = join(dir, "db.json");
  if (seedData) await writeFile(dbPath, JSON.stringify(seedData, null, 2));
  const server = createApp({ dbPath });
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  cleanups.push(async () => { await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { base, dbPath, dir };
}

async function api(base, path, { method = "GET", body, key, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body || raw ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined)
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

const tmpFiles = async (dir) => (await readdir(dir)).filter(f => f.endsWith(".tmp"));

test("并发首次加载：初始化只安全成功一次，结果稳定，无重命名失败", async () => {
  const { base, dbPath, dir } = await setup(null); // 数据文件不存在
  const results = await Promise.all(Array.from({ length: 20 }, () => api(base, "/api/items")));
  assert.ok(results.every(r => r.status === 200), "全部请求成功，无重命名失败");
  const first = JSON.stringify(results[0].json);
  assert.ok(results.every(r => JSON.stringify(r.json) === first), "并发读取结果一致稳定");
  assert.equal(results[0].json[0].code, "PF-001", "种子数据只初始化一次");
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  assert.equal(db.schemaVersion, 3);
  assert.deepEqual(await tmpFiles(dir), [], "无临时文件残留");
});

test("并发迁移：升级只安全成功一次，并发读取结果一致", async () => {
  const legacy = {
    items: [{ code: "PF-001", source: "构树皮", vat: "三号缸", days: 5, owner: "林素", status: "发酵中", logs: [] }]
  };
  const { base, dbPath, dir } = await setup(legacy);
  const results = await Promise.all(Array.from({ length: 20 }, () => api(base, "/api/items")));
  assert.ok(results.every(r => r.status === 200), "并发迁移无重命名失败");
  const first = JSON.stringify(results[0].json);
  assert.ok(results.every(r => JSON.stringify(r.json) === first), "迁移期间读取结果稳定一致");
  assert.ok(results[0].json.every(i => i.reviewStatus === "待复核"), "历史项标待复核");
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  assert.equal(db.schemaVersion, 3);
  assert.deepEqual(db.audits, []);
  assert.deepEqual(await tmpFiles(dir), []);
});

test("失败请求不损坏、不覆盖、不残留半写数据", async () => {
  const { base, dbPath, dir } = await setup({ items: [{ code: "PF-001", owner: "林素" }] });
  await api(base, "/api/items"); // 触发迁移落库
  const before = await readFile(dbPath, "utf8");
  // 非法 JSON
  const badJson = await api(base, "/api/audits", { method: "POST", raw: "{not json" });
  assert.equal(badJson.status, 400);
  // 校验失败（缺必填字段，且带幂等键）
  const invalid = await api(base, "/api/audits", { method: "POST", body: { scope: "缺字段" }, key: "fail-key" });
  assert.equal(invalid.status, 400);
  // 状态机冲突
  const conflict = await api(base, "/api/nonconformities/NC-ghost/submit", { method: "POST", body: { cause: "c", evidence: "e", submittedBy: "林素" } });
  assert.equal(conflict.status, 404);
  assert.equal(await readFile(dbPath, "utf8"), before, "失败后数据文件字节不变");
  assert.deepEqual(await tmpFiles(dir), [], "无临时文件残留");
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  assert.ok(!db.idempotency["fail-key"], "失败请求不占用幂等键");
  // 后续正常请求不受影响
  const ok = await api(base, "/api/audits", { method: "POST", body: { standardVersion: "A", scope: "x", auditor: "王敏", startDate: "2026-09-01" }, key: "fail-key" });
  assert.equal(ok.status, 201, "同键可正常使用，失败不留占用");
});

test("读写混合并发：读取结果始终是完整一致的快照", async () => {
  const { base, dir } = await setup({ items: [{ code: "PF-001", owner: "林素" }] });
  const writes = Array.from({ length: 5 }, (_, i) =>
    api(base, "/api/items", { method: "POST", body: { code: `PF-W${i}`, owner: "林素", status: "入缸" } }));
  const reads = Array.from({ length: 20 }, () => api(base, "/api/items"));
  const [writeResults, readResults] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
  assert.ok(writeResults.every(r => r.status === 201));
  for (const r of readResults) {
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json), "读取到完整 JSON，非半写内容");
    const codes = r.json.map(i => i.code);
    assert.equal(new Set(codes).size, codes.length, "快照内无重复或撕裂记录");
  }
  assert.deepEqual(await tmpFiles(dir), []);
});

test("测试入口 node --test 能发现并通过全部用例", { skip: !!process.env.TEST_ENTRY_SUBPROCESS && "子进程内跳过防递归" }, async () => {
  const env = { ...process.env, TEST_ENTRY_SUBPROCESS: "1" };
  delete env.NODE_TEST_CONTEXT; // 让子进程以根运行器身份输出完整 TAP
  const result = spawnSync(process.execPath, ["--test", "test/"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /# fail 0/);
  const pass = /# pass (\d+)/.exec(result.stdout);
  assert.ok(pass && Number(pass[1]) >= 26, `应发现全部用例，实际通过 ${pass && pass[1]}`);
  // 两个测试文件的用例都被发现
  assert.match(result.stdout, /并发首次加载/, "persistence.test.js 被发现");
  assert.match(result.stdout, /只有审核中才能登记不符合项/, "audit.test.js 被发现");
});
