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

-- 主键含 session_id：DSH 折叠行存真实会话 id（弹层"用量详情"聚焦按会话聚合查询，
-- 明细被 60 天清理删除后，会话历史由此维度永久承载）；CC 行无会话概念，统一存 ''。
-- 不带 session 的查询按 (day, model) 等维度 GROUP BY 时自然跨会话聚合，SQL 无需变化。
CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  day       TEXT NOT NULL,
  source    TEXT NOT NULL,
  client    TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
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
  PRIMARY KEY (day, source, client, session_id, provider, model)
);

-- 提供方映射表：provider_id（库内存储的提供方 ID）→ 提供方名称 + 供应商。
-- 查询层 left join（或内存映射）后按 vendor 聚合展示；未知 provider 无行时原样显示 id。
CREATE TABLE IF NOT EXISTS provider_mappings (
  provider_id   TEXT PRIMARY KEY,   -- 提供方 ID（kimi-coding / moonshotai-cn / deepseek…）
  provider_name TEXT NOT NULL,      -- 提供方名称（Kimi For Coding / 月之暗面 / DeepSeek…）
  vendor        TEXT NOT NULL,      -- 供应商（kimi / deepseek / zhipu…）
  sort_order    INTEGER NOT NULL DEFAULT 0
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
  skipped_unknown_app INTEGER NOT NULL DEFAULT 0,
  watermark   INTEGER,               -- 本次同步扫到的最大 created_at（毫秒），增量探测的游标
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
  // 增量迁移：sync_logs 补 skipped_unknown_app（定稿统计口径）与 watermark（增量探测游标）列
  const slCols = db.prepare("SELECT name FROM pragma_table_info('sync_logs')").all().map((r) => r.name);
  if (!slCols.includes('skipped_unknown_app')) {
    db.exec('ALTER TABLE sync_logs ADD COLUMN skipped_unknown_app INTEGER NOT NULL DEFAULT 0');
  }
  if (!slCols.includes('watermark')) {
    db.exec('ALTER TABLE sync_logs ADD COLUMN watermark INTEGER');
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
      (day, source, client, session_id, provider, model, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd_nano, unpriced_requests, ttft_sum_ms, ttft_count)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, source, client, session_id, provider, model) DO UPDATE SET
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

  /**
   * CC 历史聚合迁移用：覆盖语义 upsert（有则整体替换、无则新增）。
   * 与 upsertRollup（明细镜像的累加语义）并存、互不干扰——
   * CC 的 rollup 行是"那天已完成聚合"的定格值，重复同步/老化窗口下
   * 覆盖同值无副作用；累加会把同一天的聚合翻倍（必须避免）。
   * session_id 恒 ''（CC 无会话概念）。
   */
  const upsertRollupReplace = db.prepare(`
    INSERT INTO usage_daily_rollups
      (day, source, client, session_id, provider, model, requests,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd_nano, unpriced_requests, ttft_sum_ms, ttft_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, source, client, session_id, provider, model) DO UPDATE SET
      requests = excluded.requests,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cost_usd_nano = excluded.cost_usd_nano,
      unpriced_requests = excluded.unpriced_requests,
      ttft_sum_ms = excluded.ttft_sum_ms,
      ttft_count = excluded.ttft_count
  `);

  /** 写入一条 CC 聚合行（覆盖语义；session_id 恒 ''）。 */
  function putRollupReplace(row) {
    upsertRollupReplace.run(
      row.day, row.source, row.client, '', row.provider, row.model,
      row.requests,
      row.input, row.output, row.cacheRead, row.cacheWrite,
      row.costNano ?? 0, row.unpriced ?? 0,
      row.ttftSum ?? 0, row.ttftCount ?? 0,
    );
  }

  const getWatermarkStmt = db.prepare('SELECT * FROM fold_watermarks WHERE session_id = ?');
  const putWatermarkStmt = db.prepare(`
    INSERT OR REPLACE INTO fold_watermarks (session_id, log_path, last_seq, file_mtime_ms, title, last_offset, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const removeWatermarkStmt = db.prepare('DELETE FROM fold_watermarks WHERE session_id = ?');

  /**
   * 一条用量事实入库：明细 INSERT 成功（非重复）才 upsert rollup（changes > 0 防双计）。
   * 调用方负责包事务。返回是否为新行。
   * rollup 的 session_id 维度：DSH 折叠行存真实会话 id（聚焦查询用）；
   * CC 行统一 ''（CC 无会话概念，不参与会话维度）。
   */
  function recordUsage(row) {
    const result = insertRequest.run(
      row.recordId, row.source, row.client, row.provider, row.model, row.sessionId ?? null,
      row.input, row.output, row.cacheRead, row.cacheWrite,
      row.costNano, row.ttftMs ?? null, row.day, row.createdAt,
    );
    if (Number(result.changes) === 0) return false;
    const sessKey = row.source === 'dsh-logs' ? (row.sessionId || '') : '';
    upsertRollup.run(
      row.day, row.source, row.client, sessKey, row.provider, row.model,
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

  /**
   * 记录一次同步动作（审计 + 水位）。source 为 SyncSource.id；
   * status: 'ok' | 'partial' | 'failed'；watermark 为本次扫到的最大 created_at（毫秒），
   * 下一次该源的增量探测以此为起点（无记录 = 全量）。
   */
  function recordSyncLog(entry) {
    db.prepare(`
      INSERT INTO sync_logs
        (source, kind, started_at, finished_at, status,
         imported, skipped, skipped_unknown_app, watermark, files_scanned, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.source, entry.kind || 'manual', entry.startedAt ?? Date.now(),
      entry.finishedAt ?? Date.now(), entry.status || 'ok',
      entry.imported || 0, entry.skipped || 0, entry.skippedUnknownApp || 0,
      entry.watermark ?? null, entry.filesScanned || 0,
      entry.errors && entry.errors.length ? JSON.stringify(entry.errors) : null,
    );
  }

  /**
   * 某源最近一次成功（ok/partial）同步的水位（毫秒）；没有成功记录返回 null（= 全量扫）。
   * kind 限定同步方式（'db-scan' 读本机 db / 'sql-import' 解析 SQL 文件）——两种方式的水位
   * 只对各自的数据源有效，不能混用（SQL 文件可能是其他设备导出的快照，其水位不能当本机 db 的起点）。
   */
  function getLastSyncWatermark(source, kind) {
    const row = kind
      ? db.prepare(`
          SELECT watermark FROM sync_logs
          WHERE source = ? AND kind = ? AND status IN ('ok', 'partial') AND watermark IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get(source, kind)
      : db.prepare(`
          SELECT watermark FROM sync_logs
          WHERE source = ? AND status IN ('ok', 'partial') AND watermark IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get(source);
    return row ? row.watermark : null;
  }

  /**
   * 删除某来源的全部用量数据（明细 + 对应 rollup）；返回删除的明细行数。
   * 同时清空该源的 sync_logs（审计 + 水位）：否则删除后 checkCcPending 会
   * 认为记录全部"未同步"（imported 集合已空）→ 弹层又提示可同步 → 用户再点
   * 同步就把数据全导回来了，"删除"形同虚设。
   */
  function deleteBySource(source) {
    let deleted = 0;
    transaction(() => {
      const detail = db.prepare('DELETE FROM usage_requests WHERE source = ?').run(source);
      deleted = Number(detail.changes) || 0;
      db.prepare('DELETE FROM usage_daily_rollups WHERE source = ?').run(source);
      db.prepare('DELETE FROM sync_logs WHERE source = ?').run(source);
    });
    return deleted;
  }

  /**
   * 明细定期清理（prune）：删除 day < cutoffDay 的全部明细行，返回删除行数。
   * 只删 usage_requests，不碰 usage_daily_rollups——rollup 是实时增量镜像，
   * 历史统计由它继续承载（清理是"删除"而非 CC 式"归档迁移"）。
   * 逐天删除：每天一次 DELETE（走 day 索引），单次事务体积天然受控，不依赖 DELETE LIMIT。
   */
  function pruneOldRows(cutoffDay) {
    const first = db.prepare('SELECT MIN(day) AS d FROM usage_requests').get().d;
    if (!first || first >= cutoffDay) return 0;
    const stmt = db.prepare('DELETE FROM usage_requests WHERE day = ?');
    const pad = (x) => String(x).padStart(2, '0');
    let day = first;
    let deleted = 0;
    while (day < cutoffDay) {
      deleted += Number(stmt.run(day).changes) || 0;
      const dt = new Date(`${day}T00:00:00`);
      dt.setDate(dt.getDate() + 1);
      day = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    }
    return deleted;
  }

  /**
   * 最近一次成功清理（kind='prune'）的完成时间（毫秒）；无记录返回 null。
   * 作为 prune 的内存时间闸的持久化源：进程重启后从 sync_logs 恢复，
   * 与 CC 导入的 watermark 同表不同 kind，互不干扰。
   */
  function getLastPruneAt() {
    const row = db.prepare(`
      SELECT finished_at FROM sync_logs
      WHERE kind = 'prune' AND status IN ('ok', 'partial')
      ORDER BY id DESC LIMIT 1
    `).get();
    return row ? row.finished_at : null;
  }

  /** 全量读提供方映射：{ provider_id: { provider_name, vendor, sort_order } }。 */
  function getProviderMappings() {
    const out = {};
    const rows = db.prepare(`
      SELECT provider_id, provider_name, vendor, sort_order FROM provider_mappings
    `).all();
    for (const r of rows) {
      out[r.provider_id] = { provider_name: r.provider_name, vendor: r.vendor, sort_order: r.sort_order || 0 };
    }
    return out;
  }

  /** 幂等 upsert 一条提供方映射（provider_id 存在则覆盖）。 */
  function upsertProviderMapping(m) {
    db.prepare(`
      INSERT INTO provider_mappings (provider_id, provider_name, vendor, sort_order)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        provider_name = excluded.provider_name,
        vendor = excluded.vendor,
        sort_order = excluded.sort_order
    `).run(m.providerId, m.providerName, m.vendor, m.sortOrder ?? 0);
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
    recordSyncLog, getLastSyncWatermark,
    putRollupReplace,
    pruneOldRows, getLastPruneAt,
    getProviderMappings, upsertProviderMapping,
    close: () => db.close(),
  };
}
