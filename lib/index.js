/**
 * dsh-token-monitor — 服务端。
 *
 * 在 ctx.webServer 上注册一个精确路由 `GET /token-monitor/overview`，
 * 聚合各大模型供应商的余量信息（账户余额 / 订阅额度），客户端的头部
 * 组件周期性拉取。抓取在 Host 进程内进行：凭证不离开 Host，浏览器也无
 * 跨域问题。
 *
 * 供应商抓取器是配置驱动的：cordis.yml 里本行的 config 可以覆盖
 * `cacheMs`、`kimi.url`、`deepseek.url`，无需改代码即可校准端点。
 * 每个供应商返回统一形状：
 *   { id, label, kind, ok, headline?, metrics?, error?, endpoint?, raw? }
 * raw 是截断后的原始响应（至多 4KB），用于在线校准解析规则。
 */

export const name = 'token-monitor';
export const inject = ['webServer'];

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPricing } from './util/pricing.js';
import { openUsageStore, dayOf } from './util/store.js';
import { foldAllSessions } from './util/fold.js';
import { importCcSwitch, checkCcPending } from './util/import-cc.js';

const ROUTE_PATH = '/token-monitor/overview';
const DEFAULT_CACHE_MS = 60_000;
const MIN_CACHE_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;
const RAW_PREVIEW_BYTES = 4096;

/* ------------------------------ 小工具 ------------------------------ */

/** 带超时与状态保留的 JSON GET；不抛 HTTP 非 2xx，交给调用方判断。 */
async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { status: res.status, ok: res.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function truncateRaw(data) {
  if (data === undefined) return undefined;
  let text;
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    return undefined;
  }
  return text.length > RAW_PREVIEW_BYTES ? `${text.slice(0, RAW_PREVIEW_BYTES)}…<truncated>` : text;
}

function errorText(error) {
  if (error && error.name === 'AbortError') return `请求超时（${FETCH_TIMEOUT_MS}ms）`;
  return String((error && error.message) || error);
}

/** 递归收集对象里所有 {path, value} 叶子，供额度字段启发式识别。 */
function walkLeaves(value, path, out, depth) {
  if (depth > 6 || out.length > 200) return;
  if (value === null || typeof value !== 'object') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkLeaves(item, `${path}[${i}]`, out, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walkLeaves(child, path ? `${path}.${key}` : key, out, depth + 1);
  }
}

/* --------------------------- 凭证解析 --------------------------- */

/**
 * 按引用解析凭证（与 dsh-llm-pi-ai 的 apiKeyEnv 语义一致）：先走
 * ctx.credentials  seam（~/.dsh/.credentials.yaml 等托管来源），
 * 再退回进程环境变量。拿不到返回 undefined。
 */
async function resolveCredential(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref);
      if (hit && typeof hit.value === 'string' && hit.value.trim()) return hit.value.trim();
    } catch (error) {
      ctx.logger.warn(`token-monitor: credentials.resolve(${ref}) 失败：${errorText(error)}`);
    }
  }
  const ambient = process.env[ref];
  return ambient && ambient.trim() ? ambient.trim() : undefined;
}

/* ------------------------- DeepSeek 余额 ------------------------- */

const DEEPSEEK_URLS = [
  'https://api.deepseek.com/user/balance',
  'https://api.deepseek.com/v1/user/balance',
];

