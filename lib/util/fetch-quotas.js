/**
 * dsh-token-monitor — 供应商余量/额度抓取器。
 *
 * 每个提供方一个 fetchXxx(ctx, config)，返回余量快照 v2（契约见 quota-snapshot.js）：
 *   { providerId, billingType: 'quota'|'balance', status, message?,
 *     quota?: { plan?, timeWindows[], extraQuotas? }, balance?: { amount, currency, accounts?, alertThreshold?, spending? } }
 * - 各家自行解析原始响应并直接产出合规结构；中心只做 validate() 与聚合。
 * - status 用 STATUS 常量（1 = 成功且有数据；2-7 为非成功状态）。
 * - message 仅限白名单文案，原始响应/HTTP 细节留给日志。
 * - config 来自 cordis.yml 本行 providers.<id>（可覆盖 baseUrl/url）。
 *
 * 新增提供方：在这里加 fetchXxx + 挂进 FETCHERS 即可（服务端抓取，凭证不离开 Host）。
 */

import { fetchJson, errorText } from './http.js';
import { fetchChatgptCodex } from './chatgpt-codex.js';
import { STATUS } from './quota-snapshot.js';

/** 数值解析：字符串/数字 → number 或 null。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 百分比解析并夹取 0-100（字符串百分比常见于各家响应）。 */
function pctNum(v) {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

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
  const base = { providerId: 'deepseek', billingType: 'balance' };
  const key = await resolveCredential(ctx, 'DEEPSEEK_API_KEY');
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

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
    if (res.status === 401 || res.status === 403) {
      return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
    }
    if (!res.ok || !res.data) {
      return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
    }
    const data = res.data;
    // 账户结构：[{ currency, total_balance, topped_up_balance, granted_balance }]
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    const accounts = infos
      .filter((info) => info && typeof info.currency === 'string' && info.currency)
      .map((info) => ({
        label: info.currency === 'CNY' ? '人民币账户' : `${info.currency} 账户`,
        amount: money(info.total_balance),
        currency: info.currency,
        recharged: money(info.topped_up_balance),
        granted: money(info.granted_balance),
      }));
    // 没有任何账户数据：拿不到余额数字，按"无有效额度数据"处理（不编造 0）
    if (!accounts.length) {
      return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
    }
    const primary = accounts.find((a) => a.currency === 'CNY') || accounts[0];
    return {
      ...base,
      status: STATUS.OK,
      balance: { amount: primary.amount, currency: primary.currency, accounts },
    };
  }
  return { ...base, status: STATUS.REQUEST_FAILED, message: lastError };
}

/* -------------------- DeepSeek 账号渠道（deepseek-account）余额 --------------------
 * 桌面版账号登录渠道（DSH 0.1.7+ 桌面端登录后注册该路由）。数据走宿主
 * `deepseekAccount` 服务（dsh-deepseek-account-platform 提供）：
 *   - getState()   → { status, links:{ usageUrl, topUpUrl } }
 *   - getBalance(client) → { status:"ready", value: normal_wallets, bonusWallets }
 *     （normal_wallets = 充值钱包 [{currency, balance}]，bonusWallets = 赠送钱包）
 * 底层为 platform.deepseek.com 的 get_user_summary，grant token 不离开 Host。
 * web 端（命令行 dsh）三层天然隔离：未登录时路由不注册（fetcher 不会被调用）、
 * 无 deepseekAccount 服务（这里兜底 unsupported）、无 grant（getBalance 返回 null）。
 * client 参数是平台请求身份头（x-client-version/locale/timezone），仅元信息。
 *
 * 余额预警线（balance_alert）：用户账号设置里"余额不足提醒"的阈值。宿主的
 * getProfile 已把该字段裁剪掉（只留 id/头像/昵称），所以这里自己持 grant token
 * 调 /auth-api/v0/users/current 读取。失败不影响主流程（前端回退固定阈值）。
 */

const ACCOUNT_PLATFORM_ORIGIN = 'https://platform.deepseek.com';

/** 读账号 grant token（credentials 的 records 表，deepseek-account-platform/default）。 */
async function readAccountGrantToken(ctx) {
  try {
    const creds = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (!creds || typeof creds.readRecord !== 'function') return null;
    const rec = await creds.readRecord('deepseek-account-platform/default');
    const token = rec && rec.kind === 'grant' && rec.payload && rec.payload.token;
    return typeof token === 'string' && token ? token : null;
  } catch { return null; }
}

