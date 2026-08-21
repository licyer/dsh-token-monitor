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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPricing } from './util/pricing.js';
import { openUsageStore, dayOf } from './util/store.js';
import { PROVIDER_MAPPING_SEED } from './util/provider-mappings.js';
import { foldAllSessions } from './util/fold.js';
import { importCcSwitch, importCcSqlFile, checkCcPending } from './util/import-cc.js';

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
    // 附属信息（我的权益等级名 /v1/me、模型展示名 /v1/models）：尽力而为，失败不影响主结果。
    // modelLabels 是动态的 id→display_name 映射——kimi-for-coding 这类"滚动 id"会随官方升级换代
    // （K2.5→K2.7→…），展示名必须实时取，不能写死。
    const [me, models] = await Promise.all([
      fetchJson(`${baseUrl}/v1/me`, { ...KIMI_HEADERS, authorization: `Bearer ${key}` }).catch(() => null),
      fetchJson(`${baseUrl}/v1/models`, { ...KIMI_HEADERS, authorization: `Bearer ${key}` }).catch(() => null),
    ]);
    const modelLabels = {};
    if (models && models.ok && models.data && Array.isArray(models.data.data)) {
      for (const m of models.data.data) {
        if (m && m.id && m.display_name) modelLabels[m.id] = m.display_name;
      }
    }
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
      modelLabels: Object.keys(modelLabels).length ? modelLabels : undefined,
      metrics: metrics.length ? metrics : [{ label: '状态', value: '端点可用，额度字段未识别（见原始响应）' }],
      raw: truncateRaw(res.data),
    };
  }
  return { ...base, ok: false, error: lastError };
}

/* --------------------- OpenCode 订阅额度 --------------------- */

const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** OpenCode 使用量解析：{ usage: { rolling, weekly, monthly: { status, percent, resetsAt } } }。
 *  percent 为已用百分比（8 = 已用 8%），remainingPct = 100 - percent。
 *  三窗口语义：rolling=5h 滚动窗口、weekly=7d 本周、monthly=30d 本月，均带 status（'ok'）
 *  与 resetsAt（重置时刻），与 Kimi 的窗口余量同语义。
 *  stats 输出 window=rolling、weekly、monthly，前端余量组合可复用。 */
function parseOpencodeUsage(data) {
  const u = data && typeof data === 'object' ? data.usage : null;
  if (!u || typeof u !== 'object') return null;
  const pick = (w) => {
    if (!w || typeof w !== 'object') return null;
    const pct = Number(w.percent);
    if (!isFinite(pct)) return null;
    const resetAt = Date.parse(w.resetsAt);
    return {
      pct,
      remainingPct: Math.max(0, 100 - pct),
      usedPct: pct,
      countdown: formatCountdown(w.resetsAt),
      resetAt: isFinite(resetAt) ? resetAt : undefined,
      status: w.status || 'ok',
    };
  };
  const rolling = pick(u.rolling);
  const weekly = pick(u.weekly);
  const monthly = pick(u.monthly);
  if (!rolling && !weekly && !monthly) return null;
  const metrics = [];
  const push = (label, stat) => {
    if (!stat) return;
    metrics.push({
      label: stat.countdown ? `${label}（${stat.countdown}）` : label,
      value: `${stat.pct}%`,
      pct: stat.pct,
    });
  };
  // ProviderCard（弹层顶部）用完整标签，与 Kimi 的"5小时用量/7天用量"风格一致
  push('5小时用量', rolling);
  push('7天用量', weekly);
  push('30天用量', monthly);
  // headline 供徽标/全部供应商；stats.labels 供余量组合显示简称（5h/7d/30d）
  const headline = rolling ? `5h ${rolling.pct}%` : (weekly ? `7d ${weekly.pct}%` : (monthly ? `30d ${monthly.pct}%` : '已连接'));
  return { headline, metrics, stats: { window: rolling, weekly, monthly, labels: { window: '5h', weekly: '7d', monthly: '30d' } } };
}

async function fetchOpencodeGo(ctx, config) {
  // id 用 DSH 路由名 'opencode-go'（settings.yaml llm-pi-ai.providers.opencode-go），
  // 与徽标定位（PROVIDER_ALIASES 直查 current.provider）对齐，避免"未配置监控"。
  const base = { id: 'opencode-go', label: 'OpenCode', kind: 'quota' };
  const key = await resolveCredential(ctx, 'OPENCODE_GO_API_KEY');
  if (!key) return { ...base, ok: false, error: '未配置 OPENCODE_GO_API_KEY' };

  const url = (config.url || OPENCODE_USAGE_URL).replace(/\/+$/, '');
  let res;
  try {
    res = await fetchJson(url, { authorization: `Bearer ${key}` });
  } catch (error) {
    return { ...base, ok: false, error: errorText(error) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, ok: false, endpoint: url, error: `凭证被拒绝（HTTP ${res.status}）`, raw: truncateRaw(res.data ?? res.text) };
  }
  if (!res.ok || !res.data) {
    return { ...base, ok: false, endpoint: url, error: `HTTP ${res.status}`, raw: truncateRaw(res.data ?? res.text) };
  }
  const dedicated = parseOpencodeUsage(res.data);
  const metrics = dedicated ? dedicated.metrics : parseQuotaMetrics(res.data);
  const headline = dedicated
    ? dedicated.headline
    : (metrics.length ? metrics[0].value : '已连接');
  return {
    ...base,
    ok: true,
    endpoint: url,
    headline,
    stats: dedicated ? dedicated.stats : undefined,
    metrics: metrics.length ? metrics : [{ label: '状态', value: '端点可用，额度字段未识别（见原始响应）' }],
    raw: truncateRaw(res.data),
  };
}