async function fetchDeepSeek(ctx, config) {
  const base = { id: 'deepseek', label: 'DeepSeek', kind: 'balance' };
  const key = await resolveCredential(ctx, 'DEEPSEEK_API_KEY');
  if (!key) return { ...base, ok: false, error: '未配置 DEEPSEEK_API_KEY' };

  const urls = [config.url, ...DEEPSEEK_URLS].filter(Boolean);
  let lastError = '无可用端点';
  for (const url of urls) {
    let res;
    try {
      res = await fetchJson(url, { authorization: `Bearer ${key}` });
    } catch (error) {
      lastError = errorText(error);
      continue;
    }
    if (res.status === 404) {
      lastError = `404 ${url}`;
      continue;
    }
    if (!res.ok || !res.data) {
      return { ...base, ok: false, endpoint: url, error: `HTTP ${res.status}`, raw: truncateRaw(res.data ?? res.text) };
    }
    const data = res.data;
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    const metrics = infos.map((info) => ({
      label: info.currency === 'CNY' ? '人民币账户' : `${info.currency || '?'} 账户`,
      value: `${info.total_balance} ${info.currency}`,
      detail: `充值 ${info.topped_up_balance} · 赠送 ${info.granted_balance}`,
    }));
    const first = infos[0];
    return {
      ...base,
      ok: true,
      endpoint: url,
      headline: first ? `${first.total_balance} ${first.currency}` : '—',
      metrics: metrics.length
        ? metrics
        : [{ label: '可用', value: data.is_available ? '是' : '否' }],
      raw: truncateRaw(data),
    };
  }
  return { ...base, ok: false, error: lastError };
}

/* --------------------- Kimi For Coding 订阅额度 --------------------- */

const KIMI_BASE = 'https://api.kimi.com/coding';
/**
 * 候选额度端点，按可能性排序；首个返回非 404 JSON 的获胜。
 * `/v1/usages` 是 2026-08 实测确认的真实端点（见 parseKimiUsages）；
 * 其余保留作兜底，端点变迁时仍有机会自愈。
 */
const KIMI_CANDIDATES = [
  '/v1/usages',
  '/v1/usage',
  '/v1/users/me/quota',
  '/v1/quota',
  '/v1/users/me/usage',
  '/v1/me',
  '/v1/subscription',
];
const KIMI_HEADERS = {
  'user-agent': 'KimiCLI/1.5',
};

