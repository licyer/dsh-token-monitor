/**
 * dsh-token-monitor — 通用 HTTP 小工具（抓取器与服务端共用）。
 *
 * fetchJson：带超时与状态保留的 JSON GET，不抛 HTTP 非 2xx（交给调用方判断）；
 * truncateRaw：原始响应截断预览（至多 RAW_PREVIEW_BYTES，供在线校准解析规则）；
 * errorText：把异常/AbortError 转成用户可读文案。
 */

const FETCH_TIMEOUT_MS = 10_000;
const RAW_PREVIEW_BYTES = 4096;

/** 带超时与状态保留的 JSON GET；不抛 HTTP 非 2xx，交给调用方判断。 */
export async function fetchJson(url, headers) {
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
