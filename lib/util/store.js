/**
 * 存储模块：node:sqlite 打开/初始化 token-monitor.db，导出明细插入、
 * rollup upsert、水位读写助手。Schema 与 DESIGN.md §4 一致：
 * usage_requests（事实）+ usage_daily_rollups（预聚合）+ fold_watermarks（水位）+ sync_logs（计划）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * node:sqlite 在 Node 22 首次 require 时会向 stderr 打 ExperimentalWarning
 * （DSH 自身惰性加载 sqlite 就是为启动安静）。这里把 require 包进
 * emitWarning 过滤里，精准压掉这一条，不影响其他警告。
 */
let cachedDatabaseSync = null;
export function getDatabaseSync() {
  if (cachedDatabaseSync) return cachedDatabaseSync;
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (message.includes('SQLite is an experimental feature')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    cachedDatabaseSync = require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
  return cachedDatabaseSync;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_requests (
  -- 主键
  record_id      TEXT PRIMARY KEY,
  -- 维度
  source         TEXT NOT NULL,
  client         TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  session_id     TEXT,
  -- 用量
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- 派生指标
  cost_usd_nano  INTEGER,
  ttft_ms        INTEGER,
  -- 时间戳收尾
  day            TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_day        ON usage_requests (day);
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model      ON usage_requests (model, day);

CREATE TABLE IF NOT EXISTS fold_watermarks (
  session_id    TEXT PRIMARY KEY,
  log_path      TEXT NOT NULL,
  last_seq      INTEGER NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  title         TEXT,
  last_offset   INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  day       TEXT NOT NULL,
  source    TEXT NOT NULL,
  provider  TEXT NOT NULL,
  model     TEXT NOT NULL,
  requests         INTEGER NOT NULL DEFAULT 0,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_nano    INTEGER NOT NULL DEFAULT 0,
  unpriced_requests INTEGER NOT NULL DEFAULT 0,
  ttft_sum_ms      INTEGER NOT NULL DEFAULT 0,
  ttft_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, provider, model)
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,
  imported    INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  errors      TEXT
);
`;

/** 毫秒时间戳 → 本地时区 'YYYY-MM-DD'。 */
export function dayOf(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function openUsageStore(logger) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = path.join(dshHome, 'storages', 'token-monitor');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'token-monitor.db');
  const db = new (getDatabaseSync())(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // 增量迁移：fold_watermarks 补 last_offset 列（字节级增量读取的水位）
  const wmCols = db.prepare("SELECT name FROM pragma_table_info('fold_watermarks')").all().map((r) => r.name);
  if (!wmCols.includes('last_offset')) {
    db.exec('ALTER TABLE fold_watermarks ADD COLUMN last_offset INTEGER NOT NULL DEFAULT 0');
  }
  logger?.info?.(`token-monitor: 用量库已就绪 ${dbPath}`);

  const insertRequest = db.prepare(`
    INSERT OR IGNORE INTO usage_requests
      (record_id, source, client, provider, model, session_id,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd_nano, ttft_ms, day, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertRollup = db.prepare(`
    INSERT INTO usage_daily_rollups
      (day, source, provider, model, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd_nano, unpriced_requests, ttft_sum_ms, ttft_count)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, source, provider, model) DO UPDATE SET
      requests = requests + 1,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      cost_usd_nano = cost_usd_nano + COALESCE(excluded.cost_usd_nano, 0),
      unpriced_requests = unpriced_requests + excluded.unpriced_requests,
      ttft_sum_ms = ttft_sum_ms + excluded.ttft_sum_ms,
      ttft_count = ttft_count + excluded.ttft_count
  `);

  const getWatermarkStmt = db.prepare('SELECT * FROM fold_watermarks WHERE session_id = ?');
  const putWatermarkStmt = db.prepare(`
    INSERT OR REPLACE INTO fold_watermarks (session_id, log_path, last_seq, file_mtime_ms, title, last_offset, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const removeWatermarkStmt = db.prepare('DELETE FROM fold_watermarks WHERE session_id = ?');

  /**
   * 一条用量事实入库：明细 INSERT 成功（非重复）才 upsert rollup（changes > 0 防双计）。
   * 调用方负责包事务。返回是否为新行。
   */
  function recordUsage(row) {
    const result = insertRequest.run(
      row.recordId, row.source, row.client, row.provider, row.model, row.sessionId ?? null,
      row.input, row.output, row.cacheRead, row.cacheWrite,
      row.costNano, row.ttftMs ?? null, row.day, row.createdAt,
    );
    if (Number(result.changes) === 0) return false;
    upsertRollup.run(
      row.day, row.source, row.provider, row.model,
      row.input, row.output, row.cacheRead, row.cacheWrite,
      row.costNano ?? 0, row.costNano === null ? 1 : 0,
      row.ttftMs ?? 0, row.ttftMs != null ? 1 : 0,
    );
    return true;
  }

  function getWatermark(sessionId) {
    return getWatermarkStmt.get(sessionId) || null;
  }

  function putWatermark(w) {
    putWatermarkStmt.run(w.sessionId, w.logPath, w.lastSeq, w.fileMtimeMs, w.title ?? null, w.lastOffset ?? 0, Date.now());
  }

  function removeWatermark(sessionId) {
    removeWatermarkStmt.run(sessionId);
  }

  /** 删除某来源的全部用量数据（明细 + 对应 rollup）；返回删除的明细行数。 */
  function deleteBySource(source) {
    let deleted = 0;
    transaction(() => {
      const detail = db.prepare('DELETE FROM usage_requests WHERE source = ?').run(source);
      deleted = Number(detail.changes) || 0;
      db.prepare('DELETE FROM usage_daily_rollups WHERE source = ?').run(source);
    });
    return deleted;
  }

  /** 事务包装：fn 内所有写要么全部提交要么全部回滚。 */
  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    db, dbPath,
    recordUsage, getWatermark, putWatermark, removeWatermark, deleteBySource, transaction,
    close: () => db.close(),
  };
}
