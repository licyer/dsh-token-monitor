/**
 * CC-switch 历史导入器：只读打开 cc-switch.db，把 proxy_request_logs 映射进
 * usage_requests（rollup 由 store.recordUsage 联动 upsert）。
 *
 * - app_type 白名单默认拒绝：未知类型（如 CC 将来支持 DSH）整行跳过，防双算。
 * - 输入口径归一：按 CC 的 input_token_semantics 规则（其 sql_helpers.rs 的
 *   fresh_input_sql）把 input_tokens 统一为"未缓存输入"。
 * - 幂等：record_id = CC 的 request_id，INSERT OR IGNORE；重复导入无副作用。
 */

import fs from 'node:fs';
import { dayOf, getDatabaseSync } from './store.js';

/** 只接受这些 app_type；新类型（如 dsh）默认跳过。 */
const APP_WHITELIST = new Set(['claude', 'claude-desktop', 'codex', 'gemini', 'opencode', 'grokbuild', 'pi']);
/**
 * 显式排除的应用：CC 未来支持 DSH 请求统计后，DSH 的日志本插件已自扫入库（source='dsh-logs'），
 * 若 CC 导入也带入 dsh 记录会与自扫数据双算，因此无论白名单如何都排除。
 */
const EXCLUDED_APPS = new Set(['dsh']);
/** input_tokens 含缓存的应用（CC sql_helpers.rs 的 CACHE_INCLUSIVE_APP_TYPES）。 */
const CACHE_INCLUSIVE_APPS = new Set(['codex', 'gemini', 'grokbuild']);

const SEMANTICS_LEGACY = 0;
const SEMANTICS_TOTAL = 1;
const SEMANTICS_FRESH = 2;

/** 十进制字符串（如 '0.000817162'）→ 纳美元整数；9 位小数内精确。 */
export function decimalToNano(text) {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ''] = body.split('.');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return 0;
  const intNano = Number(intPart || '0') * 1e9;
  const fracNano = Number((fracPart + '000000000').slice(0, 9) || '0');
  return (neg ? -1 : 1) * (intNano + fracNano);
}

/** CC 的 input_tokens → 未缓存输入（fresh 语义），对应 fresh_input_sql。 */
function freshInput(row) {
  const input = row.input_tokens || 0;
  const cacheRead = row.cache_read_tokens || 0;
  const cacheWrite = row.cache_creation_tokens || 0;
  const semantics = row.input_token_semantics ?? SEMANTICS_LEGACY;
  if (semantics === SEMANTICS_FRESH) return input;
  if (CACHE_INCLUSIVE_APPS.has(row.app_type)) {
    if (semantics === SEMANTICS_TOTAL && input >= cacheRead + cacheWrite) return input - cacheRead - cacheWrite;
    if (semantics === SEMANTICS_LEGACY && input >= cacheRead) return input - cacheRead;
  }
  return input;
}

/**
 * 轻量探测 CC-switch 是否有未同步记录（DESIGN §11.3 check()）：不读全量、不导入。
 * 增量探测：以 sync_logs 中该源最近一次成功同步的 watermark（created_at 毫秒）为起点，
 * 只统计该时间点之后的记录；无水位记录则全量。已导入集合用 record_id 比对（幂等双保险）。
 * @returns {Array} SyncSource 形状：[]（无 pending）或 [{ source, label, pending }]；库打不开时带 error。
 */
export function checkCcPending(store, ccDbPath) {
  if (!fs.existsSync(ccDbPath)) return [];
  const watermark = store.getLastSyncWatermark('cc-switch', 'db-scan');
  const imported = new Set(
    store.db.prepare("SELECT record_id FROM usage_requests WHERE source = 'cc-switch'").all()
      .map((r) => r.record_id),
  );
  let cc;
  try {
    cc = new (getDatabaseSync())(ccDbPath, { readOnly: true });
  } catch (error) {
    return [{ source: 'cc-switch', label: 'cc-switch', pending: null, error: `无法打开 cc-switch 数据库：${error.message}` }];
  }
  try {
    // 装了但从未使用：库是新的，无 proxy_request_logs 表 → 视为无数据可同步，不报错
    const hasTable = cc.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proxy_request_logs'").get();
    if (!hasTable) {
      cc.close();
      return [];
    }
    // 只取水位之后的行（毫秒比较；CC created_at 秒级 ×1000 后与水位同单位）
    const rows = watermark
      ? cc.prepare('SELECT request_id FROM proxy_request_logs WHERE created_at * 1000 > ?').all(watermark)
      : cc.prepare('SELECT request_id FROM proxy_request_logs').all();
    cc.close();
    const pending = rows.filter((r) => !imported.has(r.request_id)).length;
    return pending > 0 ? [{ source: 'cc-switch', label: 'cc-switch', pending }] : [];
  } catch (error) {
    cc.close();
    return [{ source: 'cc-switch', label: 'cc-switch', pending: null, error: error.message }];
  }
}

