/**
 * dsh-token-monitor — 通用 HTTP 小工具（抓取器与服务端共用）。
 *
 * fetchJson：带超时与状态保留的 JSON GET，不抛 HTTP 非 2xx（交给调用方判断）；
 *   网络层瞬时错误与 5xx 会按次数退避重试（见 isRetryableFailure）；
 * truncateRaw：原始响应截断预览（至多 RAW_PREVIEW_BYTES，供在线校准解析规则）；
 * errorText：把异常/AbortError 转成用户可读文案。
 */

const FETCH_TIMEOUT_MS = 10_000;
const RAW_PREVIEW_BYTES = 4096;
const FETCH_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

/** 网络层瞬时错误：连接超时/被重置/对端关闭/DNS 抖动/自身超时（含 10s AbortController 触发）。
 *  这类失败与请求本身无关——重发一次通常立刻成功，实测某代理链路上约 1/3 的冷连接会卡到
 *  connect timeout，而紧接着的下一笔 200。 */
function isRetryableFailure(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  const inner = (error.cause && error.cause.cause) || {};
  const text = [
    error.code, error.message,
    error.cause && error.cause.code, error.cause && error.cause.name, error.cause && error.cause.message,
    inner.code, inner.message,
  ].filter(Boolean).join(' ');
  return /UND_ERR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket|fetch failed|abort/i.test(text);
}

/** 带超时与状态保留的 JSON GET；不抛 HTTP 非 2xx，交给调用方判断。
 *  默认最多尝试 FETCH_ATTEMPTS 次：网络层瞬时错误按 RETRY_BASE_MS × 次数退避重试；
 *  5xx（网关/边缘瞬时故障）在还有余量时也重试；其余状态码与最终结果照旧原样返回，
 *  调用方判断逻辑不变。返回对象多一个 attempts 字段（实际用掉的尝试次数，便于排查）。 */
export async function fetchJson(url, headers, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || FETCH_ATTEMPTS);
  const timeoutMs = Number(options.timeoutMs) || FETCH_TIMEOUT_MS;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      if (res.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status}`);
      } else {
        return { status: res.status, ok: res.ok, data, text, attempts: attempt };
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableFailure(error)) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt));
  }
  throw lastError;
}

/** 截断后的原始响应预览（undefined 原样返回；超过 4KB 截断标记）。 */
export function truncateRaw(data) {
  if (data === undefined) return undefined;
  let text;
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    return undefined;
  }
  return text.length > RAW_PREVIEW_BYTES ? `${text.slice(0, RAW_PREVIEW_BYTES)}…<truncated>` : text;
}

/** 错误转文案：AbortError 显示超时；其余取 message。 */
export function errorText(error) {
  if (error && error.name === 'AbortError') return `请求超时（${FETCH_TIMEOUT_MS}ms）`;
  return String((error && error.message) || error);
}
