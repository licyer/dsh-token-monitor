/**
 * 定价模块（统一价格入口，对应 docs/模型定价表设计.md §4）。
 *
 * 一个入口拿价格，内部处理"从哪里来"：
 *   1. `model_prices` 价格表（用户维护/未来设置页写入；按 model + 请求时间命中版本与错峰窗口）
 *   2. 内置 DeepSeek 官方价（CNY + 高峰窗口，随本模块分发，开箱即用）
 *   3. pi-ai 本地刊例目录（USD flat，兜底）
 *   4. 都没有 → null（调用方按"未定价/unpriced"处理）
 *
 * 币种折算：USD 直接进入 cost_usd_nano；CNY（内置 DeepSeek）按调用方提供的汇率
 * （getUsdCnyRate）折算后固化——写行当时汇率近似现值。
 *
 * 定点方案：价格量化到"万分之一币种单位/百万 token"（P4 整数），
 * 单次费用 cost_nano = round(tokens × P4 / 10)，单位 1e-9 美元。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { VALID_UNTIL_OPEN } from './store.js';

/** P4 定点换算：$/M 或 元/M → ×1e4 取整。 */
function toP4(v) {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? Math.round(n * 1e4) : null;
}

/** 元（或美元）/百万 token → P4 定点（对外录入用）。 */
export function yuanToP4(v) {
  return toP4(v);
}

/** P4 定点 → 元（或美元）/百万 token（对外展示用）。 */
export function p4ToYuan(p) {
  const n = Number(p);
  return isFinite(n) ? n / 1e4 : null;
}

/* ------------------------- 本地时间与高峰窗口工具 ------------------------- */

/** 本地时间（时区 tz）的日历字段与分钟数。 */
function localTime(ts, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ts))) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const minute = Number(parts.minute) || 0;
  const y = Number(parts.year); const m = Number(parts.month); const d = Number(parts.day);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日 … 6=周六
  return { weekday, minutes: Number(hour) * 60 + minute };
}

/** days 规则匹配：'*' 每天；'1-5' 周一~五；'6,7' 周末。 */
function dayMatches(pattern, weekday) {
  if (!pattern || pattern === '*') return true;
  return pattern.split(',').some((seg) => {
    if (seg.includes('-')) {
      const [a, b] = seg.split('-').map(Number);
      return weekday >= a && weekday <= b;
    }
    return Number(seg) === weekday;
  });
}