/** 平台账号 API 请求头（与宿主 accountHeaders + platformClientHeaders 同构；仅元信息）。 */
function accountPlatformHeaders(token) {
  return {
    'x-dsh-auth-token': token,
    'x-client-bundle-id': '',
    'x-client-platform': 'desktop-win',
    'x-client-version': '0.1.7',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

/**
 * 读账号接口的 biz_data：平台响应包壳 { code, data: { biz_code, biz_data } }。
 * 401 → 哨兵 'unauthorized'（grant 失效/未登录）；网络/解析失败 → null。
 */
async function readAccountBiz(ctx, path) {
  const token = await readAccountGrantToken(ctx);
  if (!token) return null;
  try {
    const res = await fetchJson(`${ACCOUNT_PLATFORM_ORIGIN}${path}`, accountPlatformHeaders(token));
    if (res && res.status === 401) return 'unauthorized';
    if (!res || !res.ok || !res.data) return null;
    const biz = res.data.data && res.data.data.biz_data;
    return biz && typeof biz === 'object' ? biz : null;
  } catch { return null; }
}

/** 解析余额预警线：{ [currency]: { enabled, bound } }（如 CNY: {enabled:true, bound:5}）。 */
function parseBalanceAlert(biz) {
  const alert = biz && typeof biz.balance_alert === 'object' ? biz.balance_alert : null;
  if (!alert) return null;
  const out = {};
  for (const [cur, v] of Object.entries(alert)) {
    if (!v || typeof v !== 'object') continue;
    const bound = Number(v.alert_bound);
    out[cur] = { enabled: v.enabled === true, bound: Number.isFinite(bound) ? bound : null };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 金额格式化：平台返回高精度字符串（如 7.1464502000000000），按分取 2 位。
 *
 * 两条硬约束：
 *  1. 用**截断**而非 toFixed（四舍五入）——这是 DeepSeek 官方口径：官方 API
 *     （api.deepseek.com/user/balance）对该余额返回 "7.14"，正好等于截断值；
 *     toFixed 会得到 "7.15"，于是账号渠道与 API key 渠道显示不一致（同一账户两个数）。
 *     累计消费同理（509.8535498 → 官方 509.85）。
 *  2. 必须**走字符串截断**，不能用 n*100 取整：二进制浮点下 7.14*100 = 713.9999…，
 *     Math.floor 会把它截成 7.13（本来是整数分却被削掉一分）。
 */
function fmtMoney(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return String(s ?? '—');
  const fixed = Math.abs(n).toFixed(10);       // 足够位数，规避二进制表示误差
  const cut = fixed.slice(0, fixed.indexOf('.') + 3);
  return (n < 0 ? '-' : '') + cut;
}

/**
 * 金额 → 分精度数字（走 fmtMoney 的字符串截断，与官方口径一致）。
 * 非数字（缺失/占位符）一律返回 0，避免把 NaN 写进快照。
 */
function money(v) {
  const n = Number(fmtMoney(v));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 钱包数组 → v2 balance。
 * 按币种聚合 充值(normal) + 赠送(bonus)：amount = 两者之和，recharged/granted 分别保留，
 * costs 提供时附 spent（累计消费）；alert 提供时取 CNY 优先的预警线。
 * 没有任何币种时返回 null（由调用方判定为"无有效额度数据"）。
 */
function buildBalanceFromWallets(normal, bonus, costs, alert) {
  const currencies = [];
  for (const w of [...(normal || []), ...(bonus || [])]) {
    if (w && typeof w.currency === 'string' && w.currency && !currencies.includes(w.currency)) {
      currencies.push(w.currency);
    }
  }
  if (!currencies.length) return null;
  // CNY 排最前（人民币账户优先）
  currencies.sort((a, b) => (a === 'CNY' ? -1 : b === 'CNY' ? 1 : 0));
  const accounts = currencies.map((cur) => {
    const n = (normal || []).find((w) => w && w.currency === cur);
    const b = (bonus || []).find((w) => w && w.currency === cur);
    const c = (costs || []).find((w) => w && w.currency === cur);
    const recharged = money(n ? n.balance : 0);
    const granted = money(b ? b.balance : 0);
    return {
      label: cur === 'CNY' ? '人民币账户' : `${cur} 账户`,
      amount: money(recharged + granted),
      currency: cur,
      recharged,
      granted,
      spent: c ? money(c.amount) : undefined,
    };
  });
  const primary = accounts.find((a) => a.currency === 'CNY') || accounts[0];
  const balance = { amount: primary.amount, currency: primary.currency, accounts };
  if (alert) {
    const pick = alert.CNY || alert[Object.keys(alert)[0]];
    if (pick && pick.enabled === true && typeof pick.bound === 'number') {
      balance.alertThreshold = pick.bound;
    }
  }
  return balance;
}

async function fetchDeepSeekAccount(ctx) {
  const base = { providerId: 'deepseek-account', billingType: 'balance' };
  // 宿主账号服务仅作"桌面版已登录环境"的存在性检测（web 端无此服务 → 未适配）
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined;
  if (!account || typeof account.getBalance !== 'function') {
    return { ...base, status: STATUS.UNSUPPORTED };
  }

  // 首选：自调平台接口（全量：钱包 + 累计消费 + 余额预警线）。
  // 预防措施：拿不到认证 token（升级导致 credentials 结构变化等）或网络失败时，
  // 回退官方封装的 getBalance（宿主管 token/401）——基础余额照常渲染，
  // 只是没有累计消费与动态预警线。
  const token = await readAccountGrantToken(ctx);
  if (token) {
    const [summary, current] = await Promise.all([
      readAccountBiz(ctx, '/api/v0/users/get_user_summary'),
      readAccountBiz(ctx, '/auth-api/v0/users/current'),
    ]);
    if (summary === 'unauthorized' || current === 'unauthorized') {
      // token 失效：官方通道读同一凭证同样失效，无需再试
      return { ...base, status: STATUS.NO_CREDENTIAL, message: '账号未登录或凭证失效' };
    }
    if (summary) {
      const balance = buildBalanceFromWallets(
        summary.normal_wallets, summary.bonus_wallets, summary.total_costs, parseBalanceAlert(current),
      );
      if (balance) return { ...base, status: STATUS.OK, balance };
    }
    // summary 为 null 或钱包为空：继续走下方官方通道兜底
  }

  // 回退：官方 getBalance（宿主封装 token 管理）——只有钱包数据（无累计消费/预警线）
  const client = {
    version: '0.1.7',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
  let result;
  try {
    result = await account.getBalance(client);
  } catch (error) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: errorText(error) };
  }
  if (!result || result.status !== 'ready') {
    return { ...base, status: STATUS.NO_CREDENTIAL, message: '账号未登录或凭证失效' };
  }
  const balance = buildBalanceFromWallets(result.value, result.bonusWallets, null, null);
  if (!balance) return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  return { ...base, status: STATUS.OK, balance };
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
  const base = { providerId: 'moonshotai-cn', billingType: 'balance' };
  const key = await resolveCredential(ctx, 'MOONSHOTAI_CN_API_KEY');
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

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
      return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
    }
    if (!res.ok || !res.data) {
      return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
    }
    // 兼容两种响应形态：{ data: {...} }（Moonshot 官方）或平铺对象
    const root = res.data;
    const bal = (root && root.data && typeof root.data === 'object') ? root.data : root;
    // 分项：现金 / 代金券（都是 CNY）
    const accounts = [];
    if (typeof bal.cash_balance === 'number') {
      accounts.push({ label: '现金', amount: money(bal.cash_balance), currency: 'CNY' });
    }
    if (typeof bal.voucher_balance === 'number') {
      accounts.push({ label: '代金券', amount: money(bal.voucher_balance), currency: 'CNY' });
    }
    // 主余额：优先官方可用余额；缺失时用分项之和（都没有则视为无数据）
    const amount = typeof bal.available_balance === 'number'
      ? money(bal.available_balance)
      : (accounts.length ? money(accounts.reduce((sum, a) => sum + a.amount, 0)) : null);
    if (amount === null) {
      return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
    }
    const balance = { amount, currency: 'CNY' };
    if (accounts.length) balance.accounts = accounts;
    return { ...base, status: STATUS.OK, balance };
  }
  return { ...base, status: STATUS.REQUEST_FAILED, message: lastError };
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

/**
 * Kimi 套餐体系：新版 Go/Plus/Pro/Max（无 7 天限制，30 天周期额度 + 加油包）；
 * 旧版 Andante/Moderato/Allegretto/Allegro（5h 滚动窗口 + 7 天用量）。
 * 判断以套餐名为主；名称不认识时按响应结构兜底（usages.limit_month_* 存在 → 新体系）。
 */
const KIMI_NEW_PLANS = new Set(['go', 'plus', 'pro', 'max']);
const KIMI_OLD_PLANS = new Set(['andante', 'moderato', 'allegretto', 'allegro']);

/**
 * 新会员体系解析（2026-09 实测结构）：`usages.limit_5h`（5 小时滚动窗口）/
 * `limit_month_total`（月度总额度），字段为 used_ratio（已用比例 0~1）+ reset_time；
 * `booster_wallet` 为加油包钱包（STATUS_ENABLED/ACTIVE 时才返回余额，禁用态不展示）。
 * 产出 v2 quota 片段（plan / timeWindows / extraQuotas）；无任何有效内容时返回 null。
 */
function parseKimiNewPlan(data, extras = {}) {
  const usages = data.usages || {};
  const mkWindow = (period, u) => {
    if (!u || typeof u !== 'object') return null;
    const ratio = Number(u.used_ratio);
    if (!isFinite(ratio)) return null;
    const win = { period, usedPct: Math.max(0, Math.min(100, Math.round(ratio * 100))) };
    const resetAt = Date.parse(u.reset_time);
    if (isFinite(resetAt)) win.resetAt = resetAt;
    return win;
  };
  const timeWindows = [
    mkWindow('5h', usages.limit_5h),
    mkWindow('month', usages.limit_month_total),
  ].filter(Boolean);
  // 加油包：余额（priceInCents 为分）
  const extraQuotas = [];
  const bw = data.booster_wallet;
  if (bw && (bw.status === 'STATUS_ENABLED' || bw.status === 'STATUS_ACTIVE')) {
    const balRaw = bw.balance && (bw.balance.amount || bw.balance.value || bw.balance.remaining);
    const cents = balRaw && balRaw.priceInCents !== undefined ? Number(balRaw.priceInCents) : NaN;
    if (isFinite(cents)) {
      extraQuotas.push({ label: '加油包', amount: money(cents / 100), currency: 'CNY' });
    }
  }
  const plan = extras.levelName || undefined;
  if (!timeWindows.length && !extraQuotas.length && !plan) return null;
  const quota = {};
  if (plan) quota.plan = plan;
  if (timeWindows.length) quota.timeWindows = timeWindows;
  if (extraQuotas.length) quota.extraQuotas = extraQuotas;
  return quota;
}

/**
 * 专用解析器：`GET /v1/usages`（+ `/v1/me` 附带权益等级名）的实测
 * 响应结构（2026-08 校准），展示口径对齐 Kimi 官方控制台：
 * 本周用量 / 频限明细（滚动窗口）/ 我的权益（会员名胶囊）。
 * 数值字段是字符串；`usage` 是周期总额度，`limits[]` 是滚动窗口
 * （如 300 分钟 = 5 小时窗）。headline 优先用 5 小时窗口用量百分比。
 */
function parseKimiUsages(data, extras = {}) {
  if (!data || typeof data !== 'object') return null;
  // 体系分流：套餐名（新版 Go/Plus/Pro/Max）或结构特征（usages.limit_month_*）判定新体系
  const plan = String(extras.levelName || '').toLowerCase();
  const hasNewShape = !!(data.usages && (data.usages.limit_month_total || data.usages.limit_month_code));
  const isNew = KIMI_NEW_PLANS.has(plan) || (!KIMI_OLD_PLANS.has(plan) && hasNewShape);
  if (isNew && data.usages) return parseKimiNewPlan(data, extras);
  if (!data.usage && !Array.isArray(data.limits)) return null;

  /** detail（{limit, used, remaining, resetTime}）→ 时间窗；字段不全返回 null。
   *  兼容 2026-08 实测：5 小时窗口刚重置时可能只给 remaining 不给 used，用 limit - remaining 推算。 */
  const windowOf = (period, detail) => {
    if (!detail || typeof detail !== 'object') return null;
    const limit = Number(detail.limit);
    let used = Number(detail.used);
    if (!isFinite(used) && detail.remaining !== undefined) {
      const remaining = Number(detail.remaining);
      if (isFinite(remaining)) used = limit - remaining;
    }
    if (!isFinite(limit) || limit <= 0 || !isFinite(used)) return null;
    const win = { period, usedPct: Math.max(0, Math.round((used / limit) * 100)) };
    const resetAt = Date.parse(detail.resetTime);
    if (isFinite(resetAt)) win.resetAt = resetAt;
    return win;
  };

  const timeWindows = [];
  // limits[] = 滚动窗口（300 分钟 = 5 小时窗）：只取第一个可解析的作为 5h 窗口
  if (Array.isArray(data.limits)) {
    for (const entry of data.limits) {
      const win = windowOf('5h', entry && entry.detail);
      if (win) { timeWindows.push(win); break; }
    }
  }
  // usage = 7 天用量
  const weekly = windowOf('7d', data.usage);
  if (weekly) timeWindows.push(weekly);
  if (!timeWindows.length) return null;

  const planName = extras.levelName
    || (data.user && data.user.membership && String(data.user.membership.level || '').replace(/^LEVEL_/, ''))
    || undefined;
  const quota = { timeWindows };
  if (planName) quota.plan = planName;
  return quota;
}

async function fetchKimi(ctx, config) {
  const base = { providerId: 'kimi-coding', billingType: 'quota' };
  const key = await resolveCredential(ctx, 'KIMI_CODING_API_KEY');
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

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
      return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
    }
    if (!res.ok || !res.data) {
      lastError = `HTTP ${res.status} ${url}`;
      continue;
    }
    // 附属信息（我的权益等级名 /v1/me）：尽力而为，失败不影响主结果
    const me = await fetchJson(`${baseUrl}/v1/me`, { ...KIMI_HEADERS, authorization: `Bearer ${key}` }).catch(() => null);
    const extras = {
      levelName: me && me.ok && me.data && typeof me.data.user_level_name === 'string' ? me.data.user_level_name : undefined,
      // /v1/me 是否成功：用来区分"官方明确告知等级（Free 即未订阅套餐）"与"等级未知（/v1/me 挂了）"，
      // 后者不能贸然说人家没订阅，仍按"无有效额度数据"处理
      meOk: !!(me && me.ok),
    };
    const quota = parseKimiUsages(res.data, extras);
    if (quota && quota.timeWindows && quota.timeWindows.length) {
      return { ...base, status: STATUS.OK, quota };
    }
    // 无任何窗口：官方明确告知等级且为 Free（或等级为空）→ 没有生效的 Coding 套餐
    // （到期降级或从未订阅，插件无法区分，用"无订阅"这种两者都成立的说法）
    const levelName = String(extras.levelName || '').trim();
    if (extras.meOk && (!levelName || /^free$/i.test(levelName))) {
      return { ...base, status: STATUS.NO_PLAN };
    }
    return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  }
  return { ...base, status: STATUS.REQUEST_FAILED, message: lastError };
}

/* --------------------- OpenCode 订阅额度 --------------------- */

const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** OpenCode 使用量解析：{ usage: { rolling, weekly, monthly: { status, percent, resetsAt } } }。
 *  percent 为已用百分比（8 = 已用 8%）；三窗口语义：rolling=5h 滚动、weekly=7d 本周、monthly=30d 本月。
 *  产出 v2 timeWindows（按 5h → 7d → 30d 顺序），无有效窗口时返回 null。 */
function parseOpencodeUsage(data) {
  const u = data && typeof data === 'object' ? data.usage : null;
  if (!u || typeof u !== 'object') return null;
  const pick = (period, w) => {
    if (!w || typeof w !== 'object') return null;
    const pct = Number(w.percent);
    if (!isFinite(pct)) return null;
    const resetAt = Date.parse(w.resetsAt);
    const win = { period, usedPct: pct };
    if (isFinite(resetAt)) win.resetAt = resetAt;
    return win;
  };
  const timeWindows = [
    pick('5h', u.rolling),
    pick('7d', u.weekly),
    pick('30d', u.monthly),
  ].filter(Boolean);
  return timeWindows.length ? { timeWindows } : null;
}

async function fetchOpencodeGo(ctx, config) {
  // id 用 DSH 路由名 'opencode-go'（settings.yaml llm-pi-ai.providers.opencode-go），
  // 与徽标定位（PROVIDER_ALIASES 直查 current.provider）对齐，避免"未配置监控"。
  const base = { providerId: 'opencode-go', billingType: 'quota' };
  const key = await resolveCredential(ctx, 'OPENCODE_GO_API_KEY');
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

  const url = (config.url || OPENCODE_USAGE_URL).replace(/\/+$/, '');
  let res;
  try {
    res = await fetchJson(url, { authorization: `Bearer ${key}` });
  } catch (error) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: errorText(error) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
  }
  if (!res.ok || !res.data) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
  }
  const quota = parseOpencodeUsage(res.data);
  // 结构不符时明确报"无有效额度数据"，不再用通用 walk 兜底拼出语义不明的指标行
  if (!quota) return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  return { ...base, status: STATUS.OK, quota };
}

