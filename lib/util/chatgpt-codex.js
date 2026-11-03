/** ChatGPT 登录额度；只读 codex-as-api 凭证，不刷新、不返回认证或原始响应。 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchJson } from './http.js';
import { STATUS } from './quota-snapshot.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RELOGIN = '请在 codex-as-api 重新登录';

/** JWT 内容仅作账号/过期提示，不作为已通过签名认证的依据（由官方端点鉴权）。 */
function tokenClaims(token) {
  try {
    const payload = token.split('.')[1];
    return payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : null;
  } catch { return null; }
}

function headerValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768
    && !/[^\x21-\x7e]/.test(value);
}

/** 按实际秒数认窗；不把 null/空串/布尔值转成零。 */
function parseWindow(w) {
  if (!w || ![18000, 604800].includes(w.limit_window_seconds)) return null;
  const pct = w.used_percent;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  let resetAt;
  if (typeof w.reset_at === 'number' && Number.isFinite(w.reset_at) && w.reset_at > 0) {
    const ms = w.reset_at * 1000;
    if (Number.isFinite(new Date(ms).getTime())) resetAt = ms;
  }
  const out = { usedPct: pct };
  if (resetAt !== undefined) out.resetAt = resetAt;
  return out;
}

/**
 * @param {object} ctx 宿主上下文（认证不依赖 DSH 原生 OAuth）。
 * @param {{authPath?: string, url?: string, baseUrl?: string}} config 服务端配置。
 * @returns {Promise<object>} v2 快照；所有失败采用固定文案，避免第三方错误反射机密。
 */
export async function fetchChatgptCodex(ctx, config = {}) {
  const base = { providerId: 'chatgpt-codex', billingType: 'quota' };
  // 禁止令牌随可配置 URL 或重定向流向第三方。
  if (config.url !== undefined || config.baseUrl !== undefined) {
    return { ...base, status: STATUS.NO_CREDENTIAL, message: 'ChatGPT Codex 仅允许固定官方 HTTPS 额度端点' };
  }
  const authPath = config.authPath ?? process.env.CODEX_AS_API_AUTH_PATH ?? join(homedir(), '.codex-as-api', 'auth.json');
  if (typeof authPath !== 'string' || !authPath.trim()) {
    return { ...base, status: STATUS.NO_CREDENTIAL, message: 'ChatGPT Codex authPath 无效' };
  }
  let tokens;
  try {
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    tokens = auth && auth.tokens;
  } catch {
    return { ...base, status: STATUS.NO_CREDENTIAL, message: `无法读取 ChatGPT Codex 凭证，${RELOGIN}或检查 authPath` };
  }
  const token = tokens && tokens.access_token;
  if (!headerValue(token)) {
    return { ...base, status: STATUS.NO_CREDENTIAL, message: `ChatGPT Codex 凭证无效，${RELOGIN}` };
  }
  const claims = tokenClaims(token);
  const accountId = tokens.account_id ?? (claims && claims['https://api.openai.com/auth'] && claims['https://api.openai.com/auth'].chatgpt_account_id);
  if (!headerValue(accountId)) {
    return { ...base, status: STATUS.NO_CREDENTIAL, message: `ChatGPT Codex 账号 ID 缺失或无效，${RELOGIN}` };
  }
  if (claims && typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
    return { ...base, status: STATUS.UNAUTHORIZED, message: `ChatGPT Codex 凭证已过期，${RELOGIN}` };
  }
  let res;
  try {
    res = await fetchJson(USAGE_URL, { authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId });
  } catch {
    return { ...base, status: STATUS.REQUEST_FAILED, message: 'ChatGPT Codex 额度请求失败，请检查网络/代理（不允许重定向）' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
  }
  if (!res.ok) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
  }
  const rate = res.data && res.data.rate_limit;
  const windows = [rate && rate.primary_window, rate && rate.secondary_window];
  const session = parseWindow(windows.find((w) => w && w.limit_window_seconds === 18000));
  const weekly = parseWindow(windows.find((w) => w && w.limit_window_seconds === 604800));
  const timeWindows = [];
  if (session) timeWindows.push({ period: '5h', ...session });
  if (weekly) timeWindows.push({ period: '7d', ...weekly });
  if (!timeWindows.length) {
    return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  }
  const plan = res.data.plan_type;
  const quota = { timeWindows };
  if (['plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'free'].includes(plan)) quota.plan = plan;
  return { ...base, status: STATUS.OK, quota };
}
