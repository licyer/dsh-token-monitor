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
 * 已导入集合从本库 usage_requests(source='cc-switch') 读出（内存 Set，数据量小）。
 * @returns {Array} SyncSource 形状：[]（无 pending）或 [{ source, label, pending }]；库打不开时带 error。
 */
export function checkCcPending(store, ccDbPath) {
  if (!fs.existsSync(ccDbPath)) return [];
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
    const rows = cc.prepare('SELECT request_id FROM proxy_request_logs').all();
    cc.close();
    const pending = rows.filter((r) => !imported.has(r.request_id)).length;
    return pending > 0 ? [{ source: 'cc-switch', label: 'cc-switch', pending }] : [];
  } catch (error) {
    cc.close();
    return [{ source: 'cc-switch', label: 'cc-switch', pending: null, error: error.message }];
  }
}

/**
 * 导入 CC-switch 历史。
 * @param {object} [pricing] 可选；提供 providerOf(model) 用于 _session 记录的供应商反查。
 * @returns {{ imported, skipped, skippedUnknownApp, filesScanned, errors } | { error: string }}
 */
export function importCcSwitch(store, ccDbPath, logger, pricing) {
  if (!fs.existsSync(ccDbPath)) {
    return { error: `未找到 cc-switch 数据库：${ccDbPath}` };
  }
  const result = { imported: 0, skipped: 0, skippedUnknownApp: 0, filesScanned: 1, errors: [] };

  let cc;
  try {
    cc = new (getDatabaseSync())(ccDbPath, { readOnly: true });
  } catch (error) {
    return { error: `打开 cc-switch 数据库失败：${error.message}` };
  }

  try {
    const rows = cc.prepare(`
      SELECT request_id, app_type, provider_id, model, session_id,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             input_token_semantics, total_cost_usd, first_token_ms, created_at
      FROM proxy_request_logs
    `).all();

    store.transaction(() => {
      for (const row of rows) {
        // 显式排除应用（如 dsh：本插件已自扫入库，避免双算），即使未来进了白名单也跳过
        if (EXCLUDED_APPS.has(row.app_type)) {
          result.skippedUnknownApp += 1;
          continue;
        }
        if (!APP_WHITELIST.has(row.app_type)) {
          result.skippedUnknownApp += 1;
          continue;
        }
        const createdAt = (row.created_at || 0) * 1000; // 秒 → 毫秒
        // 供应商归属：_session 模式日志不含真实供应商，用模型名反查 pi-ai 目录推断
        // （deepseek-v4-pro → deepseek、k3 → kimi-coding），查不到才兜底 cc-switch。
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
          output: row.output_tokens || 0,
          cacheRead: row.cache_read_tokens || 0,
          cacheWrite: row.cache_creation_tokens || 0,
          costNano: decimalToNano(row.total_cost_usd),
          ttftMs: row.first_token_ms ?? null,
          day: dayOf(createdAt),
          createdAt,
        });
        if (isNew) result.imported += 1;
        else result.skipped += 1;
      }
    });
  } catch (error) {
    result.errors.push(error.message);
    logger?.warn?.(`token-monitor: CC 导入失败：${error.message}`);
  } finally {
    cc.close();
  }

  return result;
}
