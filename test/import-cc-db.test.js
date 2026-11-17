/**
 * cc-switch 数据库导入的水位语义。
 *
 * 背景（2026-11-17）：汇总水位必须 **含边界日**（`date >= 上次最大日期`）——
 * 那一天的 request_count 是整天累计值，同步当时可能还没结束，只有重取整天才拿得到最新值；
 * 覆盖 upsert 保证重取不翻倍。另外"上传别的机器的 db"必须走 full 模式（不读也不写本机水位），
 * 否则本机水位会把对方早于水位的历史整段跳掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { importCcRollups, importCcSwitch } from '../lib/util/import-cc.js';

/** 造一个最小的 cc-switch 库文件。 */
function makeCcDb({ detail = [], rollups = [] } = {}) {
  const file = path.join(os.tmpdir(), `cc-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY, app_type TEXT, provider_id TEXT, model TEXT, session_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      input_token_semantics INTEGER, total_cost_usd TEXT, first_token_ms INTEGER, created_at INTEGER
    );
    CREATE TABLE usage_daily_rollups (
      date TEXT, app_type TEXT, provider_id TEXT, model TEXT, request_count INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      total_cost_usd TEXT, avg_latency_ms REAL
    );
  `);
  const insDetail = db.prepare(`INSERT INTO proxy_request_logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of detail) {
    insDetail.run(r.request_id, r.app_type || 'claude', r.provider_id || 'kimi-coding', r.model || 'k3', r.session_id || 's',
      r.input_tokens || 100, r.output_tokens || 50, r.cache_read_tokens || 0, r.cache_creation_tokens || 0, 0,
      r.total_cost_usd || '0.1', r.first_token_ms ?? 800, r.created_at);
  }
  const insRoll = db.prepare(`INSERT INTO usage_daily_rollups VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rollups) {
    insRoll.run(r.date, r.app_type || 'claude', r.provider_id || '_session', r.model || 'k3',
      r.request_count || 10, r.input_tokens || 1000, r.output_tokens || 200, r.cache_read_tokens || 0,
      r.cache_creation_tokens || 0, r.total_cost_usd || '0.0', r.avg_latency_ms || 0);
  }
  db.close();
  return file;
}

/** 只实现导入路径用到的 store 面。 */
function stubStore(watermarks = {}) {
  const rollups = [];
  const usage = [];
  const logs = [];
  return {
    rollups, usage, logs,
    transaction(fn) { fn(); },
    recordUsage(row) { usage.push(row); return true; },
    putRollupReplace(row) { rollups.push(row); },
    recordSyncLog(row) { logs.push(row); },
    getLastSyncWatermark(source, kind) { return watermarks[kind] ?? null; },
  };
}

test('汇总水位含边界日：>= 上次最大日期（不是严格 >）', () => {
  const dbFile = makeCcDb({
    rollups: [
      { date: '2026-08-16', request_count: 10 },
      { date: '2026-08-17', request_count: 20 }, // 边界日，可能还在增长
      { date: '2026-08-18', request_count: 30 },
    ],
  });
  const store = stubStore({ 'db-rollup': Date.parse('2026-08-17T00:00:00') });
  try {
    const cc = new DatabaseSync(dbFile, { readOnly: true });
    const result = importCcRollups(store, cc, null);
    cc.close();
    const days = store.rollups.map((r) => r.day).sort();
    assert.deepEqual(days, ['2026-08-17', '2026-08-18'], '边界日 08-17 必须重取');
    assert.equal(result.importedDays, 2);
  } finally { fs.unlinkSync(dbFile); }
});