function minuteOf(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 按请求时刻命中高峰窗口并乘模型级倍率（peak_multiplier，缺省 2；结果四舍五入回整，防浮点）；未命中返回原价。 */
function applyPeak(ruleJson, multiplier, base, ts) {
  if (!ruleJson || !base) return base;
  let rule;
  try { rule = JSON.parse(ruleJson); } catch { return base; }
  if (!rule || !Array.isArray(rule.windows)) return base;
  const k = Number(multiplier);
  const m = isFinite(k) && k > 0 ? k : 2;
  const keep = (v) => ({ ...base, input: v.input, output: v.output, cacheRead: v.cacheRead, cacheWrite: v.cacheWrite });
  const local = localTime(ts, rule.timezone || 'Asia/Shanghai');
  for (const w of rule.windows) {
    if (dayMatches(w.days, local.weekday)
      && minuteOf(w.start) <= local.minutes && local.minutes < minuteOf(w.end)) {
      return keep({
        input: Math.round(base.input * m), output: Math.round(base.output * m),
        cacheRead: Math.round(base.cacheRead * m), cacheWrite: Math.round(base.cacheWrite * m),
      });
    }
  }
  return base;
}

/** 行/常量 → 统一价格对象（兼容表行键 input_cache_hit_price… 与常量 camel 键 cacheHitInput…）。 */
function toPrice(row) {
  const num = (a, b) => (a !== undefined && a !== null ? a : (b !== undefined && b !== null ? b : 0));
  return {
    mode: row.mode || 'fixed',
    currency: row.currency || 'USD',
    input: num(row.input, row.input_price),
    output: num(row.output, row.output_price),
    cacheRead: num(row.cacheHitInput, row.input_cache_hit_price),
    cacheWrite: num(row.cacheCreate, row.cache_create_price),
  };
}

/* ------------------------- 内置 DeepSeek 官方价 ------------------------- */

/** 高峰窗口规则生成（工作日 09–12、14–18；周末/其余时间即低谷价）。窗口只描述时段，倍率是模型级 peak_multiplier。 */
function peakWindows() {
  return JSON.stringify({
    timezone: 'Asia/Shanghai',
    windows: [
      { days: '1-5', start: '09:00', end: '12:00' },
      { days: '1-5', start: '14:00', end: '18:00' },
    ],
  });
}

/**
 * 内置 DeepSeek 价格规则（元 / 百万 token，CNY，峰谷；工作日 09–12、14–18 高峰 ×2，其余按基础价）。
 * 每 model 可含多段（startTime → endTime；'open' 持续有效）：
 *  - flash 系列（含 vision-exp）：2026-08-17/08-21 起 0.05/1.5/4.5；2026-09-10 12:00（北京）官方调价起 0.02/1/4
 *  - pro：2026-08-13 起 0.15/4.5/13.5
 * 同时内置"当前档 + 已公布即将生效档"：取价按请求时间命中对应段，
 * 保证调价时点（9/10 12:00）之前的请求仍按旧价计费。调价只改这里，seedModelPrices 一次写入全部分段。
 */
const BUILTIN_CNY = [
  { model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash',
    cacheHitInput: 0.05, input: 1.5, output: 4.5,
    startTime: Date.parse('2026-08-17T00:00:00+08:00'), endTime: Date.parse('2026-09-10T12:00:00+08:00') },
  { model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash',
    cacheHitInput: 0.02, input: 1, output: 4,
    startTime: Date.parse('2026-09-10T12:00:00+08:00'), endTime: 'open' },
  { model: 'deepseek-v4-flash-vision-exp', displayName: 'DeepSeek V4 Flash Vision Exp',
    cacheHitInput: 0.05, input: 1.5, output: 4.5,
    startTime: Date.parse('2026-08-21T00:00:00+08:00'), endTime: Date.parse('2026-09-10T12:00:00+08:00') },
  { model: 'deepseek-v4-flash-vision-exp', displayName: 'DeepSeek V4 Flash Vision Exp',
    cacheHitInput: 0.02, input: 1, output: 4,
    startTime: Date.parse('2026-09-10T12:00:00+08:00'), endTime: 'open' },
  { model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro',
    cacheHitInput: 0.15, input: 4.5, output: 13.5,
    startTime: Date.parse('2026-08-13T00:00:00+08:00'), endTime: 'open' },
  // V4.1 Flash（返回模型键 deepseek-flash）：按官方 flash 系列公告价（空闲 0.02/1/4，高峰 ×2）；
  // 生效起点与 9/10 12:00 flash 调价同刻，键上线（下周）时已在生效期，无需再改。
  { model: 'deepseek-flash', displayName: 'DeepSeek Flash',
    cacheHitInput: 0.02, input: 1, output: 4,
    startTime: Date.parse('2026-09-10T12:00:00+08:00'), endTime: 'open' },
].map((b) => ({
  model: b.model, displayName: b.displayName, mode: 'time', currency: 'CNY',
  input: toP4(b.input), output: toP4(b.output),
  cacheHitInput: toP4(b.cacheHitInput), cacheCreate: 0,
  startTime: b.startTime,
  endTime: b.endTime === 'open' ? VALID_UNTIL_OPEN : b.endTime,
  peakMultiplier: b.peakMultiplier ?? 2,
  peakWindows: peakWindows(),
}));

/**
 * 内置价初始化：仅当 model_prices 表【为空】（首次建表后）把 BUILTIN_CNY 写入表。
 * 表非空即跳过（幂等），绝不覆盖用户后续维护的行。写行带 source='builtin'（随包基线标记，
 * 供 syncBuiltinPrices 区分"官方基线行"与"用户自定义行"）。
 * 同 model 可有多行分段（UNIQUE(model, start_time)）：旧档结束时间=新档开始时间，取价无缝衔接。
 * @param {DatabaseSync} db 插件主库（含 model_prices 表）
 * @param {object} logger 可选
 * @returns {object} { seeded, reason?, rows? }
 */
export function seedModelPrices(db, logger) {
  const log = logger || { info() {}, warn() {} };
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_prices'").get();
    if (!exists) {
      log.warn?.('token-monitor: model_prices 表不存在，跳过内置价初始化');
      return { seeded: false, reason: 'no-table' };
    }
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM model_prices').get();
    if (c > 0) return { seeded: false, reason: 'not-empty', rows: c };

    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO model_prices
        (model, display_name, mode, currency,
         input_cache_hit_price, input_price, output_price, cache_create_price,
         start_time, end_time, source, created_at, peak_multiplier, peak_windows)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    for (const b of BUILTIN_CNY) {
      insert.run(b.model, b.displayName, b.mode, b.currency,
        b.cacheHitInput, b.input, b.output, b.cacheCreate,
        b.startTime, b.endTime, 'builtin', now, b.peakMultiplier, b.peakWindows);
    }
    db.exec('COMMIT');
    log.info?.(`token-monitor: 内置 DeepSeek 价已初始化（${BUILTIN_CNY.length} 行分段，CNY 峰谷，含已公布即将生效档）`);
    return { seeded: true, rows: BUILTIN_CNY.length };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    log.warn?.(`token-monitor: 内置价初始化失败：${String((error && error.message) || error)}`);
    return { seeded: false, reason: 'error', error: String(error) };
  }
}

