import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 每个用例用独立临时 DSH_HOME，避免污染真实库。 */
async function freshStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-prices-'));
  process.env.DSH_HOME = tmp;
  const store = await import('../lib/util/store.js');
  const pricing = await import('../lib/util/pricing.js');
  const handle = store.openUsageStore({ info() {}, warn() {} });
  return {
    db: handle.db,
    store: handle,
    pricing,
    cleanup() {
      try { handle.close(); } catch { /* 忽略 */ }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const countRows = (db) => db.prepare('SELECT COUNT(*) AS c FROM model_prices').get().c;
const models = (db) => db.prepare('SELECT DISTINCT model FROM model_prices ORDER BY model').all().map((r) => r.model);

test('空库首次写入全部内置段（含 Kimi 固定价）', async () => {
  const ctx = await freshStore();
  try {
    const r = ctx.pricing.seedModelPrices(ctx.db, { info() {}, warn() {} });
    assert.equal(r.seeded, true);
    const ms = models(ctx.db);
    for (const m of ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3.1-pro', 'k3.1-pro-highspeed', 'deepseek-v4-pro']) {
      assert.ok(ms.includes(m), `缺少内置模型 ${m}`);
    }
    // Kimi 是固定价：不应带峰谷
    const k3 = ctx.db.prepare("SELECT mode, peak_multiplier, peak_windows, input_price, output_price, cache_create_price FROM model_prices WHERE model = 'k3'").get();
    assert.equal(k3.mode, 'fixed');
    assert.equal(k3.peak_multiplier, null);
    assert.equal(k3.peak_windows, null);
    assert.equal(k3.input_price, 200000);      // ¥20
    assert.equal(k3.output_price, 1000000);    // ¥100
    assert.equal(k3.cache_create_price, 200000); // ¥20
  } finally {
    ctx.cleanup();
  }
});

test('重复启动只执行一次：第二次不再插入任何行', async () => {
  const ctx = await freshStore();
  try {
    ctx.pricing.seedModelPrices(ctx.db, { info() {}, warn() {} });
    const n1 = countRows(ctx.db);
    assert.ok(n1 > 0);

    const log = { info() {}, warn() {} };
    ctx.pricing.syncBuiltinPrices(ctx.db, log);
    const n2 = countRows(ctx.db);
    assert.equal(n2, n1, '首次同步不应新增行（seed 已写入）');

    ctx.pricing.syncBuiltinPrices(ctx.db, log);
    ctx.pricing.syncBuiltinPrices(ctx.db, log);
    assert.equal(countRows(ctx.db), n1, '反复启动后行数必须不变');

    // 也没有重复的 (model, start_time)
    const dup = ctx.db.prepare('SELECT model, start_time, COUNT(*) AS c FROM model_prices GROUP BY model, start_time HAVING c > 1').all();
    assert.deepEqual(dup, []);
  } finally {
    ctx.cleanup();
  }
});

test('老库升级：缺的 Kimi 段只补一次，之后保持不动', async () => {
  const ctx = await freshStore();
  try {
    ctx.pricing.seedModelPrices(ctx.db, { info() {}, warn() {} });
    // 模拟"升级前的老库"：删掉 Kimi 那几段
    const kimiModels = ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3.1-pro', 'k3.1-pro-highspeed'];
    for (const m of kimiModels) ctx.db.prepare('DELETE FROM model_prices WHERE model = ?').run(m);
    const before = countRows(ctx.db);
    assert.ok(!models(ctx.db).includes('k3'));

    const log = { info() {}, warn() {} };
    ctx.pricing.syncBuiltinPrices(ctx.db, log);
    assert.ok(models(ctx.db).includes('k3'), '升级后应补入 Kimi 内置价');
    const afterFirst = countRows(ctx.db);
    assert.equal(afterFirst, before + kimiModels.length);

    // 再启动多次都不应再加
    ctx.pricing.syncBuiltinPrices(ctx.db, log);
    ctx.pricing.syncBuiltinPrices(ctx.db, log);
    assert.equal(countRows(ctx.db), afterFirst, '补入完之后不得再变化');
  } finally {
    ctx.cleanup();
  }
});

test('用户自定义价不会被内置价覆盖，也不会被删除', async () => {
  const ctx = await freshStore();
  try {
    ctx.pricing.seedModelPrices(ctx.db, { info() {}, warn() {} });
    // 用户把 k3 改成自定义价（新起一段）
    const now = Date.now();
    ctx.db.prepare(`
      INSERT INTO model_prices
        (model, display_name, mode, currency, input_cache_hit_price, input_price, output_price,
         cache_create_price, start_time, end_time, source, created_at, peak_multiplier, peak_windows)
      VALUES ('k3', 'Kimi K3 (mine)', 'fixed', 'CNY', 10000, 100000, 500000, 100000, ?, ?, 'custom', ?, NULL, NULL)
    `).run(now, 253402300799000, now);

    const log = { info() {}, warn() {} };
    ctx.pricing.syncBuiltinPrices(ctx.db, log);
    ctx.pricing.syncBuiltinPrices(ctx.db, log);

    const custom = ctx.db.prepare("SELECT COUNT(*) AS c FROM model_prices WHERE model = 'k3' AND source = 'custom'").get().c;
    assert.equal(custom, 1, '用户自定义行必须保留');
    const builtin = ctx.db.prepare("SELECT COUNT(*) AS c FROM model_prices WHERE model = 'k3' AND source = 'builtin'").get().c;
    assert.ok(builtin <= 1, '同模型不应堆出多段内置行');
  } finally {
    ctx.cleanup();
  }
});