/** 重置倒计时："1d 3h 18min后重置"（天/时/分都列；过期按 0min 计，无特殊状态文案）。 */
function formatCountdown(iso, now = Date.now()) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now;
  if (!isFinite(ms)) return '';
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}min`);
  return `${parts.join(' ') || '0min'}后重置`;
}

/**
 * 专用解析器：`GET /v1/usages`（+ `/v1/me` 附带权益等级名）的实测
 * 响应结构（2026-08 校准），展示口径对齐 Kimi 官方控制台：
 * 本周用量 / 频限明细（滚动窗口）/ 我的权益（会员名胶囊）。
 * 数值字段是字符串；`usage` 是周期总额度，`limits[]` 是滚动窗口
 * （如 300 分钟 = 5 小时窗）。headline 优先用 5 小时窗口用量百分比。
 */
function parseKimiUsages(data, extras = {}) {
  if (!data || typeof data !== 'object' || (!data.usage && !Array.isArray(data.limits))) return null;
  // 滚动窗口（5 小时）在前，本周在后——时效性最强的额度优先展示。
  const windows = [];
  if (Array.isArray(data.limits)) {
    for (const entry of data.limits) {
      const minutes = entry && entry.window && entry.window.timeUnit === 'TIME_UNIT_MINUTE'
        ? entry.window.duration
        : null;
      const name = typeof minutes === 'number'
        ? `${minutes % 60 === 0 ? `${minutes / 60}小时` : `${minutes}分钟`}用量`
        : '频限明细';
      if (entry && entry.detail) windows.push({ name, detail: entry.detail, weekly: false });
    }
  }
  if (data.usage && typeof data.usage === 'object') windows.push({ name: '7天用量', detail: data.usage, weekly: true });
  const metrics = [];
  let windowStat;
  let weeklyStat;
  for (const w of windows) {
    const limit = Number(w.detail.limit);
    let used = Number(w.detail.used);
    // API 字段兼容（2026-08 实测）：5 小时窗口刚重置（未使用时）detail 可能只给
    // remaining 不给 used；用 limit - remaining 推算，避免整个窗口被跳过。
    if (!isFinite(used) && w.detail.remaining !== undefined) {
      const remaining = Number(w.detail.remaining);
      if (isFinite(remaining)) used = limit - remaining;
    }
    if (!isFinite(limit) || limit <= 0 || !isFinite(used)) continue;
    const pct = Math.max(0, Math.round((used / limit) * 100));
    const countdown = formatCountdown(w.detail.resetTime);
    const resetAt = Date.parse(w.detail.resetTime);
    const stat = { pct, remainingPct: 100 - pct, used, limit, countdown, resetAt: isFinite(resetAt) ? resetAt : undefined };
    if (w.weekly) weeklyStat = stat;
    else if (!windowStat) windowStat = stat;
    metrics.push({
      label: countdown ? `${w.name}（${countdown}）` : w.name,
      value: `${pct}%`,
      pct,
    });
  }
  // 会员名不作为独立指标行，由前端渲染成供应商名后的胶囊。
  const badge = extras.levelName
    || (data.user && data.user.membership && String(data.user.membership.level || '').replace(/^LEVEL_/, ''))
    || undefined;
  if (!metrics.length && !badge) return null;
  return {
    headline: windowStat
      ? `5小时 ${windowStat.pct}%`
      : (weeklyStat ? `周用 ${weeklyStat.pct}%` : (badge || '已连接')),
    badge,
    metrics,
    stats: { window: windowStat, weekly: weeklyStat },
  };
}

/**
 * 额度字段启发式识别：在 JSON 叶子里找 used/total/limit/remaining/percent
 * 一类的键，拼成指标行。识别不到也能把 raw 带回给前端校准。
 */
function parseQuotaMetrics(data) {
  const leaves = [];
  walkLeaves(data, '', leaves, 0);
  const metrics = [];
  const seen = new Set();

  const findNum = (obj, names) => {
    for (const name of names) {
      const leaf = leaves.find((l) => l.path === `${obj}.${name}` && typeof l.value === 'number');
      if (leaf) return leaf.value;
    }
    return undefined;
  };

  // 逐对象路径尝试 {used,total/limit} 或 {remaining,total/limit} 组合。
  const objectPaths = [...new Set(
    leaves.filter((l) => l.path.includes('.')).map((l) => l.path.replace(/\.[^.]+$/, '')),
  )];
  for (const obj of objectPaths) {
    const used = findNum(obj, ['used', 'usage', 'consumed']);
    const remaining = findNum(obj, ['remaining', 'remain', 'left', 'balance']);
    const total = findNum(obj, ['total', 'limit', 'quota', 'cap', 'allowance']);
    if (total && (used !== undefined || remaining !== undefined)) {
      const rem = remaining !== undefined ? remaining : total - used;
      const pct = Math.max(0, Math.min(100, Math.round((rem / total) * 100)));
      const name = obj.split('.').filter(Boolean).pop() || '额度';
      const key = `${obj}:${pct}`;
      if (!seen.has(key)) {
        seen.add(key);
        metrics.push({ label: name, value: `${pct}%`, detail: `剩余 ${rem} / ${total}` });
      }
    }
  }

  // 直接的百分比字段。
  for (const leaf of leaves) {
    if (typeof leaf.value !== 'number') continue;
    const key = leaf.path.split('.').pop().toLowerCase();
    if (['percent', 'percentage', 'remaining_percent', 'usage_percent', 'ratio'].includes(key)) {
      const pct = key === 'usage_percent' ? 100 - leaf.value : leaf.value;
      const name = leaf.path.split('.').slice(-2, -1)[0] || '额度';
      metrics.push({ label: name, value: `${Math.round(pct)}%` });
    }
  }

  // 重置时间。
  const reset = leaves.find((l) => /reset/i.test(l.path) && (typeof l.value === 'string' || typeof l.value === 'number'));
  if (reset) metrics.push({ label: '重置时间', value: String(reset.value) });

  return metrics;
}

async function fetchKimi(ctx, config) {
  const base = { id: 'kimi-coding', label: 'Kimi For Coding', kind: 'quota' };
  const key = await resolveCredential(ctx, 'KIMI_CODING_API_KEY');
  if (!key) return { ...base, ok: false, error: '未配置 KIMI_CODING_API_KEY' };

  const baseUrl = (config.baseUrl || KIMI_BASE).replace(/\/+$/, '');
  const candidates = config.url ? [config.url] : KIMI_CANDIDATES.map((p) => `${baseUrl}${p}`);
  let lastError = '无可用端点';
  for (const url of candidates) {
    let res;
    try {
      res = await fetchJson(url, { ...KIMI_HEADERS, authorization: `Bearer ${key}` });
    } catch (error) {
      lastError = errorText(error);
      continue;
    }
    if (res.status === 404) {
      lastError = `404 ${url}`;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      return { ...base, ok: false, endpoint: url, error: `凭证被拒绝（HTTP ${res.status}）`, raw: truncateRaw(res.data ?? res.text) };
    }
    if (!res.ok || !res.data) {
      lastError = `HTTP ${res.status} ${url}`;
      continue;
    }
    // 附属信息（我的权益等级名，来自 /v1/me）：尽力而为，失败不影响主结果。
    const me = await fetchJson(`${baseUrl}/v1/me`, { ...KIMI_HEADERS, authorization: `Bearer ${key}` }).catch(() => null);
    const extras = {
      levelName: me && me.ok && me.data && typeof me.data.user_level_name === 'string' ? me.data.user_level_name : undefined,
    };
    const dedicated = parseKimiUsages(res.data, extras);
    const metrics = dedicated ? dedicated.metrics : parseQuotaMetrics(res.data);
    const headline = dedicated
      ? dedicated.headline
      : (metrics.length ? metrics[0].value : '已连接');
    const badge = (dedicated && dedicated.badge) || extras.levelName || undefined;
    return {
      ...base,
      ok: true,
      endpoint: url,
      headline,
      badge,
      stats: dedicated ? dedicated.stats : undefined,
      metrics: metrics.length ? metrics : [{ label: '状态', value: '端点可用，额度字段未识别（见原始响应）' }],
      raw: truncateRaw(res.data),
    };
  }
  return { ...base, ok: false, error: lastError };
}

/* ---------------------------- 插件本体 ---------------------------- */

const FETCHERS = {
  'kimi-coding': fetchKimi,
  deepseek: fetchDeepSeek,
};

export function apply(ctx, config = {}) {
  const cacheMs = typeof config.cacheMs === 'number' && config.cacheMs >= MIN_CACHE_MS
    ? config.cacheMs
    : DEFAULT_CACHE_MS;
  const providerConfig = (config.providers && typeof config.providers === 'object') ? config.providers : {};

  const cache = new Map(); // id -> { at, payload }
  const inflight = new Map(); // id -> Promise<payload>

  async function providerOverview(id) {
    const cached = cache.get(id);
    if (cached && Date.now() - cached.at < cacheMs) return cached.payload;
    if (inflight.has(id)) return inflight.get(id);
    const task = (async () => {
      try {
        const payload = await FETCHERS[id](ctx, providerConfig[id] || {});
        cache.set(id, { at: Date.now(), payload });
        return payload;
      } catch (error) {
        return { id, label: id, kind: 'unknown', ok: false, error: errorText(error) };
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, task);
    return task;
  }

  async function overview() {
    const ids = Object.keys(FETCHERS);
    const providers = await Promise.all(ids.map(providerOverview));
    return { ok: true, fetchedAt: Date.now(), cacheMs, providers };
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        try {
          const body = JSON.stringify(await overview());
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(body);
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: errorText(error) }));
        }
      },
    });
    ctx.logger.info(`token-monitor: 余量概览路由已注册 GET ${ROUTE_PATH}`);
    return dispose;
  }, 'token-monitor: overview route');

  /* -------------------------- 用量统计（本地 SQLite） -------------------------- */

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const pricing = loadPricing(ctx.logger);
  const store = openUsageStore(ctx.logger);
  ctx.on('dispose', () => store.close());

  const FOLD_INTERVAL_MS = typeof config.foldIntervalMs === 'number' && config.foldIntervalMs >= 30_000
    ? config.foldIntervalMs
    : 300_000;

  // 单飞折叠：同一时间只有一轮在跑
  let folding = null;
  function foldOnce() {
    if (folding) return folding;
    folding = (async () => {
      try {
        const r = foldAllSessions(store, pricing, dshHome, ctx.logger);
        if (r.imported > 0 || r.errors.length > 0) {
          ctx.logger.info(`token-monitor: 折叠完成，新增 ${r.imported} 行（扫描 ${r.filesScanned} 个文件）`);
        }
        return r;
      } finally {
        folding = null;
      }
    })();
    return folding;
  }

  // 启动即折一轮（不阻塞插件加载），之后按周期增量折叠
  const bootFold = setImmediate(foldOnce);
  const foldTimer = setInterval(foldOnce, FOLD_INTERVAL_MS);
  ctx.on('dispose', () => {
    clearImmediate(bootFold);
    clearInterval(foldTimer);
  });

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  /** 纳美元 → 美元数值（展示换算，§5）。 */
  const toUsd = (nano) => (nano === null || nano === undefined ? null : Number(nano) / 1e9);

  function windowStartDay(days) {
    const n = Number.isInteger(days) && days > 0 && days <= 3650 ? days : 30;
    return dayOf(Date.now() - (n - 1) * 86_400_000);
  }

  const ROUTES = [
    {
      // 按天 × 模型汇总（读 rollup）
      path: '/token-monitor/usage/daily',
      handle(days) {
        const rows = store.db.prepare(`
          SELECT day, model,
                 SUM(requests) AS requests,
                 SUM(input_tokens) AS input_tokens,
                 SUM(output_tokens) AS output_tokens,
                 SUM(cache_read_tokens) AS cache_read_tokens,
                 SUM(cache_write_tokens) AS cache_write_tokens,
                 SUM(cost_usd_nano) AS cost_nano,
                 SUM(unpriced_requests) AS unpriced_requests,
                 CASE WHEN SUM(ttft_count) > 0 THEN SUM(ttft_sum_ms) / SUM(ttft_count) ELSE NULL END AS ttft_avg_ms
          FROM usage_daily_rollups
          WHERE day >= ?
          GROUP BY day, model
          ORDER BY day
        `).all(windowStartDay(days));
        return rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
      },
    },
    {
      // 按模型汇总（读明细表：来源列要显示 client 值，rollup 无 client 列；
      // 明细量级数千行，聚合毫秒级，与 rollup 口径一致）
      path: '/token-monitor/usage/by-model',
      handle(days) {
        const rows = store.db.prepare(`
          SELECT r.model, r.provider, r.client,
                 COUNT(*) AS requests,
                 SUM(r.input_tokens) AS input_tokens,
                 SUM(r.output_tokens) AS output_tokens,
                 SUM(r.cache_read_tokens) AS cache_read_tokens,
                 SUM(r.cost_usd_nano) AS cost_nano,
                 SUM(CASE WHEN r.cost_usd_nano IS NULL THEN 1 ELSE 0 END) AS unpriced_requests,
                 CASE WHEN SUM(CASE WHEN r.ttft_ms IS NOT NULL THEN 1 ELSE 0 END) > 0
                      THEN SUM(COALESCE(r.ttft_ms, 0)) / SUM(CASE WHEN r.ttft_ms IS NOT NULL THEN 1 ELSE 0 END)
                      ELSE NULL END AS ttft_avg_ms
          FROM usage_requests r
          WHERE r.day >= ?
          GROUP BY r.model, r.provider, r.client
          ORDER BY cost_nano DESC
        `).all(windowStartDay(days));
        return rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
      },
    },
    {
      // 会话级下钻（读明细表，低频）
      path: '/token-monitor/usage/sessions',
      handle(days, url) {
        const day = url.searchParams.get('day');
        const where = day ? 'r.day = ?' : 'r.day >= ?';
        const arg = day || windowStartDay(days);
        return store.db.prepare(`
          SELECT r.session_id, w.title,
                 COUNT(*) AS requests,
                 SUM(r.input_tokens) AS input_tokens,
                 SUM(r.output_tokens) AS output_tokens,
                 SUM(r.cache_read_tokens) AS cache_read_tokens,
                 SUM(r.cost_usd_nano) AS cost_nano
          FROM usage_requests r
          LEFT JOIN fold_watermarks w ON w.session_id = r.session_id
          WHERE r.session_id IS NOT NULL AND ${where}
          GROUP BY r.session_id
          ORDER BY cost_nano DESC NULLS LAST
          LIMIT 100
        `).all(arg).map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
      },
    },
    {
      // 按小时聚合（读明细表，"当天"窗口的 X 轴按小时显示）：
      // 小时取自 created_at 的本地时区小时，与 day 列的本地口径一致
      path: '/token-monitor/usage/hourly',
      handle(days, url) {
        const day = url.searchParams.get('day') || dayOf(Date.now());
        const rows = store.db.prepare(`
          SELECT CAST(strftime('%H', r.created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                 COUNT(*) AS requests,
                 SUM(r.input_tokens) AS input_tokens,
                 SUM(r.output_tokens) AS output_tokens,
                 SUM(r.cache_read_tokens) AS cache_read_tokens,
                 SUM(r.cache_write_tokens) AS cache_write_tokens,
                 SUM(r.cost_usd_nano) AS cost_nano
          FROM usage_requests r
          WHERE r.day = ?
          GROUP BY hour
          ORDER BY hour
        `).all(day);
        return rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
      },
    },
    {
      // 时段热力图：小时 × 星期几（读明细表）；
      // 小时/星期均取本地时区，与 day 列口径一致；%w: 0=周日..6=周六
      path: '/token-monitor/usage/heatmap',
      handle(days) {
        return store.db.prepare(`
          SELECT CAST(strftime('%H', r.created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                 CAST(strftime('%w', r.created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
                 COUNT(*) AS requests,
                 SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens) AS tokens
          FROM usage_requests r
          WHERE r.day >= ?
          GROUP BY hour, dow
        `).all(windowStartDay(days));
      },
    },
  ];

  ctx.effect(() => {
    const disposers = ROUTES.map((route) => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        try {
          await foldOnce(); // 查询前先增量折叠（mtime 跳过无变化文件，活跃会话秒级）
          const url = new URL(req.url, 'http://localhost');
          const days = Number(url.searchParams.get('days'));
          sendJson(res, 200, { ok: true, data: route.handle(days, url) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    }));
    ctx.logger.info('token-monitor: 用量统计路由已注册（daily / by-model / sessions）');
    return () => disposers.forEach((d) => d());
  }, 'token-monitor: usage routes');

  ctx.effect(() => {
    const ccDbPath = (config.ccSwitchDb && typeof config.ccSwitchDb === 'string')
      ? config.ccSwitchDb
      : path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/import/cc-switch',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          try {
            const result = importCcSwitch(store, ccDbPath, ctx.logger, pricing);
            sendJson(res, result.error ? 400 : 200, { ok: !result.error, ...result });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) });
          }
        },
      }),
      // 同步探测（DESIGN §11.3）：有未同步记录才在弹层提示条显示"同步"入口
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/sync/pending',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' });
            res.end();
            return;
          }
          try {
            const pending = checkCcPending(store, ccDbPath);
            sendJson(res, 200, { ok: true, pending });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) });
          }
        },
      }),
    ];
    ctx.logger.info('token-monitor: CC 导入 + 同步探测路由已注册');
    return () => disposers.forEach((d) => d());
  }, 'token-monitor: cc routes');

  /* ---------------- 前端 vendor 静态资源（echarts） ---------------- */

  // DSH 的 /plugins/<id>/ 路由只认 client.js，第三方库走自己的路由分发。
  ctx.effect(() => {
    const vendorFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'echarts.min.js');
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/vendor/echarts.min.js',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        try {
          const body = await fs.promises.readFile(vendorFile);
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            // 内容随插件版本更新，长缓存即可
            'cache-control': 'public, max-age=86400',
          });
          res.end(body);
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`echarts vendor 缺失：${errorText(error)}`);
        }
      },
    });
    ctx.logger.info('token-monitor: echarts vendor 路由已注册');
    return dispose;
  }, 'token-monitor: vendor route');
}