test('full 模式：登记独立 kind，并按该 kind 写自己的水位', () => {
  const dbFile = makeCcDb({
    rollups: [
      { date: '2026-08-16', request_count: 10 },
      { date: '2026-08-17', request_count: 20 },
      { date: '2026-08-18', request_count: 30 },
    ],
  });
  const store = stubStore({ 'db-rollup': Date.parse('2026-08-17T00:00:00') });
  try {
    const cc = new DatabaseSync(dbFile, { readOnly: true });
    const result = importCcRollups(store, cc, null, { full: true });
    cc.close();
    // 本机 db-rollup 水位不能影响文件导入 → 3 天全进
    assert.equal(result.importedDays, 3, 'full 模式不受本机水位影响');
    const log = store.logs[store.logs.length - 1];
    assert.equal(log.kind, 'db-rollup-file', 'full 模式用独立 kind 记账（无指纹时）');
    assert.equal(log.watermark, Date.parse('2026-08-18T00:00:00'), '按该 kind 记自己的水位');
  } finally { fs.unlinkSync(dbFile); }
});

test('导入 db 文件：明细走独立 kind，且按该 kind 自己的水位增量', () => {
  const dbFile = makeCcDb({
    detail: [
      { request_id: 'r1', created_at: 1785000000 }, // 早于本机水位
      { request_id: 'r2', created_at: 1785000100 },
    ],
  });
  // 本机水位远晚于文件里的数据：本机 db-scan 会 0 条，文件导入必须全收
  const wm = Date.parse('2026-09-01T00:00:00');
  try {
    const normal = stubStore({ 'db-scan': wm });
    importCcSwitch(normal, dbFile, null, null);
    assert.equal(normal.usage.length, 0, '普通模式受本机水位限制（本机同步语义）');

    const full = stubStore({ 'db-scan': wm });
    const result = importCcSwitch(full, dbFile, null, null, { full: true });
    assert.equal(full.usage.length, 2, '文件导入不受本机水位限制');
    assert.equal(result.imported, 2);
    const log = full.logs.find((l) => String(l.kind).startsWith('db-scan-file'));
    assert.ok(log, '用 db-scan-file* 记账');
    assert.ok(log.watermark > 0, '写自己的水位');
  } finally { fs.unlinkSync(dbFile); }
});

test('设备指纹：从 session_log_sync 的路径前缀提取，不同机器分不同水位', () => {
  // 两个"设备"的库：用户目录不同
  const mk = (user) => {
    const file = path.join(os.tmpdir(), `cc-dev-${user}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE session_log_sync (file_path TEXT, last_synced_at INTEGER);
      CREATE TABLE proxy_request_logs (
        request_id TEXT PRIMARY KEY, app_type TEXT, provider_id TEXT, model TEXT, session_id TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
        input_token_semantics INTEGER, total_cost_usd TEXT, first_token_ms INTEGER, created_at INTEGER
      );
      CREATE TABLE usage_daily_rollups (
        date TEXT, app_type TEXT, provider_id TEXT, model TEXT, request_count INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
        total_cost_usd TEXT, avg_latency_ms REAL
      );
    `);
    for (let i = 0; i < 3; i += 1) {
      db.prepare('INSERT INTO session_log_sync VALUES (?, ?)').run(`C:\\Users\\${user}\\.claude\\projects\\p${i}.jsonl`, 1);
    }
    db.prepare('INSERT INTO proxy_request_logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('req-' + user, 'claude', 'kimi-coding', 'k3', 's', 100, 50, 0, 0, 0, '0.1', 800, 1785000000);
    db.close();
    return file;
  };

  const fileA = mk('licy');
  const fileB = mk('18336');
  const store = stubStore({});
  try {
    importCcSwitch(store, fileA, null, null, { full: true });
    importCcSwitch(store, fileB, null, null, { full: true });
    const kinds = store.logs.map((l) => l.kind).filter((k) => String(k).startsWith('db-scan-file'));
    assert.equal(kinds.length, 2);
    assert.notEqual(kinds[0], kinds[1], '两台设备必须是不同水位线');
    assert.ok(/^db-scan-file@[0-9a-f]{8}$/.test(kinds[0]), '指纹是 8 位 hash，不落用户名');
    assert.ok(!kinds.join(',').includes('licy'), '不能把用户名写进审计表');
  } finally {
    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
  }
});