/* --------------------- Command Code 订阅额度 ---------------------
 * commandcode.ai（LLM 订阅平台，provider id = 'commandcode'，凭证 COMMANDCODE_API_KEY）：
 * 月额度 + 5 小时 / 7 天滚动窗口（与 Kimi / OpenCode 同构的窗口语义）。
 * 抓取链（Bearer 鉴权，base 可被 config.baseUrl 覆盖）：
 *   GET {base}/alpha/whoami            → { user, org: { id }? }（组织账号后续接口需带 orgId）
 *   GET {base}/alpha/billing/credits   → { credits: { monthlyCredits, purchasedCredits, freeCredits,
 *                                                     monthlyResetAt? },
 *                                          windowLimits: { limited, fiveHour: { used, cap, resetAt },
 *                                                          weekly: { used, cap, resetAt } } }
 *   GET {base}/alpha/usage/summary     → { totalCost, periodBasis: 'billing-period', periodStart, ... }
 * 语义（2026-09 真实个人账号响应校准；org 组织账号与 Provider 按量账号未实测）：
 *   - windowLimits 的 used/cap 是窗口内额度值（浮点）：used/cap = 窗口已用百分比；
 *     个人账号无 org，resetAt 是 epoch 毫秒（未使用的窗口返回 0，按无效处理）；
 *     Provider 按量账号 limited:false 无窗口（自动降级）。
 *   - credits.monthlyCredits = 本月剩余额度；purchased/free 为可结转的额外额度；
 *     summary.totalCost = 本账单周期已消耗（periodBasis=billing-period）。
 *   - summary.periodStart = 当前账单周期起点（2026-10-14 实测，新周期刚开始时值≈now；
 *     ISO 串）。月度重置没有直接字段（credits.monthlyResetAt 可选、实测不出现），
 *     用 periodStart 逐月 +1 推到未来推算（= 套餐周期的重置日，见 fetchCommandCode）。
 * 端点与参考实现同源：Anhydrite/pi-quota-monitoring。
 */

