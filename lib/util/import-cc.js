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
import { normalizeProvider } from './fold.js';

/** 只接受这些 app_type；新类型（如 dsh）默认跳过。 */
const APP_WHITELIST = new Set(['claude', 'claude-desktop', 'codex', 'gemini', 'opencode', 'grokbuild', 'pi']);
/**
 * 显式排除的应用：CC 未来支持 DSH 请求统计后，DSH 的日志本插件已自扫入库（source='dsh-logs'），
 * 若 CC 导入也带入 dsh 记录会与自扫数据双算，因此无论白名单如何都排除。
 */
const EXCLUDED_APPS = new Set(['dsh']);
/** input_tokens 含缓存的应用（CC sql_helpers.rs 的 CACHE_INCLUSIVE_APP_TYPES）。 */
const CACHE_INCLUSIVE_APPS = new Set(['codex', 'gemini', 'grokbuild']);

/**
 * 已知模型 → 真实供应商映射（先于 pi-ai 反查，未知模型再走 providerOf）。
 * 收录规则：CC 实际出现且归属确定的模型全部显式钉死——
 * ① kimi 旧系列（k2.5/k2.6/k2.7 等）只出现在 Claude Code 会话里（经 CC 路由到
 *    Kimi For Coding），而 pi-ai 目录的同名模型可能被其他接入商（Copilot/Moonshot）
 *    先收录——"先见先得"反查会误判，必须钉死；
 * ② k3/deepseek 等 pi-ai 反查虽正确，但一并收录可摆脱对目录收录顺序的依赖。
 * 只有真正未知的模型才走反查（仍查不到标 'unknown' 待人工核对）。
 */
const CC_MODEL_PROVIDER_OVERRIDE = {
  // Kimi For Coding
  'kimi-k2.5': 'kimi-coding',
  'kimi-k2.6': 'kimi-coding',
  'kimi-k2.7-code': 'kimi-coding',
  'kimi-k2.7-code-highspeed': 'kimi-coding',
  'kimi-k2.7': 'kimi-coding',
  'kimi-k2-thinking': 'kimi-coding',
  'kimi-k3': 'kimi-coding',
  'kimi-for-coding': 'kimi-coding',
  'kimi-for-coding-highspeed': 'kimi-coding',
  'k3': 'kimi-coding',
  'k3-256k': 'kimi-coding',
  // DeepSeek
  'deepseek-v4-pro': 'deepseek',
  'deepseek-v4-flash': 'deepseek',
};

/** _session / _codex_session / _opencode_session 记录的真实供应商：显式映射 → pi-ai 反查 → 'unknown'。
 *  反查失败不落 'cc-switch' 兜底（那会伪装成供应商名）；标"未知"让用户人工核对
 *  模型实际归属，核对后补进映射（或重导）刷新即可。
 *  注：opencode 是客户端（app_type='opencode'），其 provider_id='_opencode_session'，
 *  供应商按模型反查归真实供应商（deepseek/kimi…），不当作独立供应商。 */
function resolveSessionProvider(pricing, model) {
  return CC_MODEL_PROVIDER_OVERRIDE[model]
    || (pricing && pricing.providerOf && pricing.providerOf(model))
    || 'unknown';
}

/** CC 的 provider 实例 id（UUID 形态，如 0c1712c0-…，非 _session 会话日志标记）：
 *  本质是某供应商的配置实例，模型名可反查真实供应商（deepseek/kimi…），
 *  不能原样落库成 UUID（供应商维度会分裂脏值）。 */