/** 内置段与库内行逐字段是否相等（legacy 认领用；容忍 null 与未设默认的差异）。 */
function builtinRowEqual(r, b) {
  return r.start_time === b.startTime
    && r.end_time === b.endTime
    && r.input_cache_hit_price === b.cacheHitInput
    && r.input_price === b.input
    && r.output_price === b.output
    && r.cache_create_price === (b.cacheCreate || 0)
    && r.peak_multiplier === (b.peakMultiplier == null ? null : b.peakMultiplier)
    && (r.peak_windows || null) === (b.peakWindows || null);
}

/**
 * 内置价同步（把 BUILTIN_CNY 基线应用到【已有库】，幂等、尊重用户自定义）。
 * 规则（对每个内置涉及的 model）：
 *   1. legacy 认领：库里与内置段逐字段一致的 source='custom' 行 → 升级为 'builtin'
 *      （历史库由旧 seed 写的是 custom，只有值完全相同才算"没被用户改过"）；
 *   2. 认领后该 model 仍存在 custom 行（用户自定义过）→ 整个 model 跳过，内置让路、绝不覆盖；
 *   3. 无 custom 行 → 删除该 model 旧 builtin 行，按当前 BUILTIN_CNY 全量重建（自动带上新模型/新档）。
 * @param {DatabaseSync} db 插件主库（含 model_prices 表）
 * @param {object} logger 可选
 * @returns {object} { ok, synced: [{model, segments}], skipped: [{model, reason}], error? }
 */