const COMMANDCODE_BASE = 'https://api.commandcode.ai';

/** 把 epoch 秒 / 毫秒或 ISO 时间统一成插件口径的毫秒（resetAt 语义与 OpenCode 一致）。
 *  0 视为无效：Command Code 窗口未使用时 resetAt 返回 0（不是有效重置时刻），
 *  避免未使用的窗口显示"0min后重置"。 */
function toResetMs(v) {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : (n > 0 ? n * 1000 : undefined);
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? undefined : ms;
}

/** 估算下个自然月 1 日（最后的兜底：无 monthlyResetAt 且 summary 无有效 periodStart 时才用）。
 *  注意这是"日历月"不是"套餐周期"——能走账单周期锚点就不要用它（见 fetchCommandCode）。 */
function nextMonthStartMs() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

async function fetchCommandCode(ctx, config) {
  const base = { providerId: 'commandcode', billingType: 'quota' };
  const key = await resolveCredential(ctx, 'COMMANDCODE_API_KEY');
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

  const baseUrl = (config.baseUrl || COMMANDCODE_BASE).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${key}` };
  const endpointOf = (p) => `${baseUrl}${p}`;

  // Command Code 的 401 = API 密钥无效（实测 error.code=UNAUTHORIZED，message 要求
  // `cmd login` 或去 Studio 重新生成）。各平台状态码语义并不统一（有的 401 是未授权、
  // 有的用它表示 key 失效），故这里只给本平台单独判定，不做全局统一映射。
  const expiredError = 'API 密钥无效';

  // 1) whoami：组织账号的额度接口需带 orgId；个人账号 org=null 不带查询串。
  let whoami;
  try {
    whoami = await fetchJson(endpointOf('/alpha/whoami'), headers);
  } catch (error) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: errorText(error) };
  }
  if (!whoami.ok) {
    return whoami.status === 401
      ? { ...base, status: STATUS.UNAUTHORIZED, message: expiredError }
      : { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${whoami.status}` };
  }
  const orgId = whoami.data && whoami.data.org && whoami.data.org.id ? String(whoami.data.org.id) : '';
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';

  // 2) 额度 + 用量并行（互不依赖，耗时取慢的一家；失败按整体接口失败处理）
  const creditsPath = `/alpha/billing/credits${qs}`;
  const summaryPath = `/alpha/usage/summary${qs}`;
  const [creditsRes, summaryRes] = await Promise.all([
    fetchJson(endpointOf(creditsPath), headers),
    fetchJson(endpointOf(summaryPath), headers),
  ]);
  const failed = [creditsRes, summaryRes].find((r) => !r.ok);
  if (failed) {
    return failed.status === 401
      ? { ...base, status: STATUS.UNAUTHORIZED, message: expiredError }
      : { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${failed.status}` };
  }

  // 3) 解析（字段缺失即缺省 0；无任何窗口且无结转额度视为无额度数据）
  const cbody = creditsRes.data && typeof creditsRes.data === 'object' ? creditsRes.data : {};
  const cred = (cbody.credits && typeof cbody.credits === 'object') ? cbody.credits : {};
  const win = (cbody.windowLimits && typeof cbody.windowLimits === 'object') ? cbody.windowLimits : {};
  const num0 = (v) => { const n = num(v); return n === null ? 0 : n; };
  const monthlyRemain = num0(cred.monthlyCredits);
  const purchased = num0(cred.purchasedCredits);
  const free = num0(cred.freeCredits);
  const sbody = summaryRes.data && typeof summaryRes.data === 'object' ? summaryRes.data : {};
  const spent = num0(sbody.totalCost);
  const balance = monthlyRemain + purchased + free;

  /** 窗口 → v2 时间窗：已用% = used/cap；字段不全或 cap 非正返回 null。 */
  const windowOf = (period, w) => {
    if (!w || typeof w !== 'object') return null;
    const used = num(w.used);
    const cap = num(w.cap);
    if (used === null || cap === null || cap <= 0) return null;
    const out = { period, usedPct: Math.max(0, Math.min(100, Math.round((used / cap) * 100))) };
    const resetAt = toResetMs(w.resetAt);
    if (resetAt !== undefined) out.resetAt = resetAt;
    return out;
  };
  const w5 = windowOf('5h', win.fiveHour);
  const w7 = windowOf('7d', win.weekly);

  // 账单周期锚点：usage/summary 的 periodStart（periodBasis=billing-period，实测语义=当前周期起点）。
  // 月度重置日 = 从锚点逐月 +1 推到未来（套餐按订阅周期滚动，如 10-14 订则每月 14 号重置）。
  const billingAnchor = toResetMs(sbody.periodStart);
  let billingResetAt;
  if (billingAnchor !== undefined) {
    const d = new Date(billingAnchor);
    while (d.getTime() <= Date.now()) d.setMonth(d.getMonth() + 1);
    billingResetAt = d.getTime();
  }

  // 月度窗：spent / (剩余 + spent)。purchased/free 结转额度与月度桶同池计算（参考 pi-quota 口径），
  // 结转部分另用 extraQuotas 单独展示，避免"总余额"被低估。
  let monthWin = null;
  if (balance + spent > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((spent / (balance + spent)) * 100)));
    // 重置优先级：monthlyResetAt（接口若直接给）→ 账单周期推算 → 自然月兜底
    const resetAt = toResetMs(cred.monthlyResetAt) ?? billingResetAt ?? nextMonthStartMs();
    monthWin = { period: 'month', usedPct: pct };
    if (resetAt !== undefined) monthWin.resetAt = resetAt;
  }

  const timeWindows = [w5, w7, monthWin].filter(Boolean);
  const extraQuotas = [];
  if (purchased > 0 || free > 0) {
    // 结转额度：金额 + 拆分说明（"已购/赠送"是该数值的唯一语义来源，随额度一起给出）
    extraQuotas.push({
      label: '额外额度（结转）',
      amount: money(purchased + free),
      currency: 'CNY',
      detail: `已购 ${money(purchased)} · 赠送 ${money(free)}`,
    });
  }
  if (!timeWindows.length && !extraQuotas.length) {
    return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  }
  const quota = { timeWindows };
  if (extraQuotas.length) quota.extraQuotas = extraQuotas;
  return { ...base, status: STATUS.OK, quota };
}

/* ------------------------- OpenRouter 余额 -------------------------
 * 聚合平台，标准 API key 即可查询账户余额。
 * GET https://openrouter.ai/api/v1/credits → { total_credits, total_usage, ... }（美元）。
 */

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

async function fetchOpenRouter(ctx, config) {
  const base = { providerId: 'openrouter', billingType: 'balance' };
  const key = await resolveCredential(ctx, 'OPENROUTER_API_KEY');
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

  const url = (config.url || OPENROUTER_CREDITS_URL).replace(/\/+$/, '');
  let res;
  try {
    res = await fetchJson(url, { authorization: `Bearer ${key}` });
  } catch (error) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: errorText(error) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
  }
  if (!res.ok || !res.data) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
  }
  // 响应有一层 data 包装：{ data: { total_credits, total_usage } }（实测 2026-08-25）
  const d = res.data && typeof res.data === 'object' && res.data.data && typeof res.data.data === 'object'
    ? res.data.data
    : res.data;
  const total = num(d.total_credits);
  const usage = num(d.total_usage);
  // 余额（1 积分 = 1 美元）：总额度减去已用；只有总额度时直接用它
  const remaining = (total !== null && usage !== null) ? Math.max(0, total - usage) : total;
  if (remaining === null) {
    return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  }
  const balance = { amount: money(remaining), currency: 'USD' };
  const monthSpend = num(d.usage_monthly);
  const spending = {};
  if (monthSpend !== null) spending.thisMonth = money(monthSpend);
  if (usage !== null) spending.total = money(usage);
  if (Object.keys(spending).length) {
    spending.currency = 'USD';
    balance.spending = spending;
  }
  return { ...base, status: STATUS.OK, balance };
}

/* ------------------------- MiniMax（Hailuo）Token Plan -------------------------
 * 国际（api.minimax.io）与国内（api.minimaxi.com）两站，参数化共用。
 * GET {base}/v1/token_plan/remains（或 /v1/api/openplatform/coding_plan/remains）
 * → data.model_remains[]，取 model_name === 'general' 的行：
 *   current_interval_remaining_percent（5h 剩余%）、current_weekly_remaining_percent（7d 剩余%）。
 */

const MINIMAX_REGIONS = {
  global: { base: 'https://api.minimax.io', label: 'MiniMax' },
  cn: { base: 'https://api.minimaxi.com', label: 'MiniMax（CN）' },
};
const MINIMAX_REMAINS_PATHS = ['/v1/token_plan/remains', '/v1/api/openplatform/coding_plan/remains'];

async function fetchMiniMaxRegion(ctx, config, region) {
  const R = MINIMAX_REGIONS[region];
  const id = region === 'cn' ? 'minimax-cn' : 'minimax';
  const envKey = region === 'cn' ? 'MINIMAX_CN_API_KEY' : 'MINIMAX_API_KEY';
  const base = { providerId: id, billingType: 'quota' };
  const key = await resolveCredential(ctx, envKey);
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

  const baseUrl = (config.baseUrl || R.base).replace(/\/+$/, '');
  const candidates = config.url ? [config.url] : MINIMAX_REMAINS_PATHS.map((p) => `${baseUrl}${p}`);
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
      return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
    }
    if (!res.ok || !res.data) {
      return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
    }
    const body = res.data;
    // MiniMax 假 key 也返回 HTTP 200，但 body 带业务错误码（base_resp.status_code）：1004=登录失败
    if (body && body.base_resp && Number(body.base_resp.status_code) !== 0) {
      return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（${body.base_resp.status_code}）` };
    }
    const rows = (body && body.data && Array.isArray(body.data.model_remains)) ? body.data.model_remains
      : (Array.isArray(body && body.model_remains) ? body.model_remains : []);
    const row = rows.find((x) => x && x.model_name === 'general') || rows[0] || null;
    if (!row) {
      lastError = '响应中未找到 model_remains';
      continue;
    }
    // percent 是剩余百分比（0-100），用量 = 100 - 剩余
    const pct5h = pctNum(row.current_interval_remaining_percent);
    const pctWk = pctNum(row.current_weekly_remaining_percent);
    const timeWindows = [];
    if (pct5h !== null) timeWindows.push({ period: '5h', usedPct: Math.round(100 - pct5h) });
    if (pctWk !== null) timeWindows.push({ period: '7d', usedPct: Math.round(100 - pctWk) });
    if (!timeWindows.length) {
      lastError = 'general 行无可用百分比';
      continue;
    }
    return { ...base, status: STATUS.OK, quota: { timeWindows } };
  }
  return { ...base, status: STATUS.REQUEST_FAILED, message: lastError };
}

