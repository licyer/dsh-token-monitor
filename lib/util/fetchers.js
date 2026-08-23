/**
 * dsh-token-monitor — 供应商余量/额度抓取器。
 *
 * 每个提供方一个 fetchXxx(ctx, config)，返回统一形状：
 *   { id, label, kind, ok, headline?, metrics?, stats?, badge?, modelLabels?, error?, endpoint?, raw?, configured? }
 * - configured:false = 凭证未配置（overview 不过滤，前端展示"未配置 key"文案）
 * - raw 是截断后的原始响应（至多 4KB），用于在线校准解析规则
 * - config 来自 cordis.yml 本行 providers.<id>（可覆盖 baseUrl/url）
 *
 * 新增提供方：在这里加 fetchXxx + 挂进 FETCHERS 即可（服务端抓取，凭证不离开 Host）。
 */

import { fetchJson, truncateRaw, errorText } from './http.js';

/* ------------------------------ 凭证解析 ------------------------------ */

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
  // configured:false = 未配置凭证——overview 不过滤（配置了提供方就显示），前端展示"未配置 key"错误文案（自适应已配置项）
  if (!key) return { ...base, ok: false, configured: false, error: '未配置 DEEPSEEK_API_KEY' };

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

/* -------------------- Moonshot 国内站（moonshotai-cn）余额 --------------------
 * 月之暗面开放平台（platform.moonshot.cn）：按量付费余额。
 * 端点 GET {baseUrl}/v1/users/me/balance，Bearer 凭证（apiKeyEnv=MOONSHOTAI_CN_API_KEY）。
 * 响应 { data: { available_balance, voucher_balance, cash_balance, ... } }（单位：元）。
 * 已纳入 provider_mappings：moonshotai-cn → vendor kimi（与 kimi-coding 聚合为月之暗面）。
 */

const MOONSHOT_CN_BASE = 'https://api.moonshot.cn';
const MOONSHOT_CN_BALANCE_PATH = '/v1/users/me/balance';

async function fetchMoonshotAiCn(ctx, config) {
  const base = { id: 'moonshotai-cn', label: 'Moonshot AI（CN）', kind: 'balance' };
  const key = await resolveCredential(ctx, 'MOONSHOTAI_CN_API_KEY');
  if (!key) return { ...base, ok: false, configured: false, error: '未配置 MOONSHOTAI_CN_API_KEY' };

  const baseUrl = (config.baseUrl || MOONSHOT_CN_BASE).replace(/\/+$/, '');
  const candidates = config.url ? [config.url] : [`${baseUrl}${MOONSHOT_CN_BALANCE_PATH}`];
  let lastError = '无可用端点';
  for (const url of candidates) {
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
    if (res.status === 401 || res.status === 403) {
      return { ...base, ok: false, endpoint: url, error: `凭证被拒绝（HTTP ${res.status}）`, raw: truncateRaw(res.data ?? res.text) };
    }
    if (!res.ok || !res.data) {
      return { ...base, ok: false, endpoint: url, error: `HTTP ${res.status}`, raw: truncateRaw(res.data ?? res.text) };
    }
    // 兼容两种响应形态：{ data: {...} }（Moonshot 官方）或平铺对象
    const root = res.data;
    const bal = (root && root.data && typeof root.data === 'object') ? root.data : root;
    const avail = typeof bal.available_balance === 'number' ? bal.available_balance : null;
    // 金额格式与 DeepSeek 一致：主金额带币种（如 49.59 CNY），detail 里不再重复币种
    const fmtVal = (n) => (typeof n === 'number' ? `${n.toFixed(2)} CNY` : '—');
    const fmtNum = (n) => (typeof n === 'number' ? n.toFixed(2) : '—');
    const metrics = [{
      label: '可用余额',
      value: fmtVal(avail),
      detail: `现金 ${fmtNum(bal.cash_balance)} · 代金券 ${fmtNum(bal.voucher_balance)}`,
    }];
    return {
      ...base,
      ok: true,
      endpoint: url,
      headline: avail !== null ? `${avail.toFixed(2)} CNY` : '—',
      metrics,
      raw: truncateRaw(bal),
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
  // configured:false = 未配置凭证——overview 不过滤（配置了提供方就显示），前端展示"未配置 key"错误文案
  if (!key) return { ...base, ok: false, configured: false, error: '未配置 KIMI_CODING_API_KEY' };

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
  // headline 供徽标/全部提供方；stats.labels 供余量组合显示简称（5h/7d/30d）
  const headline = rolling ? `5h ${rolling.pct}%` : (weekly ? `7d ${weekly.pct}%` : (monthly ? `30d ${monthly.pct}%` : '已连接'));
  return { headline, metrics, stats: { window: rolling, weekly, monthly, labels: { window: '5h', weekly: '7d', monthly: '30d' } } };
}

async function fetchOpencodeGo(ctx, config) {
  // id 用 DSH 路由名 'opencode-go'（settings.yaml llm-pi-ai.providers.opencode-go），
  // 与徽标定位（PROVIDER_ALIASES 直查 current.provider）对齐，避免"未配置监控"。
  const base = { id: 'opencode-go', label: 'OpenCode', kind: 'quota' };
  const key = await resolveCredential(ctx, 'OPENCODE_GO_API_KEY');
  // configured:false = 未配置凭证——overview 不过滤（配置了提供方就显示），前端展示"未配置 key"错误文案
  if (!key) return { ...base, ok: false, configured: false, error: '未配置 OPENCODE_GO_API_KEY' };

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

/* ---------------------------- 抓取器注册表 ---------------------------- */

/** provider id（normalizeProvider 归一后）→ 抓取器。新增提供方在这里登记。 */
export const FETCHERS = {
  'kimi-coding': fetchKimi,
  'moonshotai-cn': fetchMoonshotAiCn,
  deepseek: fetchDeepSeek,
  'opencode-go': fetchOpencodeGo,
};