function isUuidProvider(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

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
      if (row.provider_id === '_session' || row.provider_id === '_codex_session'
        || row.provider_id === '_opencode_session' || isUuidProvider(row.provider_id)) {
        // 会话日志来源或 CC provider 实例（UUID）：已知映射优先（kimi 旧系列），
        // 未知走 pi-ai 反查，查不到落兜底——UUID 实例本质是某供应商，按模型归真实供应商
        provider = resolveSessionProvider(pricing, row.model);
      } else {
        // 非 _session 的真实 provider_id 也要归一化（deepseek-official → deepseek），
        // 否则与 _session 反查出的 deepseek 会因命名不同分裂成两行
        provider = normalizeProvider(row.provider_id) || 'unknown';
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


/**
 * CC 历史聚合（usage_daily_rollups）迁移：把 CC 的按天聚合行以"覆盖"语义
 * upsert 进我们的 usage_daily_rollups（source='cc-switch'）。
 *
 * - 增量：kind='db-rollup' 独立水位（date > 上次 MAX(date)），首次无水位 = 全量。
 *   与 db-scan（明细 created_at 毫秒水位）同源不同 kind，互不污染。
 * - 覆盖而非累加：CC rollup 行是"那天已完成聚合"的定格值；同 key 有则覆盖、
 *   无则新增——重复同步 / 明细老化窗口均无副作用（对比明细镜像的累加 upsert）。
 * - 先聚合再写：CC 主键含 provider_id/request_model/pricing_model，我们的主键是
 *   (day, source, client, provider, model)——同一目标 key 可能来自 CC 多行
 *   （如 (date, claude, _session, k3) 与 (date, claude, kimi-coding, k3) 都映射到
 *   (day, claude, kimi-coding, k3)），先按目标 key SUM 合并再写入，防覆盖丢数据。
 * - provider 反查：provider_id 为 _session / _codex_session（CC 会话日志来源标记）
 *   时按模型反查 pi-ai 目录推断真实供应商（deepseek-v4-pro → deepseek）；
 *   其余 provider_id 走 normalizeProvider 归一化（deepseek-official → deepseek）。
 * - client = CC 的 app_type 原样搬（2026-08-20 起 rollup 主键纳入 client 维度）。
 * - 口径直搬（接受 CC 语义）：request_count 为 CC 全量计数（含失败请求）；
 *   total_cost_usd 搬值不重算；input_tokens 已是 CC fresh 口径（聚合时归一）；
 *   avg_latency_ms 是总延迟均值（≠我们的 TTFT），>0 时折算进 ttft 累加器，=0 不迁。
 *
 * @returns {{ importedDays: number, errors: string[] }}
 */
export function importCcRollups(store, cc, pricing) {
  const result = { importedDays: 0, errors: [] };
  const wm = store.getLastSyncWatermark('cc-switch', 'db-rollup');
  const dateFrom = wm ? dayOf(wm) : null; // 水位毫秒 → 本地日期；null = 全量
  const baseSql = `
    SELECT date, app_type, provider_id, model, request_count,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           total_cost_usd, avg_latency_ms
    FROM usage_daily_rollups
  `;
  const rows = dateFrom
    ? cc.prepare(`${baseSql} WHERE date > ?`).all(dateFrom)
    : cc.prepare(baseSql).all();

  if (!rows.length) return result;

  // 先按目标 key (day, client, provider, model) 聚合：CC 的 provider_id /
  // request_model / pricing_model 维度比我们的主键多，同一目标 key 可能来自多行
  const groups = new Map();
  const keyOf = (day, client, provider, model) => `${day}\u0000${client}\u0000${provider}\u0000${model}`;
  for (const r of rows) {
    let provider;
    if (r.provider_id === '_session' || r.provider_id === '_codex_session'
      || r.provider_id === '_opencode_session' || isUuidProvider(r.provider_id)) {
      // 会话日志来源或 CC provider 实例（UUID）：已知映射优先，未知走 pi-ai 反查，
      // 查不到落兜底——UUID 实例本质是某供应商，按模型归真实供应商
      provider = resolveSessionProvider(pricing, r.model);
    } else {
      provider = normalizeProvider(r.provider_id) || 'unknown';
    }
    const client = r.app_type || 'unknown';
    const model = r.model || 'unknown';
    const rc = Number(r.request_count) || 0;
    const avg = Number(r.avg_latency_ms) || 0;
    const key = keyOf(r.date, client, provider, model);
    let g = groups.get(key);
    if (!g) {
      g = {
        day: r.date, client, provider, model,
        requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        costNano: 0, ttftSum: 0, ttftCount: 0,
      };
      groups.set(key, g);
    }
    g.requests += rc;
    g.input += Number(r.input_tokens) || 0;
    g.output += Number(r.output_tokens) || 0;
    g.cacheRead += Number(r.cache_read_tokens) || 0;
    g.cacheWrite += Number(r.cache_creation_tokens) || 0;
    g.costNano += decimalToNano(r.total_cost_usd);
    if (avg > 0) {
      // 加权合并（不同 provider_id 变体可能各自有延迟均值）
      g.ttftSum += Math.round(avg * rc);
      g.ttftCount += rc;
    }
  }

  let maxDate = null;
  store.transaction(() => {
    for (const g of groups.values()) {
      store.putRollupReplace({
        day: g.day,
        source: 'cc-switch',
        client: g.client,
        provider: g.provider,
        model: g.model,
        requests: g.requests,
        input: g.input,
        output: g.output,
        cacheRead: g.cacheRead,
        cacheWrite: g.cacheWrite,
        costNano: g.costNano,
        unpriced: 0, // CC 行均有 total_cost_usd，视为已定价
        ttftSum: g.ttftSum,
        ttftCount: g.ttftCount,
      });
      result.importedDays += 1;
      if (!maxDate || g.day > maxDate) maxDate = g.day;
    }
  });

  // 审计 + 水位推进（watermark = 本次最大 date 的本地午夜毫秒，getLastSyncWatermark 按 kind 过滤）
  const startedAt = Date.now();
  store.recordSyncLog({
    source: 'cc-switch', kind: 'db-rollup', startedAt,
    finishedAt: Date.now(), status: result.errors.length ? 'partial' : 'ok',
    imported: result.importedDays, // 语义为"迁移的天数"，审计用
    skipped: 0, skippedUnknownApp: 0,
    watermark: maxDate ? Date.parse(`${maxDate}T00:00:00`) : null,
    filesScanned: 0, errors: result.errors,
  });
  return result;
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

    // CC 历史聚合（usage_daily_rollups）迁移：独立失败不影响明细结果
    // （聚合行走 db-rollup 水位 + 覆盖 upsert，见 importCcRollups）
    try {
      const rollup = importCcRollups(store, cc, pricing);
      result.rollupDays = rollup.importedDays;
      if (rollup.errors.length > 0) {
        result.errors.push(...rollup.errors.map((e) => `rollup 迁移：${e}`));
      }
    } catch (error) {
      result.rollupDays = 0;
      result.errors.push(`rollup 迁移失败：${error.message}`);
      store.recordSyncLog({
        source: 'cc-switch', kind: 'db-rollup', startedAt: Date.now(),
        finishedAt: Date.now(), status: 'failed',
        imported: 0, skipped: 0, skippedUnknownApp: 0,
        watermark: null, filesScanned: 0, errors: [error.message],
      });
    }
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