async function fetchMiniMax(ctx, config) {
  return fetchMiniMaxRegion(ctx, config, 'global');
}

async function fetchMiniMaxCn(ctx, config) {
  return fetchMiniMaxRegion(ctx, config, 'cn');
}

/* ------------------------- 智谱 GLM / bigmodel.cn -------------------------
 * 国际（api.z.ai）与国内（open.bigmodel.cn）两站，参数化共用。
 * GET {base}/api/monitor/usage/quota/limit → data.limits[]（参考 token-monitor 实现）：
 *   type ∈ TOKENS_LIMIT / CREDIT_LIMIT（token 窗口）/ TIME_LIMIT（MCP 月度桶，忽略）
 *   usage（总量）/ remaining（剩余）/ percentage / next_reset_time；
 *   窗口编码 unit+number：5=分钟 3=小时 1=天 6=周。
 *  token 类按窗口分钟升序：最短 → 5小时用量，最长 → 7天用量（与 Kimi/OpenCode 同款展示）。
 */

const ZAI_REGIONS = {
  global: { base: 'https://api.z.ai', label: 'GLM' },
  cn: { base: 'https://open.bigmodel.cn', label: 'GLM Coding（CN）' },
};
const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit';
/** glm-code-plan（cn 区）的凭证变量，按序尝试、任一配好即可用：DSH 原生路由用
 *  GLM_CODE_PLAN_API_KEY，pi-ai 渠道（zai-coding-cn，已归一到这里）用 ZAI_CODING_CN_API_KEY。
 *  两者打同一个官方端点、同一套解析，故合并为一条提供方；每次抓取实时解析，换 key 不改代码。 */