/* ---------------------------- 插件本体 ---------------------------- */

const FETCHERS = {
  'kimi-coding': fetchKimi,
  deepseek: fetchDeepSeek,
  'opencode-go': fetchOpencodeGo,
};

export function apply(ctx, config = {}) {
  const cacheMs = typeof config.cacheMs === 'number' && config.cacheMs >= MIN_CACHE_MS
    ? config.cacheMs
    : DEFAULT_CACHE_MS;
  const providerConfig = (config.providers && typeof config.providers === 'object') ? config.providers : {};

  const cache = new Map(); // id -> { at, payload }
  const inflight = new Map(); // id -> Promise<payload>

  /* ---------- USD→CNY 汇率（启动拉取 + 每天 8 点更新，内存缓存不入库） ----------
   * 实时源：open.er-api.com（免费、无 key、约每小时更新）；失败用默认 7.2 兜底。
   * 时间闸：距上次成功更新不足 24h 不重拉；到点且本地时间 ≥ 8:00 才更新。
   * 与 prune 的 24h 时间闸同思路，但汇率不入库（丢失可重拉，无审计需求）。 */
  const DEFAULT_USD_CNY = 7.2;
  const RATE_UPDATE_MS = 86_400_000; // 24h 时间闸
  const RATE_URL = 'https://open.er-api.com/v6/latest/USD';
  let usdCnyRate = DEFAULT_USD_CNY;
  let rateFetchedAt = 0;
  let lastRateAt = 0; // 上次成功更新时刻（时间闸）

  async function refreshUsdCnyRate() {
    // 时间闸：24h 内不重拉；首次启动（lastRateAt=0）立即拉
    const now = Date.now();
    if (lastRateAt && now - lastRateAt < RATE_UPDATE_MS) return;
    // 每天 8 点后更新：距上次 ≥24h 且本地时间 ≥ 8:00（或从未拉过）
    const h = new Date(now).getHours();
    if (lastRateAt && h < 8) return;
    try {
      const res = await fetchJson(RATE_URL);
      const cny = res && res.ok && res.data && res.data.rates && Number(res.data.rates.CNY);
      if (isFinite(cny) && cny > 0) {
        usdCnyRate = cny;
        lastRateAt = now;
        rateFetchedAt = now;
        ctx.logger.info(`token-monitor: 汇率已更新 USD/CNY=${cny}`);
      } else {
        ctx.logger.warn('token-monitor: 汇率接口返回异常，保留现值');
      }
    } catch (error) {
      ctx.logger.warn(`token-monitor: 汇率拉取失败：${errorText(error)}，保留现值 ${usdCnyRate}`);
    }
  }

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
    // label 统一为 provider_mappings 的提供方名（有映射的覆盖抓取器硬编码 label，
    // 保证弹层"全部提供方"与用量页 provider_name 一致；无映射保留抓取器 label）
    for (const p of providers) {
      const m = p && providerMap[p.id];
      if (m) p.label = m.provider_name;
    }
    // 汇率：首次/到点触发拉取（失败保留现值兜底）；随 overview 下发供前端换算
    await refreshUsdCnyRate();
    return { ok: true, fetchedAt: Date.now(), cacheMs, providers, usdCnyRate, rateFetchedAt };
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
  const ccDbPath = (config.ccSwitchDb && typeof config.ccSwitchDb === 'string')
    ? config.ccSwitchDb
    : path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  const pricing = loadPricing(ctx.logger);
  const store = openUsageStore(ctx.logger);
  ctx.on('dispose', () => store.close());

  // 提供方映射种子：启动时幂等写入 provider_mappings（已存在不覆盖用户手动改的）。
  // 映射用于查询层把 provider_id 换成提供方名称/供应商，聚合按 vendor 归并。
  {
    const existing = store.getProviderMappings();
    for (const m of PROVIDER_MAPPING_SEED) {
      if (!existing[m.providerId]) store.upsertProviderMapping(m);
    }
  }

  const FOLD_INTERVAL_MS = typeof config.foldIntervalMs === 'number' && config.foldIntervalMs >= 30_000
    ? config.foldIntervalMs
    : 300_000;

  /* ---------------- 明细定期清理（prune） ----------------
   * usage_requests 是 append-only 事实表，长期运行会无限增长；按天保留期清理。
   * 只删明细不碰 rollup（rollup 是实时增量镜像，历史统计由它继续承载）。
   * 触发挂载在 foldOnce 尾部：高频入口只做 O(1) 内存时间闸比较，真正的清理
   * 每天最多一次。时间闸持久化在 sync_logs（kind='prune'），重启后查库恢复。
   */
  const PRUNE_RETAIN_DAYS = 60;          // 明细保留天数（cutoff = 今天本地午夜 - 60 天，完整天对齐）
  const PRUNE_INTERVAL_MS = 86_400_000;  // 时间闸：距上次清理不足 24h 不检测
  let lastPruneAt = null;                // 内存时间闸；首次检查时从 sync_logs 填充

  /** 检查并执行明细清理。O(1) 时间闸在前，量闸与删除只在到点后发生；任何失败只记日志不抛出。 */
  function pruneCheck() {
    const now = Date.now();
    try {
      if (lastPruneAt === null) {
        // 启动后首次：从 sync_logs 恢复上次清理时间；从未清理过 → 0，首次直接进入量闸
        lastPruneAt = store.getLastPruneAt() ?? 0;
      }
      if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;

      // 量闸：cutoff 按本地午夜对齐完整天（绝不半截清掉"今天"）；
      // 库里没有比 cutoff 更早的明细就不值得清（也推进时间闸，避免每轮都查库）
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const cutoffDay = dayOf(midnight - PRUNE_RETAIN_DAYS * 86_400_000);
      const maxDay = store.db.prepare('SELECT MAX(day) AS d FROM usage_requests').get().d;
      if (!maxDay || maxDay >= cutoffDay) {
        lastPruneAt = now;
        return;
      }

      const startedAt = Date.now();
      const deleted = store.pruneOldRows(cutoffDay);
      lastPruneAt = Date.now();
      // 审计行复用 sync_logs（imported 列存删除行数）；成功后时间闸才会被推进
      store.recordSyncLog({
        source: 'prune', kind: 'prune', startedAt,
        finishedAt: Date.now(), status: 'ok',
        imported: deleted, skipped: 0, skippedUnknownApp: 0,
        watermark: null, filesScanned: 0, errors: [],
      });
      if (deleted > 0) {
        ctx.logger.info(`token-monitor: 明细清理完成，删除 ${deleted} 行（day < ${cutoffDay}）`);
      }
    } catch (error) {
      // 失败：重置时间闸让下一轮检查重试；只记日志（审计行留给成功路径，避免二次失败）
      lastPruneAt = null;
      ctx.logger.warn(`token-monitor: 明细清理检查失败：${errorText(error)}`);
    }
  }

  // 单飞折叠：同一时间只有一轮在跑。
  // 注意：foldAllSessions 是同步的——Promise 占位必须【先】赋值（folding = task），
  // 折叠工作放进微任务执行；若在 async IIFE 里同步执行，finally 会先清空、
  // 赋值随后写回已解决 Promise，folding 将永久非空、折叠永久停摆（16:22 的教训）。
  let folding = null;
  function foldOnce() {
    if (folding) return folding;
    const task = Promise.resolve().then(() => {
      try {
        const r = foldAllSessions(store, pricing, dshHome, ctx.logger);
        if (r.imported > 0 || r.errors.length > 0) {
          ctx.logger.info(`token-monitor: 折叠完成，新增 ${r.imported} 行（扫描 ${r.filesScanned} 个文件）`);
        }
        // 明细清理检查挂载点：所有折叠入口（启动/定时/手动/开页）都汇聚到这里；
        // 时间闸未到点时这里是纯内存比较，零 DB 访问
        pruneCheck();
        return r;
      } finally {
        if (folding === task) folding = null;
      }
    });
    folding = task;
    return task;
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
    if (days === 0) return '0000-01-01'; // "全部"时间窗：无时间下限
    const n = Number.isInteger(days) && days > 0 && days <= 3650 ? days : 30;
    return dayOf(Date.now() - (n - 1) * 86_400_000);
  }

  /* ---------- 第一行筛选条件（范围/客户端/供应商/模型）---------- */

  /** 解析筛选参数：client / provider / model / session（会话 id，scope=current 时传）。 */
  function parseFilters(url) {
    return {
      client: url.searchParams.get('client') || '',
      provider: url.searchParams.get('provider') || '',
      model: url.searchParams.get('model') || '',
      session: url.searchParams.get('session') || '',
    };
  }
  /** 明细表 WHERE 附加条件（列前缀 r.）。返回 { sql, args }。 */
  function filterWhere(f) {
    const conds = [];
    const args = [];
    if (f.client) { conds.push('r.client = ?'); args.push(f.client); }
    const pc = providerCond(f, 'r');
    if (pc) { conds.push(pc.sql); args.push(...pc.args); }
    if (f.model) { conds.push('r.model = ?'); args.push(f.model); }
    if (f.session) { conds.push('r.session_id = ?'); args.push(f.session); }
    return { sql: conds.length ? ` AND ${conds.join(' AND ')}` : '', args };
  }

  /**
   * provider 筛选条件（vendor 展开）：前端 provider 参数是 vendor id，
   * 查询时展开为该 vendor 下全部 provider，`<prefix>.provider IN (...)`；
   * 映射缺失时按原值 `= ?` 兜底。prefix 为列前缀（'r' 或空）。返回 { sql, args } 或 null。
   */
  function providerCond(f, prefix) {
    if (!f.provider) return null;
    const col = prefix ? `${prefix}.provider` : 'provider';
    const pids = Object.keys(providerMap).filter((pid) => providerMap[pid].vendor === f.provider);
    if (pids.length) {
      return { sql: `${col} IN (${pids.map(() => '?').join(',')})`, args: pids };
    }
    return { sql: `${col} = ?`, args: [f.provider] };
  }
  /** 明细表聚合公共列（day/model 或 model 分组用；返回 SQL 片段与别名）。 */
  const AGG_DETAIL = `
    COUNT(*) AS requests,
    SUM(r.input_tokens) AS input_tokens,
    SUM(r.output_tokens) AS output_tokens,
    SUM(r.cache_read_tokens) AS cache_read_tokens,
    SUM(r.cache_write_tokens) AS cache_write_tokens,
    SUM(r.cost_usd_nano) AS cost_nano,
    SUM(CASE WHEN r.cost_usd_nano IS NULL THEN 1 ELSE 0 END) AS unpriced_requests,
    CASE WHEN SUM(CASE WHEN r.ttft_ms IS NOT NULL THEN 1 ELSE 0 END) > 0
         THEN SUM(COALESCE(r.ttft_ms, 0)) / SUM(CASE WHEN r.ttft_ms IS NOT NULL THEN 1 ELSE 0 END)
         ELSE NULL END AS ttft_avg_ms
  `;

  /** 组装 WHERE 子句：conds 非空时返回 ' WHERE a AND b'；"全部"时间窗（days=0）无时间条件。 */
  function whereClause(conds) {
    return conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  }

  /* ---- 提供方映射辅助（provider_id → 供应商 vendor，聚合按 vendor 归并） ---- */
  let providerMap = store.getProviderMappings();
  /** provider_id → 供应商 id（未映射原样返回 id）。 */
  function vendorOf(id) {
    const m = providerMap[id];
    return m ? m.vendor : (id || 'unknown');
  }

  const ROUTES = [
    {
      // 按天 × 模型汇总：session 聚焦读 rollup 的 session_id 维度（会话历史永久，
      // 不受明细清理影响）；当天读明细（实时写入）；多天读 rollup。
      // days=0（"全部"）不带时间条件。
      path: '/token-monitor/usage/daily',
      handle(days, url) {
        const f = parseFilters(url);
        if (f.session) {
          // 聚焦会话：读 rollup 的 session_id 维度（DSH 会话历史永久，不受明细清理影响；
          // CC 行 session_id 恒 ''，不会被真实会话命中）
          const conds = [];
          const args = [];
          if (days !== 0) { conds.push('day >= ?'); args.push(windowStartDay(days)); }
          conds.push('session_id = ?'); args.push(f.session);
          if (f.client) { conds.push('client = ?'); args.push(f.client); }
          {
            const pc = providerCond(f, '');
            if (pc) { conds.push(pc.sql); args.push(...pc.args); }
          }
          if (f.model) { conds.push('model = ?'); args.push(f.model); }
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
            FROM usage_daily_rollups${whereClause(conds)}
            GROUP BY day, model
            ORDER BY day
          `).all(...args);
          return rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
        }
        if (days === 1) {
          const conds = [];
          const args = [];
          conds.push('r.day >= ?'); args.push(windowStartDay(days));
          if (f.client) { conds.push('r.client = ?'); args.push(f.client); }
          {
            const pc = providerCond(f, 'r');
            if (pc) { conds.push(pc.sql); args.push(...pc.args); }
          }
          if (f.model) { conds.push('r.model = ?'); args.push(f.model); }
          const rows = store.db.prepare(`
            SELECT r.day, r.model, ${AGG_DETAIL}
            FROM usage_requests r${whereClause(conds)}
            GROUP BY r.day, r.model
            ORDER BY r.day
          `).all(...args);
          return rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
        }
        const conds = [];
        const args = [];
        if (days !== 0) { conds.push('day >= ?'); args.push(windowStartDay(days)); }
        if (f.client) { conds.push('client = ?'); args.push(f.client); }
        {
          const pc = providerCond(f, '');
          if (pc) { conds.push(pc.sql); args.push(...pc.args); }
        }
        if (f.model) { conds.push('model = ?'); args.push(f.model); }
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
          FROM usage_daily_rollups${whereClause(conds)}
          GROUP BY day, model
          ORDER BY day
        `).all(...args);
        return rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
      },
    },
    {
      // 按模型汇总：读 rollup（client 列已纳入主键，筛选/历史全覆盖；毫秒级）。
      // days=0（"全部"）不带时间条件。
      path: '/token-monitor/usage/by-model',
      handle(days, url) {
        const f = parseFilters(url);
        if (f.session) {
          // 聚焦会话：选项只显示该会话实际用过的模型/供应商（读 rollup 的 session_id 维度）
          const conds = [];
          const args = [];
          conds.push('session_id = ?'); args.push(f.session);
          if (f.client) { conds.push('client = ?'); args.push(f.client); }
          {
            const pc = providerCond(f, '');
            if (pc) { conds.push(pc.sql); args.push(...pc.args); }
          }
          if (f.model) { conds.push('model = ?'); args.push(f.model); }
          const rows = store.db.prepare(`
            SELECT model, provider, client,
                   SUM(requests) AS requests,
                   SUM(input_tokens) AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(cache_read_tokens) AS cache_read_tokens,
                   SUM(cache_write_tokens) AS cache_write_tokens,
                   SUM(cost_usd_nano) AS cost_nano,
                   SUM(unpriced_requests) AS unpriced_requests,
                   CASE WHEN SUM(ttft_count) > 0 THEN SUM(ttft_sum_ms) / SUM(ttft_count) ELSE NULL END AS ttft_avg_ms
            FROM usage_daily_rollups${whereClause(conds)}
            GROUP BY model, provider, client
            ORDER BY cost_nano DESC
          `).all(...args);
          return rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_nano), cost_nano: undefined }));
        }
        const conds = [];
        const args = [];
        if (days !== 0) { conds.push('day >= ?'); args.push(windowStartDay(days)); }
        if (f.client) { conds.push('client = ?'); args.push(f.client); }
        {
          const pc = providerCond(f, '');
          if (pc) { conds.push(pc.sql); args.push(...pc.args); }
        }
        if (f.model) { conds.push('model = ?'); args.push(f.model); }
        const rows = store.db.prepare(`
          SELECT model, provider, client,
                 SUM(requests) AS requests,
                 SUM(input_tokens) AS input_tokens,
                 SUM(output_tokens) AS output_tokens,
                 SUM(cache_read_tokens) AS cache_read_tokens,
                 SUM(cache_write_tokens) AS cache_write_tokens,
                 SUM(cost_usd_nano) AS cost_nano,
                 SUM(unpriced_requests) AS unpriced_requests,
                 CASE WHEN SUM(ttft_count) > 0 THEN SUM(ttft_sum_ms) / SUM(ttft_count) ELSE NULL END AS ttft_avg_ms
          FROM usage_daily_rollups${whereClause(conds)}
          GROUP BY model, provider, client
          ORDER BY cost_nano DESC
        `).all(...args);
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
      // 分页请求记录（读明细表，按时间倒序，联查会话标题）
      path: '/token-monitor/usage/requests',
      handle(days, url) {
        const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
        const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('size'), 10) || 10));
        const total = store.db.prepare('SELECT COUNT(*) AS c FROM usage_requests').get().c;
        const rows = store.db.prepare(`
          SELECT r.record_id, r.created_at, r.provider, r.model, r.client, r.source,
                 r.session_id, w.title,
                 r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
                 r.cost_usd_nano, r.ttft_ms
          FROM usage_requests r
          LEFT JOIN fold_watermarks w ON w.session_id = r.session_id
          ORDER BY r.created_at DESC
          LIMIT ? OFFSET ?
        `).all(size, (page - 1) * size);
        return {
          total, page, size,
          rows: rows.map((r) => ({ ...r, cost_usd: toUsd(r.cost_usd_nano), cost_usd_nano: undefined })),
        };
      },
    },
    {
      // 供应商排序键：首次使用时间（MIN(created_at)）——与配置项名称无关，
      // 第三方网关实际用了谁记的就是谁；供"累计消耗"图排序
      path: '/token-monitor/usage/provider-order',
      handle() {
        return store.db.prepare(`
          SELECT provider, MIN(created_at) AS first_use
          FROM usage_requests
          GROUP BY provider
        `).all();
      },
    },
    {
      // "当天"趋势图数据：服务端一次处理到位——读分钟级原始聚合 → 算数据区间 →
      // 按区间选颗粒度（保证 ≥12 桶，不够向前补桶）→ 分桶 → 返回渲染就绪封装。
      // 前端只消费 buckets 渲染，不参与任何聚合/颗粒度计算。
      path: '/token-monitor/usage/hourly',
      handle(days, url) {
        const day = url.searchParams.get('day') || dayOf(Date.now());
        const f = parseFilters(url);
        const w = filterWhere(f);
        // 1) 分钟级最细聚合（服务端固定，不接收颗粒度参数）
        const rows = store.db.prepare(`
          SELECT CAST(strftime('%H', r.created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                 CAST(strftime('%M', r.created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS minute,
                 COUNT(*) AS requests,
                 SUM(r.input_tokens) AS input_tokens,
                 SUM(r.output_tokens) AS output_tokens,
                 SUM(r.cache_read_tokens) AS cache_read_tokens,
                 SUM(r.cache_write_tokens) AS cache_write_tokens,
                 SUM(r.cost_usd_nano) AS cost_nano,
                 SUM(COALESCE(r.ttft_ms, 0)) AS ttft_sum_ms,
                 SUM(CASE WHEN r.ttft_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_count
          FROM usage_requests r
          WHERE r.day = ?${w.sql}
          GROUP BY hour, minute
          ORDER BY hour, minute
        `).all(day, ...w.args);

        const STEPS = [60, 30, 15, 10, 5, 2];
        const MIN_BUCKETS = 12;
        // 刻度 = 桶结束点：endMin 相对今天 00:00 的分钟数（可为负=昨天），跨天带日期前缀
        const now = new Date();
        const p2 = (x) => String(x).padStart(2, '0');
        const labelOf = (endMin) => {
          const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const dt = new Date(base.getTime() + endMin * 60000);
          const hhmm = `${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
          if (dt.getDate() !== now.getDate() || dt.getMonth() !== now.getMonth()) {
            return `${p2(dt.getMonth() + 1)}-${p2(dt.getDate())} ${hhmm}`;
          }
          return hhmm;
        };

        // 2) 无数据：固定 24 桶（01:00~24:00）全 0，渲染就绪
        if (!rows.length) {
          const empty = [];
          for (let e = 1; e <= 24; e++) empty.push({
            day: `${p2(e)}:00`, requests: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ttft: null,
          });
          return { step: 60, crossDay: false, start: '01:00', end: '24:00', buckets: empty };
        }

        // 3) 数据区间（分钟序号 0..1439）
        const firstIdx = rows[0].hour * 60 + rows[0].minute;
        const lastIdx = rows[rows.length - 1].hour * 60 + rows[rows.length - 1].minute;

        // 4) 按区间选颗粒度：区间内桶数 ≥ MIN_BUCKETS；都不够用最小粒度
        let step = 60;
        let found = false;
        for (const s of STEPS) {
          if (Math.ceil((lastIdx - firstIdx + 1) / s) >= MIN_BUCKETS) { step = s; found = true; break; }
        }
        if (!found) step = STEPS[STEPS.length - 1];

        // 5) 桶边界：区间桶数够 → 数据起点所在桶起；不够 → 向前补桶，
        //    但起点最低到今天 00:00（桶 0）——当天图不应出现昨天刻度
        //    （数据本身 WHERE r.day=今天 不跨天，跨天只是补桶假象）。
        const firstBucket = Math.floor(firstIdx / step);
        const lastBucket = Math.floor(lastIdx / step);
        const needPad = (lastBucket - firstBucket + 1) < MIN_BUCKETS;
        const startBucket = Math.max(0, needPad ? lastBucket - MIN_BUCKETS + 1 : firstBucket);
        const bucketCount = lastBucket - startBucket + 1; // 当天刚过 00:00 时可能 < MIN_BUCKETS

        // 6) 分钟数据归入目标桶（全局桶序号 = 分钟序号 / step）
        const bucketMap = {};
        for (const r of rows) {
          const idx = r.hour * 60 + r.minute;
          const b = Math.floor(idx / step);
          let entry = bucketMap[b];
          if (!entry) entry = bucketMap[b] = { requests: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ttftSum: 0, ttftCount: 0 };
          entry.requests += r.requests || 0;
          entry.cost += (r.cost_nano || 0) / 1e9;
          entry.input += r.input_tokens || 0;
          entry.output += r.output_tokens || 0;
          entry.cacheRead += r.cache_read_tokens || 0;
          entry.cacheWrite += r.cache_write_tokens || 0;
          entry.ttftSum += r.ttft_sum_ms || 0;
          entry.ttftCount += r.ttft_count || 0;
        }

        // 7) 生成桶数组（含补出的空桶）
        const buckets = [];
        for (let b = startBucket; b < startBucket + bucketCount; b++) {
          const s = bucketMap[b] || { requests: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          const ttft = s.ttftCount > 0 ? s.ttftSum / s.ttftCount : null;
          buckets.push({ day: labelOf((b + 1) * step), ...s, ttft });
        }
        return {
          step, crossDay: startBucket < 0,
          start: buckets[0].day, end: buckets[buckets.length - 1].day,
          buckets,
        };
      },
    },
    {
      // 消耗分布柱状图：服务端聚合好渲染就绪结构——供应商排序（DeepSeek 优先→首字母→首次使用）、
      // 全部模型（按供应商分组连续，不 Top8 截断）、供应商×模型 token 矩阵、供应商费用/请求次数合计。
      // 读 rollup（历史全量，不受明细清理/CC 迁移影响）；token 统一四桶口径。
      // 前端只按 metric 切换显示 costs/requests，不参与聚合。
      path: '/token-monitor/usage/distribution',
      handle() {
        const rows = store.db.prepare(`
          SELECT provider, model,
                 SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
                 SUM(cost_usd_nano) AS cost_nano,
                 SUM(requests) AS requests
          FROM usage_daily_rollups
          GROUP BY provider, model
        `).all();
        if (!rows.length) return { providers: [], models: [], tokens: {}, costs: {}, requests: {} };

        const provTok = {}, modelTok = {}, tokens = {}, costs = {}, requests = {};
        // 每个 vendor 的完整模型构成（model → tokens，降序），tooltip 展示与柱状图一致
        const vendorModels = {};
        for (const r of rows) {
          const p = r.provider || 'unknown';
          const v = vendorOf(p); // 提供方 → 供应商（vendor），聚合按供应商归并
          const m = r.model || 'unknown';
          const t = r.tokens || 0;
          provTok[v] = (provTok[v] || 0) + t;
          modelTok[m] = (modelTok[m] || 0) + t;
          costs[v] = (costs[v] || 0) + (r.cost_nano || 0);
          requests[v] = (requests[v] || 0) + r.requests;
          vendorModels[v] = vendorModels[v] || {};
          vendorModels[v][m] = (vendorModels[v][m] || 0) + t;
        }
        // 供应商首次使用（首字母相同时的次级排序键）：rollup 无 created_at，用最早 day（按 vendor 归并）
        const firstUse = {};
        const firstRows = store.db.prepare(`
          SELECT provider, MIN(day) AS first_use FROM usage_daily_rollups GROUP BY provider
        `).all();
        for (const r of firstRows) {
          const v = vendorOf(r.provider);
          if (firstUse[v] === undefined || r.first_use < firstUse[v]) firstUse[v] = r.first_use;
        }
        // 供应商排序：DeepSeek 永远第一 → 首字母 → 首字母相同按首次使用
        const providers = Object.keys(provTok).sort((a, b) => {
          const pa = a === 'deepseek' ? 0 : 1;
          const pb = b === 'deepseek' ? 0 : 1;
          if (pa !== pb) return pa - pb;
          const alpha = a.localeCompare(b);
          if (alpha !== 0) return alpha;
          return (firstUse[a] ?? Infinity) - (firstUse[b] ?? Infinity);
        });
        // 模型顺序：按供应商分组连续，供应商内按模型名排序；全部模型都渲染（不 Top8 截断、不归并"其他"）
        const modelProv = {};
        for (const r of rows) modelProv[r.model || 'unknown'] = vendorOf(r.provider || 'unknown');
        const models = [];
        for (const p of providers) {
          const inProv = Object.keys(modelTok).filter((m) => modelProv[m] === p)
            .sort((a, b) => a.localeCompare(b));
          for (const m of inProv) models.push(m);
        }
        // token 矩阵：每个模型归自身（按 vendor 归并；不合并"其他"）
        for (const r of rows) {
          const v = vendorOf(r.provider || 'unknown');
          const m = r.model || 'unknown';
          tokens[v] = tokens[v] || {};
          tokens[v][m] = (tokens[v][m] || 0) + (r.tokens || 0);
        }
        return {
          providers, models, tokens,
          costs: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, v / 1e9])),
          requests,
          // model → vendor id（前端按供应商色系给模型分配颜色）
          modelVendor: Object.fromEntries(Object.entries(modelProv)),
          // vendor → 完整模型构成（model → tokens，降序），tooltip 展示与柱状图一致
          vendorModels: Object.fromEntries(Object.entries(vendorModels).map(([v, mm]) => [
            v,
            Object.entries(mm).sort((a, b) => b[1] - a[1]).map(([m, t]) => ({ model: m, tokens: t })),
          ])),
        };
      },
    },
    {
      // 年度消耗热力图：服务端算好按天聚合（token 四桶 + 请求数）+ 日期序列（近 12 个月，
      // 首尾周补齐、跨月标签隐藏的 overflowYM/leadingYM）。读 rollup——历史全量覆盖
      // （不受 60 天明细清理影响；CC 迁移的 6 月归档历史也能显示）。前端只消费渲染。
      path: '/token-monitor/usage/calendar',
      handle() {
        const start = windowStartDay(365);
        const rows = store.db.prepare(`
          SELECT day,
                 SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
                 SUM(requests) AS requests
          FROM usage_daily_rollups
          WHERE day >= ?
          GROUP BY day
        `).all(start);
        const byDay = {};
        let maxTok = 0;
        for (const r of rows) {
          const t = r.tokens || 0;
          byDay[r.day] = { tokens: t, requests: r.requests || 0 };
          if (t > maxTok) maxTok = t;
        }
        // 日期序列：近 12 个月（起始月 1 号向上补齐到周一；结束到本月最后一天所在周的周日）
        const p2 = (x) => String(x).padStart(2, '0');
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
        const padStartDays = (startDate.getDay() + 6) % 7;
        const displayStart = new Date(startDate.getTime() - padStartDays * 86400000);
        const leadingYM = padStartDays > 0
          ? `${displayStart.getFullYear()}-${p2(displayStart.getMonth() + 1)}` : '';
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const padDays = (7 - monthEnd.getDay()) % 7;
        const endDate = new Date(monthEnd.getTime() + padDays * 86400000);
        const dayList = [];
        for (let dt = new Date(displayStart); dt <= endDate; dt = new Date(dt.getTime() + 86400000)) {
          dayList.push(`${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`);
        }
        const overflowYM = padDays > 0 && endDate.getMonth() !== monthEnd.getMonth()
          ? `${endDate.getFullYear()}-${p2(endDate.getMonth() + 1)}` : '';
        return {
          byDay, dayList, maxTok,
          rangeStart: `${displayStart.getFullYear()}-${p2(displayStart.getMonth() + 1)}-${p2(displayStart.getDate())}`,
          rangeEnd: `${endDate.getFullYear()}-${p2(endDate.getMonth() + 1)}-${p2(endDate.getDate())}`,
          overflowYM, leadingYM,
        };
      },
    },
    {
      // 使用排行：服务端按 模型/供应商/客户端 三个维度各聚合一次，一次返回全部维度，
      // 前端切维度零请求。每行含维度名（id）、用量、费用、TTFT 加权均值、以及该组的
      // 模型/供应商/客户端 id 集合（供组合列显示），按 token 总量降序。
      path: '/token-monitor/usage/rank',
      handle() {
        // 历史全量（读 rollup：client 列已纳入主键，model/provider/client 三维度全覆盖，
        // 不受明细清理影响；CC 迁移的 6 月归档历史计入）
        const rows = store.db.prepare(`
          SELECT model, provider, client,
                 SUM(requests) AS requests,
                 SUM(input_tokens) AS input_tokens,
                 SUM(output_tokens) AS output_tokens,
                 SUM(cache_read_tokens) AS cache_read_tokens,
                 SUM(cache_write_tokens) AS cache_write_tokens,
                 SUM(cost_usd_nano) AS cost_nano,
                 CASE WHEN SUM(ttft_count) > 0 THEN SUM(ttft_sum_ms) / SUM(ttft_count) ELSE NULL END AS ttft_avg_ms
          FROM usage_daily_rollups
          GROUP BY model, provider, client
        `).all();
        if (!rows.length) return { model: [], provider: [], client: [] };

        const tokOf = (r) => (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
        const groupDim = (keyOf) => {
          const map = {};
          for (const r of rows) {
            const k = keyOf(r) || 'unknown';
            let g = map[k];
            if (!g) g = map[k] = {
              name: k, requests: 0, input_tokens: 0, output_tokens: 0,
              cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0,
              ttftSum: 0, ttftCount: 0, models: [], providers: [], clients: [],
            };
            g.requests += r.requests || 0;
            g.input_tokens += r.input_tokens || 0;
            g.output_tokens += r.output_tokens || 0;
            g.cache_read_tokens += r.cache_read_tokens || 0;
            g.cache_write_tokens += r.cache_write_tokens || 0;
            g.cost_usd += (r.cost_nano || 0) / 1e9;
            if (r.ttft_avg_ms != null) { g.ttftSum += r.ttft_avg_ms * (r.requests || 0); g.ttftCount += r.requests || 0; }
            if (g.models.indexOf(r.model) < 0) g.models.push(r.model);
            if (g.providers.indexOf(r.provider) < 0) g.providers.push(r.provider);
            if (g.clients.indexOf(r.client) < 0) g.clients.push(r.client);
          }
          return Object.keys(map).map((k) => {
            const g = map[k];
            return {
              name: g.name, requests: g.requests,
              input_tokens: g.input_tokens, output_tokens: g.output_tokens,
              cache_read_tokens: g.cache_read_tokens, cache_write_tokens: g.cache_write_tokens,
              cost_usd: g.cost_usd,
              ttft_avg_ms: g.ttftCount > 0 ? g.ttftSum / g.ttftCount : null,
              models: g.models, providers: g.providers, clients: g.clients,
            };
          }).sort((a, b) => tokOf(b) - tokOf(a));
        };
        return {
          model: groupDim((r) => r.model),
          // 供应商维度按 vendor 聚合（kimi-coding + moonshotai-cn 合并为 kimi）；
          // name = vendor id，前端 vendorLabel 映射展示名；providers 集合保留原始 provider id 供组合列展开
          provider: groupDim((r) => vendorOf(r.provider)),
          client: groupDim((r) => r.client),
        };
      },
    },
  ];

  // 数据来源路径（页面底部"数据说明"展示用）：DSH 会话日志目录、cc-switch 数据库路径。
  // POST 同路由可打开对应目录（{ source: 'dsh' | 'cc' }），浏览器无法直接打开本地目录，需服务端代开。
  ctx.effect(() => {
    const dirs = {
      dsh: path.join(dshHome, 'sessions'),
      cc: path.dirname(ccDbPath),
    };
    const opener = process.platform === 'win32'
      ? ['explorer', (dir) => [dir]]
      : process.platform === 'darwin'
        ? ['open', (dir) => [dir]]
        : ['xdg-open', (dir) => [dir]];
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/usage/sources',
      handler: async (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          let source = '';
          try { source = JSON.parse(body || '{}').source || ''; } catch { /* 忽略 */ }
          const dir = dirs[source];
          if (!dir || !fs.existsSync(dir)) {
            sendJson(res, 400, { ok: false, error: source ? `目录不存在：${dir}` : '未知来源' });
            return;
          }
          try {
            spawn(opener[0], opener[1](dir), { detached: true, stdio: 'ignore' }).unref();
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) });
          }
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET, POST' });
          res.end();
          return;
        }
        // 汇率：首次/到点触发拉取（失败保留现值兜底），随 sources 下发供前端费用换算
        await refreshUsdCnyRate();
        sendJson(res, 200, {
          ok: true,
          dshSessions: dirs.dsh,
          ccSwitchDb: ccDbPath,
          usdCnyRate,
          rateFetchedAt,
        });
      },
    });
    ctx.logger.info('token-monitor: 数据来源路由已注册 GET/POST /token-monitor/usage/sources');
    return dispose;
  }, 'token-monitor: sources route');

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
          // 纯数据库查询：不触发日志折叠（折叠只由 定时器 / 手动刷新 / 页面打开后后台触发）
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

  // 手动触发一轮日志折叠（定时器之外的另一驱动：页面打开后后台调用、手动刷新按钮）
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/fold',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        try {
          const result = await foldOnce();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    });
    ctx.logger.info('token-monitor: 手动折叠路由已注册 POST /token-monitor/fold');
    return dispose;
  }, 'token-monitor: fold route');

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/import/cc-switch',
        handler: async (req, res) => {
          // POST=导入；DELETE=清空本插件库中 CC 来源的数据（可重新导入恢复）
          if (req.method === 'DELETE') {
            try {
              const deleted = store.deleteBySource('cc-switch');
              sendJson(res, 200, { ok: true, deleted });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) });
            }
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST, DELETE' });
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
      // SQL 文件导入（§2.2 用量页"导入"入口，跨设备手动导入）：body 为文件内容（UTF-8 文本），
      // 由 importCcSqlFile 解析 proxy_request_logs 的 INSERT 语句导入。
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/import/cc-switch/sql',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          try {
            // 保存到临时文件（importCcSqlFile 按文件读；内容大时避免整块驻留内存）
            const tmp = path.join(os.tmpdir(), `cc-import-${Date.now()}.sql`);
            const ws = fs.createWriteStream(tmp);
            for await (const chunk of req) ws.write(chunk);
            await new Promise((resolve, reject) => { ws.end(resolve); ws.on('error', reject); });
            try {
              const result = importCcSqlFile(store, tmp, ctx.logger, pricing);
              sendJson(res, result.error ? 400 : 200, { ok: !result.error, ...result });
            } finally {
              fs.promises.unlink(tmp).catch(() => {});
            }
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