/**
 * 解析 CC 导出的 SQL 文件（sqlite3 .dump 文本格式），提取 `proxy_request_logs` 表的 INSERT 行。
 * 逐行扫描、宽容匹配：
 *   第一步：先判断是否为 INSERT INTO 语句（大小写不敏感，insert/into 间任意空白）；
 *   第二步：提取表名（可带引号可不带、大小写任意），只保留 proxy_request_logs；
 *   第三步：解析该行的 VALUES 列表（引号感知逗号切分）。
 * 返回值：rows 数组（每项为 { [列名]: 值 }，列名小写、值去引号）；格式异常的行跳过。
 */
export function parseCcSqlFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const rows = [];
  let pending = null; // 跨行 INSERT 收集（抗 CC 未来格式变化：值内换行/多行 VALUES）

  const insertRe = /^insert\s+into\s+["']?([A-Za-z0-9_]+)["']?\s*\(/i;
  const valuesRe = /\)\s*values\s*\((.*)\)\s*;?\s*$/is;

  for (const line of lines) {
    const t = line.trim();
    // 跨行收集模式：非 INSERT 开头的行拼到 pending 尾部
    if (pending) {
      pending += '\n' + t;
      if (valuesRe.test(pending)) { rows.push(parseInsertLine(pending)); pending = null; }
      continue;
    }
    // 第一步：先判断是不是 INSERT INTO（大小写不敏感）
    if (!/^insert\s+into\b/i.test(t)) continue;
    // 第二步：提取表名，只保留 proxy_request_logs
    const m = t.match(insertRe);
    if (!m) continue;
    if (m[1].toLowerCase() !== 'proxy_request_logs') continue;
    // 第三步：VALUES 是否在本行完整
    if (valuesRe.test(t)) {
      rows.push(parseInsertLine(t));
    } else {
      pending = t; // 跨行，进入收集模式
    }
  }

  return rows;
}