const GLM_CODE_PLAN_ENV_KEYS = ['GLM_CODE_PLAN_API_KEY', 'ZAI_CODING_CN_API_KEY'];

/** unit+number → 窗口分钟（unit：5=分钟 3=小时 1=天 6=周）。 */
function zaiWindowMinutes(unit, number) {
  if (unit === null || number === null || number <= 0) return null;
  if (unit === 5) return number;
  if (unit === 3) return number * 60;
  if (unit === 1) return number * 24 * 60;
  if (unit === 6) return number * 7 * 24 * 60;
  return null;
}

/** limit → 已用百分比（usage/remaining 优先，percentage 兜底）。 */
function zaiUsedPercent(limit) {
  const total = num(limit.usage ?? limit.total);
  const remaining = num(limit.remaining);
  const currentValue = num(limit.currentValue ?? limit.current_value);
  let usedRaw = null;
  if (remaining !== null && total !== null) {
    usedRaw = currentValue === null ? total - remaining : Math.max(total - remaining, currentValue);
  } else if (currentValue !== null) {
    usedRaw = currentValue;
  }
  if (usedRaw !== null && total !== null && total > 0) {
    return Math.max(0, Math.min(100, Math.round((usedRaw / total) * 100)));
  }
  return pctNum(limit.percentage ?? limit.usedPercent ?? limit.used_percent);
}

