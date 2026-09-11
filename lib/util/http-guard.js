/**
 * 插件 HTTP 路由的两道通用防护（注册处见 lib/index.js 的 18 个 handler）。
 *
 * 为什么需要：DSH 的 webServer 只按 pathname 分发请求，本身**不做 Host/Origin 校验**
 * （宿主的 trustedHosts 只被 dsh-client-connection 用于它自己的 /api 端点）。而本插件有
 * 会执行命令（/upgrade）、读写本地文件（/import、/export、打开目录）的接口，若不校验：
 *
 *  1. 用户浏览器里的**任意网页**都能 `fetch('http://127.0.0.1:3080/token-monitor/upgrade',
 *     { method:'POST', mode:'no-cors' })` —— 简单请求不触发预检，请求会被真的送达并执行。
 *  2. `dsh web --host 0.0.0.0`（LAN 模式，手机访问那种）下，局域网内任何设备都能直连
 *     全部接口，包括 `GET /export/dsh`（全量用量导出）与 `POST /upgrade`。
 *
 * 规则与官方 /api 同思路：
 *  - **Host** 必须是 loopback（127.0.0.1 / localhost / ::1）或宿主给出的 trustedHosts。
 *    只比主机名、不比端口：官方注释说明了原因——绑定端口在 bind 前不可知，而 IP 字面量
 *    Host 天然免疫 DNS rebinding（攻击需要可控域名）。
 *  - 非简单方法（POST/DELETE/…）再校验 **Origin**：存在时必须同源；不存在则放行
 *    （curl 等非浏览器客户端不带 Origin，浏览器对跨源请求一定会带）。
 */

/** 视为 loopback 的主机名（不含端口）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** IP 字面量（IPv4 或已剥方括号的 IPv6）：免疫 DNS rebinding，故可作为降级信任条件。 */
const IP_LITERAL_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/;

/** 不需要 Origin 校验的方法（只读、无副作用）。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 请求体默认上限：导入类接口最大就是几十 MB 的导出文件，超过按 413 拒绝。 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * 取 Host/Origin 里的主机名：去掉端口、去掉 IPv6 方括号、统一小写。
 * @param {string|undefined} value - 形如 `127.0.0.1:3080` / `[::1]:3080` / `example.com`
 * @returns {string} 主机名；无法解析时返回空串
 */
export function hostnameOf(value) {
  if (typeof value !== 'string' || !value) return '';
  const v = value.trim().toLowerCase();
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end) : v;
  }
  const colon = v.lastIndexOf(':');
  // 只切一次冒号（IPv6 无方括号写法不做处理，浏览器与 curl 都会带方括号）
  if (colon > 0 && v.indexOf(':') === colon) return v.slice(0, colon);
  return v;
}

/**
 * 判定一个请求是否可信。
 * @param {object} req - node:http 请求（只读 method 与 headers）
 * @param {Iterable<string>} [trustedHosts] - 宿主给出的额外可信主机（LAN IP / --trusted-host）
 * @param {{allowIpLiteralHost?: boolean}} [options] - 降级开关，见下
 * @returns {boolean} true = 放行
 *
 * `allowIpLiteralHost` 用于**老版本 DSH**：那时没有 webRuntime 服务、拿不到 trustedHosts，
 * 若用户以 `--host 0.0.0.0` 在局域网访问（手机/平板），严格白名单会把插件整体挡死。
 * 此时退化为"只信 IP 字面量 Host"——与官方注释同一理由：DNS rebinding 需要可控域名，
 * IP 字面量天然免疫；域名与跨站 Origin 仍然拒绝。
 */
export function isTrustedRequest(req, trustedHosts, options) {
  const allowed = new Set(LOOPBACK_HOSTS);
  for (const host of trustedHosts || []) {
    const name = hostnameOf(host);
    if (name) allowed.add(name);
  }
  const allowIpLiteral = !!(options && options.allowIpLiteralHost);
  const trustedHost = (name) => allowed.has(name) || (allowIpLiteral && IP_LITERAL_RE.test(name));

  const host = hostnameOf(req && req.headers && req.headers.host);
  if (!host || !trustedHost(host)) return false;

  const method = String((req && req.method) || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return true;

  const origin = req && req.headers && req.headers.origin;
  if (origin === undefined || origin === null || origin === '') return true; // 非浏览器客户端
  if (origin === 'null') return false; // sandbox iframe / file:// 页发起
  let originHost = '';
  try {
    originHost = hostnameOf(new URL(origin).host);
  } catch {
    return false;
  }
  return originHost !== '' && trustedHost(originHost);
}

/** 请求体超限的错误码（调用方据此回 413）。 */
export const BODY_TOO_LARGE = 'ETOOLARGE';

/**
 * 读取请求体（带大小上限）。
 * @param {object} req - node:http 请求
 * @param {number} [maxBytes] - 上限字节数
 * @returns {Promise<string>} UTF-8 文本
 * @throws {Error} code = BODY_TOO_LARGE 时表示超限（调用方应回 413 并断开连接）
 */
export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`请求体超过 ${Math.round(maxBytes / 1048576)}MB 上限`);
      error.code = BODY_TOO_LARGE;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