export function syncBuiltinPrices(db, logger) {
  const log = logger || { info() {}, warn() {} };
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_prices'").get();
    if (!exists) return { ok: false, reason: 'no-table', synced: [], skipped: [] };

    const rows = db.prepare(`
      SELECT id, model, mode, currency, input_cache_hit_price, input_price, output_price,
             cache_create_price, start_time, end_time, peak_multiplier, peak_windows, source
      FROM model_prices
    `).all();
    const byModel = {};
    for (const r of rows) { (byModel[r.model] || (byModel[r.model] = [])).push(r); }

    // 内置基线按 model 聚合（顺序即分段顺序）
    const expect = {};
    for (const b of BUILTIN_CNY) { (expect[b.model] || (expect[b.model] = [])).push(b); }

    const updateSrc = db.prepare('UPDATE model_prices SET source = ? WHERE id = ?');
    const del = db.prepare("DELETE FROM model_prices WHERE model = ? AND source = 'builtin'");
    const insert = db.prepare(`
      INSERT INTO model_prices
        (model, display_name, mode, currency,
         input_cache_hit_price, input_price, output_price, cache_create_price,
         start_time, end_time, source, created_at, peak_multiplier, peak_windows)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin', ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      // 1) legacy 认领
      for (const m of Object.keys(expect)) {
        for (const b of expect[m]) {
          const hit = (byModel[m] || []).find((r) => r.source === 'custom' && builtinRowEqual(r, b));
          if (hit) { updateSrc.run('builtin', hit.id); hit.source = 'builtin'; }
        }
      }
      // 2/3) 有用户自定义行的 model 跳过；否则重建 builtin 段
      const synced = [];
      const skipped = [];
      const now = Date.now();
      for (const m of Object.keys(expect)) {
        const stillCustom = (byModel[m] || []).some((r) => r.source === 'custom');
        if (stillCustom) { skipped.push({ model: m, reason: 'user-custom' }); continue; }
        del.run(m);
        for (const b of expect[m]) {
          insert.run(b.model, b.displayName, b.mode, b.currency,
            b.cacheHitInput, b.input, b.output, b.cacheCreate,
            b.startTime, b.endTime, now, b.peakMultiplier, b.peakWindows);
        }
        synced.push({ model: m, segments: expect[m].length });
      }
      db.exec('COMMIT');
      log.info?.(`token-monitor: 内置价同步完成（${synced.length} 个模型重建，跳过用户自定义 ${skipped.length} 个）`);
      return { ok: true, synced, skipped };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      throw error;
    }
  } catch (error) {
    log.warn?.(`token-monitor: 内置价同步失败：${String((error && error.message) || error)}`);
    return { ok: false, error: String(error), synced: [], skipped: [] };
  }
}

/* ------------------------- 定位 pi-ai 目录 ------------------------- */

function findDataDir() {
  const candidates = [];
  if (process.argv[1]) {
    const dshRoot = path.dirname(path.dirname(process.argv[1]));
    candidates.push(path.join(dshRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'));
  }
  for (const dir of candidates) if (fs.existsSync(dir)) return dir;
  try {
    const req = createRequire(process.argv[1] ? path.join(path.dirname(process.argv[1]), 'noop.js') : import.meta.url);
    const pkg = req.resolve('@earendil-works/pi-ai/package.json');
    const dir = path.join(path.dirname(pkg), 'dist', 'providers', 'data');
    if (fs.existsSync(dir)) return dir;
  } catch { /* 找不到则定价缺失 */ }
  return null;
}

/**
 * 加载定价（统一价格入口）。
 * @param {object} logger 可选
 * @param {DatabaseSync} db 插件主库（可选；提供时启用 model_prices 表查询）
 * @param {() => number} getUsdCnyRate 汇率读取（可选；CNY 价折算美元用时）
 * @returns {{ priceFor, costNano, providerOf, dir, builtinCount }}
 */
export function loadPricing(logger, db, getUsdCnyRate) {
  const byRoute = new Map();
  const byModel = new Map();
  const providerByModel = new Map();
  const dir = findDataDir();

  if (dir) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const provider = file.replace(/\.json$/, '');
      let catalog;
      try {
        catalog = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch (error) {
        logger?.warn?.(`token-monitor: 目录文件 ${file} 解析失败：${error.message}`);
        continue;
      }
      for (const api of Object.keys(catalog)) {
        const models = catalog[api];
        if (!models || typeof models !== 'object') continue;
        for (const [model, entry] of Object.entries(models)) {
          const cost = entry && entry.cost;
          if (!cost) continue;
          const price = {
            input: toP4(cost.input),
            output: toP4(cost.output),
            cacheRead: toP4(cost.cacheRead),
            cacheWrite: toP4(cost.cacheWrite),
            mode: 'fixed', currency: 'USD',
          };
          byRoute.set(`${provider}/${model}`, price);
          if (!byModel.has(model)) byModel.set(model, price);
          if (!providerByModel.has(model)) providerByModel.set(model, provider);
        }
      }
    }
    logger?.info?.(`token-monitor: pi-ai 定价目录已加载（${byRoute.size} 条路由，来自 ${dir}）`);
  } else {
    logger?.warn?.('token-monitor: 未找到 pi-ai 模型目录（表与内置价仍可用）');
  }

  /* --- model_prices 表查询（含首次初始化的 DeepSeek 内置价；错峰在行内解析） --- */
  let tableStmt = null;
  if (db) {
    try {
      tableStmt = db.prepare(`
        SELECT mode, currency, input_cache_hit_price, input_price, output_price, cache_create_price,
               peak_multiplier, peak_windows
        FROM model_prices
        WHERE model = ? AND start_time <= ? AND end_time > ?
        ORDER BY start_time DESC LIMIT 1
      `);
    } catch { /* 表尚未创建：仅 pi-ai 兜底 */ }
  }
  const tablePrice = (model, ts) => {
    if (!tableStmt) return null;
    let row;
    try { row = tableStmt.get(model, ts, ts); } catch { return null; }
    if (!row) return null;
    const base = toPrice(row);
    return { ...applyPeak(row.peak_windows, row.peak_multiplier, base, ts), source: 'custom' };
  };

  /**
   * 统一取价：model_prices 表（内置 DeepSeek + 用户维护）→ pi-ai → null。
   * @returns {object|null} { input, output, cacheRead, cacheWrite, currency, mode, source }
   */
  function priceFor(provider, model, ts = Date.now()) {
    if (!model) return null;
    const t = tablePrice(model, ts);
    if (t) return t;
    const p = (byRoute.get(`${provider}/${model}`) || byModel.get(model) || null);
    return p ? { ...p, source: 'pi-ai' } : null;
  }

  /** 单次调用费用（纳美元）。currency=USD 直接计；CNY 按汇率折算。未定价返回 null。 */
  function costNano(provider, model, usage, ts = Date.now()) {
    const p = priceFor(provider, model, ts);
    if (!p) return null;
    const cur = Math.round(
      ((usage.input || 0) * p.input + (usage.output || 0) * p.output
        + (usage.cacheRead || 0) * p.cacheRead + (usage.cacheWrite || 0) * p.cacheWrite) / 10,
    );
    if (p.currency !== 'CNY') return cur;
    const rate = (typeof getUsdCnyRate === 'function' ? getUsdCnyRate() : null) || 7.2;
    return Math.round(cur / rate);
  }

  /** 模型 → 供应商反查（cc-switch 导入推断真实供应商用）；查不到返回 null。 */
  function providerOf(model) {
    return providerByModel.get(model) || null;
  }

  return { priceFor, costNano, providerOf, dir, builtinCount: BUILTIN_CNY.length };
}