/** limit → 重置时刻（毫秒时间戳）；无有效时间返回 undefined。
 *  bigmodel.cn 返回毫秒时间戳（实测 1792043549840），z.ai 可能返回日期字符串。 */
function zaiResetAt(limit) {
  const r = limit.nextResetTime ?? limit.next_reset_time;
  if (!r) return undefined;
  const s = String(r).trim();
  const ms = /^\d+$/.test(s) ? (s.length >= 13 ? Number(s) : Number(s) * 1000) : NaN;
  if (Number.isFinite(ms) && ms > 0) return ms;
  const t = new Date(s).getTime();
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

async function fetchZaiRegion(ctx, config, region) {
  const R = ZAI_REGIONS[region];
  const id = region === 'cn' ? 'glm-code-plan' : 'zai';
  // cn 区（glm-code-plan）凭证变量按序尝试，见 GLM_CODE_PLAN_ENV_KEYS 注释
  const envKeys = region === 'cn' ? GLM_CODE_PLAN_ENV_KEYS : ['ZAI_API_KEY'];
  // 两家都查 coding plan 的窗口配额（同一端点、同一解析），按 quota 型产出
  const base = { providerId: id, billingType: 'quota' };
  let key;
  for (const ref of envKeys) {
    key = await resolveCredential(ctx, ref);
    if (key) break;
  }
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

  const baseUrl = (config.baseUrl || R.base).replace(/\/+$/, '');
  const url = (config.url || `${baseUrl}${ZAI_QUOTA_PATH}`).replace(/\/+$/, '');
  let res;
  try {
    res = await fetchJson(url, { authorization: `Bearer ${key}` });
  } catch (error) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: errorText(error) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
  }
  if (!res.ok || !res.data) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
  }
  // 智谱业务错误也返回 HTTP 200：成功响应 z.ai 是 code=0，bigmodel.cn 是 code=200
  //（实测 glm-code-plan /api/monitor/usage/quota/limit，且 success=true 并存）——
  // success!==false 且 code 缺省/为 0/为 200 都算成功，其余视为业务失败。
  // 按量付费账户无查询口（如"当前用户不存在coding plan"）——key 有效但官方未开放，
  // 统一提示"官方暂未提供查询接口"。
  const rdata = res.data;
  const bizCode = rdata && typeof rdata === 'object' && rdata.code !== undefined ? Number(rdata.code) : null;
  const bizFailed = (rdata && typeof rdata === 'object' && rdata.success === false)
    || (bizCode !== null && bizCode !== 0 && bizCode !== 200);
  if (rdata && typeof rdata === 'object' && bizFailed) {
    return { ...base, status: STATUS.NO_DATA, message: '官方暂未提供查询接口' };
  }
  const data = res.data && res.data.data;
  const limits = Array.isArray(data && data.limits) ? data.limits : (Array.isArray(data) ? data : []);
  const tokenLimits = [];
  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') continue;
    const type = String(limit.type || limit.limit_type || '').trim().toUpperCase();
    if ((type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT' || type === '') && zaiUsedPercent(limit) !== null) {
      tokenLimits.push(limit);
    }
  }
  // 按窗口分钟升序：最短 = 5小时滚动，最长 = 7天/更大窗口
  tokenLimits.sort((a, b) => {
    const am = zaiWindowMinutes(num(a.unit), num(a.number)) ?? Number.MAX_SAFE_INTEGER;
    const bm = zaiWindowMinutes(num(b.unit), num(b.number)) ?? Number.MAX_SAFE_INTEGER;
    return am - bm;
  });
  const session = tokenLimits.length >= 2 ? tokenLimits[0]
    : (tokenLimits[0] && (zaiWindowMinutes(num(tokenLimits[0].unit), num(tokenLimits[0].number)) ?? Infinity) <= 360 ? tokenLimits[0] : null);
  const weekly = tokenLimits.length >= 2 ? tokenLimits[tokenLimits.length - 1]
    : (session ? null : (tokenLimits[0] || null));

  const timeWindows = [];
  if (session) {
    timeWindows.push({ period: '5h', usedPct: zaiUsedPercent(session), resetAt: zaiResetAt(session) });
  }
  if (weekly) {
    timeWindows.push({ period: '7d', usedPct: zaiUsedPercent(weekly), resetAt: zaiResetAt(weekly) });
  }
  // 清理缺字段的窗口（usedPct 必须是数字）
  const valid = timeWindows.filter((w) => typeof w.usedPct === 'number');
  if (!valid.length) {
    return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  }
  return { ...base, status: STATUS.OK, quota: { timeWindows: valid } };
}