/** 解析一条完整的 proxy_request_logs INSERT 行 → 列名小写的对象。 */
function parseInsertLine(line) {
  // 列清单：INSERT INTO "t" ("c1", "c2", ...) VALUES (...);
  const colMatch = line.match(/^\s*insert\s+into\s+["']?[A-Za-z0-9_]+["']?\s*\(([^)]*)\)\s*values\s*\((.*)\)\s*;?\s*$/is);
  if (!colMatch) return null;
  const cols = colMatch[1].split(',').map((c) => c.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const raw = splitSqlValues(colMatch[2]);
  const row = {};
  for (let i = 0; i < cols.length; i++) {
    row[cols[i]] = raw[i] === undefined ? null : unquoteSql(raw[i]);
  }
  return row;
}

/** 引号感知逗号切分：忽略单引号字符串内部的逗号（'a,b' 不当分隔符）。 */
function splitSqlValues(s) {
  const parts = [];
  let cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        // 转义：'' 是 SQL 里单引号的转义写法，连续两个不结束字符串
        if (s[i + 1] === "'") { cur += s[i + 1]; i++; }
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** SQL 字面量 → JS 值：NULL → null；'...' → 去引号（含 '' 转义还原）；数字原样。 */
function unquoteSql(v) {
  const s = v.trim();
  if (s === 'NULL' || s === '') return null;
  if (s.startsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * 公共行导入（db 查询行与 sql 文件解析行共用）：白名单过滤、供应商反查、口径归一、入库。
 * rows: [{ request_id, app_type, provider_id, model, session_id, input_tokens,
 *          output_tokens, cache_read_tokens, cache_creation_tokens,
 *          input_token_semantics, total_cost_usd, first_token_ms, created_at }]
 * 就地累加 result.imported / skipped / skippedUnknownApp。
 */
function importRows(store, rows, result, pricing) {
  store.transaction(() => {
    for (const row of rows) {
      if (EXCLUDED_APPS.has(row.app_type)) {
        result.skippedUnknownApp += 1;
        continue;
      }
      if (!APP_WHITELIST.has(row.app_type)) {
        result.skippedUnknownApp += 1;
        continue;
      }
      const createdAt = (Number(row.created_at) || 0) * 1000; // 秒 → 毫秒
      let provider;
      if (row.provider_id === '_session') {
        provider = (pricing && pricing.providerOf && pricing.providerOf(row.model)) || 'cc-switch';
      } else {
        provider = row.provider_id || 'unknown';
      }
      const isNew = store.recordUsage({
        recordId: row.request_id,
        source: 'cc-switch',
        client: row.app_type,
        provider,
        model: row.model || 'unknown',
        sessionId: row.session_id ?? null,
        input: freshInput(row),
        output: Number(row.output_tokens) || 0,
        cacheRead: Number(row.cache_read_tokens) || 0,
        cacheWrite: Number(row.cache_creation_tokens) || 0,
        costNano: decimalToNano(row.total_cost_usd),
        ttftMs: row.first_token_ms === null || row.first_token_ms === undefined ? null : Number(row.first_token_ms),
        day: dayOf(createdAt),
        createdAt,
      });
      // 统计口径（2026-08-20）：只报 imported 与 skippedUnknownApp；
      // 已导入的重复行（主键冲突）静默跳过，不进 skipped（前端不展示，避免误导）
      if (isNew) result.imported += 1;
      else result.skipped += 1;
    }
  });
}


export function importCcSwitch(store, ccDbPath, logger, pricing) {
  if (!fs.existsSync(ccDbPath)) {
    return { error: `未找到 cc-switch 数据库：${ccDbPath}` };
  }
  const result = { imported: 0, skipped: 0, skippedUnknownApp: 0, filesScanned: 1, errors: [] };
  const startedAt = Date.now();
  // 增量起点：该源上次 db-scan 同步的水位（毫秒）；无记录 = 全量
  const watermark = store.getLastSyncWatermark('cc-switch', 'db-scan');

  let cc;
  try {
    cc = new (getDatabaseSync())(ccDbPath, { readOnly: true });
  } catch (error) {
    return { error: `打开 cc-switch 数据库失败：${error.message}` };
  }

  try {
    const baseSql = `
      SELECT request_id, app_type, provider_id, model, session_id,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             input_token_semantics, total_cost_usd, first_token_ms, created_at
      FROM proxy_request_logs
    `;
    const rows = watermark
      ? cc.prepare(baseSql + ' WHERE created_at * 1000 > ?').all(watermark)
      : cc.prepare(baseSql).all();

    importRows(store, rows, result, pricing);
    // 水位 = 本次读取行中的最大 created_at（毫秒）；有增量读取才推进，避免空跑覆盖水位
    let nextWatermark = watermark;
    for (const row of rows) {
      const ms = (Number(row.created_at) || 0) * 1000;
      if (nextWatermark === null || ms > nextWatermark) nextWatermark = ms;
    }
    if (nextWatermark === null && rows.length > 0) nextWatermark = 0;
    store.recordSyncLog({
      source: 'cc-switch',
      kind: 'db-scan',
      startedAt,
      finishedAt: Date.now(),
      status: result.errors.length ? 'partial' : 'ok',
      imported: result.imported,
      skipped: result.skipped,
      skippedUnknownApp: result.skippedUnknownApp,
      watermark: nextWatermark,
      filesScanned: result.filesScanned,
      errors: result.errors,
    });
  } catch (error) {
    result.errors.push(error.message);
    store.recordSyncLog({
      source: 'cc-switch', kind: 'db-scan', startedAt,
      finishedAt: Date.now(), status: 'failed',
      imported: result.imported, skipped: result.skipped,
      skippedUnknownApp: result.skippedUnknownApp,
      watermark: null, filesScanned: result.filesScanned, errors: [error.message],
    });
    logger?.warn?.(`token-monitor: CC 导入失败：${error.message}`);
  } finally {
    cc.close();
  }

  return result;
}

/**
 * 从 CC 导出的 SQL 文件导入请求记录（§2.2 用量页"导入"入口，跨设备手动导入）。
 * 解析 proxy_request_logs 表的所有 INSERT，字段映射与 db 导入一致（importRows 共用）。
 * 文件导入是全量语义（用户主动选文件，不做增量水位——文件本身是快照）。
 * @param {object} [pricing] 可选；提供 providerOf(model) 用于 _session 记录的供应商反查。
 * @returns {{ imported, skipped, skippedUnknownApp, filesScanned, errors } | { error: string }}
 */
export function importCcSqlFile(store, filePath, logger, pricing) {
  if (!fs.existsSync(filePath)) {
    return { error: `未找到 CC 导出文件：${filePath}` };
  }
  const result = { imported: 0, skipped: 0, skippedUnknownApp: 0, filesScanned: 1, errors: [] };
  const startedAt = Date.now();
  try {
    const rows = parseCcSqlFile(filePath).filter(Boolean);
    importRows(store, rows, result, pricing);
    // sql-import 是全量快照导入：无水位语义（SQL 文件无法确认是否同机，按 record_id 幂等去重即可）。
    // 审计行 watermark 置 null，不参与 db-scan 增量探测（getLastSyncWatermark 按 kind 过滤）。
    store.recordSyncLog({
      source: 'cc-switch', kind: 'sql-import', startedAt,
      finishedAt: Date.now(),
      status: result.errors.length ? 'partial' : 'ok',
      imported: result.imported, skipped: result.skipped,
      skippedUnknownApp: result.skippedUnknownApp,
      watermark: null,
      filesScanned: result.filesScanned,
      errors: result.errors,
    });
  } catch (error) {
    result.errors.push(error.message);
    store.recordSyncLog({
      source: 'cc-switch', kind: 'sql-import', startedAt,
      finishedAt: Date.now(), status: 'failed',
      imported: result.imported, skipped: result.skipped,
      skippedUnknownApp: result.skippedUnknownApp,
      watermark: null, filesScanned: result.filesScanned, errors: [error.message],
    });
    logger?.warn?.(`token-monitor: CC SQL 文件导入失败：${error.message}`);
  }
  return result;
}
