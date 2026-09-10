/**
 * DSH 用量数据导入导出（跨设备手动同步，§2.2/§11.3 扩展）。
 *
 * 导出 = 本机 source='dsh-logs' 的全量快照（明细 + rollup）序列化为 JSON：
 *   - detail：usage_requests 全部 dsh-logs 行（原样，含成本/ttft/时间戳）
 *     → 接收端请求记录表需要；成本随行带过去，不按接收端定价表重算。
 *   - rollups：usage_daily_rollups 全部 dsh-logs 行（含 session_id 维度）
 *     → 明细 60 天清理后只剩 rollup 承载长期历史，不导出聚合则接收端
 *       丢失 60 天前的趋势/排行/年度热力。
 *   - 元信息：app/kind/version/exportedAt/source，导入端据此校验格式。
 *
 * 导入 = 幂等合并（与 CC sql-import 同思路，全量快照无水位语义）：
 *   - detail 裸 INSERT OR IGNORE（record_id 主键去重）：绝不走 recordUsage，
 *     否则明细插入成功会联动 upsertRollup 累加，把接收端同键聚合翻倍。
 *   - rollups 覆盖语义 upsert（ON CONFLICT DO UPDATE = excluded）：
 *     重复导入/增量同步撞键时以文件值为准；跨设备 session_id 不相交，
 *     正常导入是纯新增，覆盖语义仅在"重复导入同文件"或"同会话日志被
 *     拷贝到两台设备"时触发，均为同值覆盖，无副作用。
 *   - 审计：写一行 sync_logs（source='dsh-logs', kind='file-import'，
 *     watermark 置 null——快照无增量游标，同 CC sql-import 约定）。
 */

import fs from 'node:fs';

export const EXPORT_KIND = 'dsh-token-monitor-usage';
export const EXPORT_VERSION = 1;

/**
 * 导出本机 dsh-logs 全量快照（明细 + rollup）。
 * @returns {{ kind, version, exportedAt, source, detail: object[], rollups: object[] }}
 */
export function exportDshUsage(store) {
  const detail = store.db.prepare(`
    SELECT record_id, source, client, provider, model, session_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cost_usd_nano, ttft_ms, day, created_at
    FROM usage_requests
    WHERE source = 'dsh-logs'
    ORDER BY created_at
  `).all();
  const rollups = store.db.prepare(`
    SELECT day, source, client, session_id, provider, model, requests,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cost_usd_nano, unpriced_requests, ttft_sum_ms, ttft_count
    FROM usage_daily_rollups
    WHERE source = 'dsh-logs'
    ORDER BY day
  `).all();
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    source: 'dsh-logs',
    detail,
    rollups,
  };
}

/**
 * 解析并校验导出文件内容（字符串）。结构不合法返回 { error }。
 */
export function parseDshExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: '文件不是合法 JSON' };
  }
  if (!data || typeof data !== 'object') return { error: '文件内容为空' };
  if (data.kind !== EXPORT_KIND) return { error: '不是 dsh-token-monitor 的用量导出文件' };
  if (data.version !== EXPORT_VERSION) return { error: `不支持的导出版本：${data.version}` };
  if (data.source !== 'dsh-logs') return { error: '仅支持 dsh-logs 来源的导出文件' };
  if (!Array.isArray(data.detail) || !Array.isArray(data.rollups)) {
    return { error: '导出文件缺少 detail/rollups 数据' };
  }
  return { data };
}

/** 从导入行里安全取整数字段（防御脏数据：非法/缺失按 0）。 */
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * 导入 DSH 导出快照（幂等合并）。返回 { imported, skipped, rollupDays, errors }。
 * 明细与 rollup 在同一事务里写入：要么全部生效要么全部回滚。
 */
export function importDshUsage(store, text, logger) {
  const parsed = parseDshExport(text);
  if (parsed.error) return { error: parsed.error };

  const result = { imported: 0, skipped: 0, rollupDays: 0, errors: [] };
  const startedAt = Date.now();
  const { detail, rollups } = parsed.data;

  try {
    store.transaction(() => {
      // 明细：裸 INSERT OR IGNORE，record_id 主键去重（不联动 rollup，见文件头注）
      const insertDetail = store.db.prepare(`
        INSERT OR IGNORE INTO usage_requests
          (record_id, source, client, provider, model, session_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cost_usd_nano, ttft_ms, day, created_at)
        VALUES (?, 'dsh-logs', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of detail) {
        if (!r || typeof r.record_id !== 'string' || !r.record_id) continue;
        const changes = insertDetail.run(
          r.record_id,
          String(r.client ?? 'dsh'),
          String(r.provider ?? 'unknown'),
          String(r.model ?? 'unknown'),
          r.session_id != null ? String(r.session_id) : null,
          toInt(r.input_tokens), toInt(r.output_tokens),
          toInt(r.cache_read_tokens), toInt(r.cache_write_tokens),
          toInt(r.cost_usd_nano), r.ttft_ms != null ? toInt(r.ttft_ms) : null,
          String(r.day ?? ''), toInt(r.created_at),
        );
        // run() 返回 { changes, lastInsertRowid }：changes=1 新插入，0 = record_id 主键冲突（重复）
        if (Number(changes && changes.changes) > 0) result.imported += 1;
        else result.skipped += 1;
      }

      // rollup：覆盖语义 upsert（重复导入/增量同步撞键时以文件值为准）
      const upsertRollup = store.db.prepare(`
        INSERT INTO usage_daily_rollups
          (day, source, client, session_id, provider, model, requests,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cost_usd_nano, unpriced_requests, ttft_sum_ms, ttft_count)
        VALUES (?, 'dsh-logs', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      for (const r of rollups) {
        if (!r || typeof r.day !== 'string' || !r.day) continue;
        upsertRollup.run(
          r.day,
          String(r.client ?? 'dsh'),
          String(r.session_id ?? ''),
          String(r.provider ?? 'unknown'),
          String(r.model ?? 'unknown'),
          toInt(r.requests),
          toInt(r.input_tokens), toInt(r.output_tokens),
          toInt(r.cache_read_tokens), toInt(r.cache_write_tokens),
          toInt(r.cost_usd_nano), toInt(r.unpriced_requests),
          toInt(r.ttft_sum_ms), toInt(r.ttft_count),
        );
        result.rollupDays += 1;
      }
    });

    store.recordSyncLog({
      source: 'dsh-logs', kind: 'file-import', startedAt,
      finishedAt: Date.now(), status: result.errors.length ? 'partial' : 'ok',
      imported: result.imported, skipped: result.skipped,
      skippedUnknownApp: 0, watermark: null, filesScanned: 1, errors: result.errors,
    });
  } catch (error) {
    result.errors.push(error.message);
    store.recordSyncLog({
      source: 'dsh-logs', kind: 'file-import', startedAt,
      finishedAt: Date.now(), status: 'failed',
      imported: result.imported, skipped: result.skipped,
      skippedUnknownApp: 0, watermark: null, filesScanned: 1, errors: [error.message],
    });
    logger?.warn?.(`token-monitor: DSH 导入失败：${error.message}`);
  }

  return result;
}

/** 导出文件默认文件名（带本地时间戳，方便区分多次导出）。 */
export function exportFileName(now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `token-monitor-dsh-export-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.json`;
}