async function fetchZai(ctx, config) {
  return fetchZaiRegion(ctx, config, 'global');
}

/** glm-code-plan：智谱 Coding 套餐额度。DSH 原生路由（providers.glm-code-plan，
 *  baseURL open.bigmodel.cn/api/anthropic）与 pi-ai 渠道的 zai-coding-cn 打同一个
 *  官方端点（/api/monitor/usage/quota/limit），后者已在 fold 层归一到本条目。 */
async function fetchGlmCodePlan(ctx, config) {
  return fetchZaiRegion(ctx, config, 'cn');
}

/* ---------------------------- 抓取器注册表 ---------------------------- */

/** provider id（normalizeProvider 归一后）→ 抓取器。新增提供方在这里登记。 */
export const FETCHERS = {
  'chatgpt-codex': fetchChatgptCodex,
  'kimi-coding': fetchKimi,
  'moonshotai-cn': fetchMoonshotAiCn,
  deepseek: fetchDeepSeek,
  'deepseek-account': fetchDeepSeekAccount,
  'opencode-go': fetchOpencodeGo,
  commandcode: fetchCommandCode,
  openrouter: fetchOpenRouter,
  minimax: fetchMiniMax,
  'minimax-cn': fetchMiniMaxCn,
  zai: fetchZai,
  'glm-code-plan': fetchGlmCodePlan,
};
