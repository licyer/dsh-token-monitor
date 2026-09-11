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
import { loadPricing, seedModelPrices, syncBuiltinPrices, p4ToYuan, yuanToP4 } from './util/pricing.js';
import { versionInfo, upgradePlugin } from './util/market-upgrade.js';
import { VALID_UNTIL_OPEN } from './util/store.js';
import { openUsageStore, dayOf } from './util/store.js';
import { PROVIDER_MAPPING_SEED, VENDOR_LABELS } from './util/provider-mappings.js';
import { foldAllSessions, normalizeProvider } from './util/fold.js';

/** 插件版本（package.json）：随 usage/sources 下发，用量页底部显示。 */
let PLUGIN_VERSION = '';
try {
  PLUGIN_VERSION = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  ).version || '';
} catch { /* package.json 缺失/损坏：空版本号，前端不显示版本，不影响插件加载 */ }
import { importCcSwitch, importCcSqlFile, checkCcPending } from './util/import-cc.js';
import { exportDshUsage, importDshUsage, exportFileName } from './util/import-dsh.js';
import { fetchJson, truncateRaw, errorText } from './util/http.js';
import { isTrustedRequest, readBody, BODY_TOO_LARGE } from './util/http-guard.js';
import { FETCHERS } from './util/fetch-quotas.js';

const ROUTE_PATH = '/token-monitor/overview';
const DEFAULT_CACHE_MS = 60_000;
const MIN_CACHE_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;
const RAW_PREVIEW_BYTES = 4096;
const FOLD_INTERVAL_MS = 300_000; // 用量采集折叠周期（毫秒）；固定内置 5 分钟，不再作为 config 暴露
/** 已用真实响应验证过的提供方（设置页"是否验证"列数据源；其余为待真实 key 校准）。 */
const VERIFIED_PROVIDERS = new Set(['kimi-coding', 'moonshotai-cn', 'deepseek', 'opencode-go', 'openrouter', 'commandcode']);



/* ---------------------------- 插件本体 ---------------------------- */

export function apply(ctx, config = {}) {
  const cacheMs = typeof config.cacheMs === 'number' && config.cacheMs >= MIN_CACHE_MS
    ? config.cacheMs
    : DEFAULT_CACHE_MS;
  const providerConfig = (config.providers && typeof config.providers === 'object') ? config.providers : {};

  const cache = new Map(); // id -> { at, payload }
  const inflight = new Map(); // id -> Promise<payload>

  /* ---------- 路由来源校验（Host / Origin，见 util/http-guard.js） ----------
   * 本插件的路由由 DSH 的 webServer 直接分发，宿主不做任何来源校验，而这些接口
   * 会执行命令（/upgrade）、读写本地数据（/import、/export）。所以每个 handler 进来
   * 先过一道：Host 必须是 loopback 或宿主给的 trustedHosts，非只读方法再校验 Origin。
   * trustedHosts 来自 webRuntime（LAN 模式下的网卡地址 + --trusted-host）；服务缺失
   * 时只信 loopback——启动早期拿不到就下次再取，不做永久缓存。 */
  let trustedHostsCache = [];
  function pluginTrustedHosts() {
    if (trustedHostsCache.length) return trustedHostsCache;
    try {
      const runtime = ctx.get('webRuntime');
      if (runtime && Array.isArray(runtime.trustedHosts)) trustedHostsCache = runtime.trustedHosts.slice();
    } catch { /* 宿主无该服务：只信 loopback */ }
    return trustedHostsCache;
  }
  /** 未通过来源校验时的统一拒绝（403，不区分原因，避免给探测者提供信息）。 */
  function denyUntrusted(req, res) {
    // 降级开关：宿主没给 trustedHosts（老版本无 webRuntime）且绑的是 0.0.0.0（LAN 模式）
    // → 只信 IP 字面量 Host，避免把局域网访问整体挡死（详见 util/http-guard.js）。
    let allowIpLiteralHost = false;
    if (!pluginTrustedHosts().length) {
      try {
        const ws = ctx.get('webServer');
        allowIpLiteralHost = !!(ws && ws.host === '0.0.0.0');
      } catch { allowIpLiteralHost = false; }
    }
    if (isTrustedRequest(req, pluginTrustedHosts(), { allowIpLiteralHost })) return false;
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return true;
  }

  /* ---------- USD→CNY 汇率（启动拉取 + 每天 8 点更新，内存缓存不入库） ----------
   * 实时源：open.er-api.com（免费、无 key、约每小时更新）；失败用默认 7.2 兜底。
   * 时间闸：成功闸 24h（距上次成功不足 24h 不重拉；到点且本地时间 ≥ 8:00 才更新）；
   * 失败闸 1h（距上次失败不足 1h 不重试——断网时后台不白耗请求）。
   * 调用方不 await（fire-and-forget）：请求路径永远秒回，汇率用内存现值。 */
  const DEFAULT_USD_CNY = 7.2;
  const RATE_UPDATE_MS = 86_400_000; // 成功闸：24h
  const RATE_FAIL_MS = 3_600_000;    // 失败闸：1h（断网时抑制重试）
  const RATE_URL = 'https://open.er-api.com/v6/latest/USD';
  let usdCnyRate = DEFAULT_USD_CNY;
  let rateFetchedAt = 0;
  let lastRateAt = 0;     // 上次成功更新时刻
  let rateFailedAt = 0;   // 上次失败时刻

  async function refreshUsdCnyRate() {
    const now = Date.now();
    if (lastRateAt && now - lastRateAt < RATE_UPDATE_MS) return;   // 成功闸
    if (rateFailedAt && now - rateFailedAt < RATE_FAIL_MS) return; // 失败闸
    // 每天 8 点后更新：距上次 ≥24h 且本地时间 ≥ 8:00（或从未拉过）
    const h = new Date(now).getHours();
    if (lastRateAt && h < 8) return;
    try {
      const res = await fetchJson(RATE_URL);
      const cny = res && res.ok && res.data && res.data.rates && Number(res.data.rates.CNY);
      if (isFinite(cny) && cny > 0) {
        usdCnyRate = cny;
        lastRateAt = now;
        rateFailedAt = 0; // 成功清失败闸
        rateFetchedAt = now;
        ctx.logger.info(`token-monitor: 汇率已更新 USD/CNY=${cny}`);
      } else {
        rateFailedAt = now;
        ctx.logger.warn('token-monitor: 汇率接口返回异常，保留现值');
      }
    } catch (error) {
      rateFailedAt = now; // 失败推进失败闸：1h 内不再重试
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
    // 提供方列表以「用户配置并激活的提供方」为准（ctx.llm.listProviders）：
    // llm-pi-ai 只为配置里存在的 provider 注册 adapter，与 key 无关、与抓取器注册表无关。
    // 配置几个显示几个；已适配的抓余量（key 缺失仍显示"未配置"文案），未适配的占位提示。
    const llm = ctx.get('llm');
    const routes = (llm && typeof llm.listProviders === 'function') ? llm.listProviders() : [];
    // 并行抓取所有已适配提供方：刷新时间 = 最慢一家，而非串行总和（配置多了才不拖慢徽标）。
    // providerOverview 内部有 60s 缓存 + 单飞，本身不抛异常；这里再包一层兜底防意外 throw。
    const settled = await Promise.all(routes.map(async (route) => {
      const rawId = route && route.id;
      if (!rawId) return null;
      // 归一化路由 id：DSH 原生 DeepSeek 路由是 'deepseek-official'，抓取器键是 'deepseek'，
      // 归一后再匹配（否则默认 DeepSeek 会被当成"未适配"）
      const pid = normalizeProvider(rawId);
      if (FETCHERS[pid]) {
        try {
          return await providerOverview(pid);
        } catch (error) {
          return { id: pid, label: (route && route.name) || pid, kind: 'unknown', ok: false, error: errorText(error) };
        }
      }
      return {
        id: rawId,
        label: (route && route.name) || rawId,
        kind: 'unsupported',
        ok: false,
        unsupported: true, // 已配置但未适配：前端显示"插件未适配，敬请期待"
      };
    }));
    const providers = settled.filter(Boolean);
    // label 统一为 provider_mappings 的提供方名（有映射的覆盖抓取器硬编码 label，
    // 保证弹层"全部提供方"与用量页 provider_name 一致；无映射保留 route.name/抓取器 label）
    for (const p of providers) {
      const m = p && providerMap[p.id];
      if (m) p.label = m.provider_name;
    }
    // 展示排序：DeepSeek 置顶，其余按提供方 id 首字母排序
    providers.sort((a, b) => {
      if (a.id === 'deepseek') return -1;
      if (b.id === 'deepseek') return 1;
      return String(a.id).localeCompare(String(b.id), 'zh');
    });
    // 汇率：后台触发拉取（fire-and-forget，不阻塞响应；失败有 1h 闸，断网不白耗）
    refreshUsdCnyRate();
    // 插件可配置项下发（自建 config.json，随 overview 常拉通道带给前端，defaultDays/pollMs 生效）
    return {
      ok: true, fetchedAt: Date.now(), cacheMs, providers, usdCnyRate, rateFetchedAt,
      version: PLUGIN_VERSION,
      pluginSettings: {
        defaultDays: pluginConfig.defaultDays,
        pollMs: pluginConfig.pollMs,
        retentionDays: pluginConfig.retentionDays,
      },
    };
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
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
    // 当前提供方快速通道：徽标只关心当前会话所用提供方，独立轻量请求（全量走 overview）。
    // 只抓单个 provider，60s 缓存/单飞与全量共用；数据未就绪时返回占位，不阻塞。
    const currentDispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/overview/current',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        try {
          const u = new URL(req.url, 'http://dsh');
          const raw = u.searchParams.get('provider');
          const pid = normalizeProvider(raw);
          let provider = null;
          if (pid && FETCHERS[pid]) {
            try {
              provider = await providerOverview(pid);
            } catch (error) {
              provider = { id: pid, kind: 'unknown', ok: false, error: errorText(error) };
            }
          } else if (raw) {
            provider = { id: raw, kind: 'unsupported', ok: false, unsupported: true };
          }
          if (provider) {
            const m = providerMap[provider.id];
            if (m) provider.label = m.provider_name;
          }
          sendJson(res, 200, {
            ok: true, fetchedAt: Date.now(), provider, usdCnyRate, rateFetchedAt,
            pluginSettings: {
              defaultDays: pluginConfig.defaultDays,
              pollMs: pluginConfig.pollMs,
              retentionDays: pluginConfig.retentionDays,
            },
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    });
    ctx.logger.info('token-monitor: 当前提供方快速路由已注册 GET /token-monitor/overview/current');
    // 已适配供应商清单（设置页展示）：FETCHERS 注册表 × provider_mappings 名称/供应商 × 验证状态。
    const adaptersDispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/adapters',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        try {
          const map = PROVIDER_MAP;
          const adapters = Object.keys(FETCHERS).map((pid) => {
            const m = map[pid];
            return {
              id: pid,
              provider: m ? m.provider_name : pid,
              vendor: m ? (VENDOR_LABELS[m.vendor] || m.vendor) : '',
              adapted: true,
              verified: VERIFIED_PROVIDERS.has(pid),
            };
          });
          // 与 overview 同款排序：DeepSeek 置顶，其余按 id 字母序
          adapters.sort((a, b) => {
            if (a.id === 'deepseek') return -1;
            if (b.id === 'deepseek') return 1;
            return String(a.id).localeCompare(String(b.id), 'zh');
          });
          // 后端按供应商分组：前端直接两层渲染，无需自己算 rowSpan
          const groups = [];
          const groupIdx = {};
          for (const item of adapters) {
            const m = map[item.id];
            const vendorId = m ? m.vendor : '';
            const v = item.vendor || '—';
            if (groupIdx[v] === undefined) {
              groupIdx[v] = groups.length;
              groups.push({ vendor: v, vendorId, providers: [] });
            }
            groups[groupIdx[v]].providers.push({
              id: item.id, provider: item.provider, adapted: item.adapted, verified: item.verified,
            });
          }
          sendJson(res, 200, { ok: true, groups });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    });
    ctx.logger.info('token-monitor: 已适配供应商清单路由已注册 GET /token-monitor/adapters');
    // 提供方映射全表下发（provider_mappings）：客户端供应商/提供方显示名与 vendor 归并
    // 的唯一权威源，客户端动态合并、硬编码表降级为离线兜底（REVIEW #2）。
    const mappingsDispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/provider-mappings',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        try {
          sendJson(res, 200, { ok: true, mappings: PROVIDER_MAP, vendorLabels: VENDOR_LABELS });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    });
    ctx.logger.info('token-monitor: 提供方映射下发路由已注册 GET /token-monitor/provider-mappings');
    return () => { dispose(); currentDispose(); adaptersDispose(); mappingsDispose(); };
  }, 'token-monitor: overview route');

  /* -------------------------- 用量统计（本地 SQLite） -------------------------- */

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const ccDbPath = (config.ccSwitchDb && typeof config.ccSwitchDb === 'string')
    ? config.ccSwitchDb
    : path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  const store = openUsageStore(ctx.logger);
  // 内置价初始化：仅在 model_prices 表为空（首次建表）时写入 DeepSeek 官方当前价，幂等
  seedModelPrices(store.db, ctx.logger);
  // 统一价格入口：model_prices（内置 DeepSeek + 用户维护）→ pi-ai 兜底；
  // getUsdCnyRate 供 CNY 价折算美元 cost（写行时最新汇率）
  const pricing = loadPricing(ctx.logger, store.db, () => usdCnyRate);
  ctx.on('dispose', () => store.close());

  /* ---------- 插件自建配置（$DSH_HOME/storages/token-monitor/config.json） ----------
   * 不依赖 DSH 内部包（dsh-settings/schemastery）：插件自己读配置文件，改配置后重启生效。
   * 默认值：defaultDays=1（当天）/ pollMs=60（余量轮询，单位秒）/ retentionDays=60（请求记录保留天数）。
   * 文件缺失时自动创建一份纯 JSON 默认文件（仅创建、绝不覆盖已有文件）；文件损坏则用默认值但不碰坏文件。
   * 字段含义见 README「插件配置」章节；新增配置项时在 DEFAULTS 补默认值、解析处补校验即可，
   * 已有文件缺新字段会回落默认值，不会被破坏。 */
  const PLUGIN_CONFIG_PATH = path.join(dshHome, 'storages', 'token-monitor', 'config.json');
  const PLUGIN_CONFIG_DEFAULTS = { defaultDays: 1, pollMs: 60, retentionDays: 60 };

  /** 校验并规范化配置片段：只取已知键，非法值回落默认（加载与写回共用同一套规则）。
   *  pollMs 存储单位为秒（设置页与 config.json 一致）；需要毫秒时由消费方单独 ×1000。 */
  function sanitizeConfig(raw) {
    return {
      defaultDays: Number.isInteger(raw.defaultDays) && raw.defaultDays >= 0 && raw.defaultDays <= 3650
        ? raw.defaultDays : PLUGIN_CONFIG_DEFAULTS.defaultDays,
      pollMs: typeof raw.pollMs === 'number' && raw.pollMs >= 5 && raw.pollMs <= 86_400
        ? raw.pollMs : PLUGIN_CONFIG_DEFAULTS.pollMs,
      retentionDays: Number.isInteger(raw.retentionDays) && raw.retentionDays >= 1 && raw.retentionDays <= 3650
        ? raw.retentionDays : PLUGIN_CONFIG_DEFAULTS.retentionDays,
    };
  }

  let pluginConfig = { ...PLUGIN_CONFIG_DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(PLUGIN_CONFIG_PATH, 'utf8'));
    pluginConfig = sanitizeConfig(raw);
    ctx.logger.info(`token-monitor: 插件配置已加载 ${PLUGIN_CONFIG_PATH}`);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // 文件不存在：自动创建一份默认配置（只写新文件；失败不阻断启动）
      try {
        fs.mkdirSync(path.dirname(PLUGIN_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(PLUGIN_CONFIG_PATH,
          `${JSON.stringify({ ...PLUGIN_CONFIG_DEFAULTS }, null, 2)}\n`, 'utf8');
        ctx.logger.info(`token-monitor: 未找到配置文件，已自动创建默认配置 ${PLUGIN_CONFIG_PATH}`);
      } catch (writeError) {
        ctx.logger.warn(`token-monitor: 自动创建配置文件失败：${errorText(writeError)}，使用默认值`);
      }
    } else {
      // 文件存在但损坏：用默认值，不覆盖用户文件（避免静默冲掉手改内容）
      ctx.logger.warn(`token-monitor: 配置文件解析失败（${errorText(error)}），使用默认值且不覆盖文件`);
    }
  }

  // 提供方映射：直接读 provider-mappings.js 常量（单一权威源，不再写库——
  // 此前同步进 provider_mappings 表只是 JS 数据的缓存，徒增迁移面）
  const PROVIDER_MAP = {};
  for (const m of PROVIDER_MAPPING_SEED) {
    PROVIDER_MAP[m.providerId] = { provider_name: m.providerName, vendor: m.vendor, sort_order: m.sortOrder || 0 };
  }

  /* ---------------- 明细定期清理（prune） ----------------
   * usage_requests 是 append-only 事实表，长期运行会无限增长；按天保留期清理。
   * 只删明细不碰 rollup（rollup 是实时增量镜像，历史统计由它继续承载）。
   * 触发挂载在 foldOnce 尾部：高频入口只做 O(1) 内存时间闸比较，真正的清理
   * 每天最多一次。时间闸持久化在 sync_logs（kind='prune'），重启后查库恢复。
   */
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

      // sync_logs 保留期清理（独立于明细清理的量闸，保证每天都会跑一次）：
      // 折叠 / CC 扫描各每 5 分钟写一行，不清理会无限增长；保留 14 天，
      // 每个 source 至少留最新一行（数据来源卡"最近同步"列要读它）。
      const SYNC_LOG_KEEP_MS = 14 * 86_400_000;
      try {
        const purged = store.pruneSyncLogs(now - SYNC_LOG_KEEP_MS);
        if (purged > 0) ctx.logger.info(`token-monitor: sync_logs 清理 ${purged} 行（保留 14 天）`);
      } catch (error) {
        ctx.logger.warn(`token-monitor: sync_logs 清理失败：${errorText(error)}`);
      }

      // 量闸：cutoff 按本地午夜对齐完整天（绝不半截清掉"今天"）；
      // 库里没有比 cutoff 更早的明细就不值得清（也推进时间闸，避免每轮都查库）
      const d = new Date(now);
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const cutoffDay = dayOf(midnight - pluginConfig.retentionDays * 86_400_000);
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
  // 最近一轮折叠的健康统计（"失效可见"）：随 /usage/sources 下发给数据来源卡告警。
  // 折叠本身只写库，这里保留一份内存快照供前端读取，避免为展示再查一次库。
  let lastFoldHealth = null;
  // 升级单飞闸（/upgrade）：一次只允许跑一个升级子进程；失败/异常也会在 finally 释放。
  let upgradeBusy = false;
  function foldOnce() {
    if (folding) return folding;
    const task = Promise.resolve().then(() => {
      const startedAt = Date.now();
      try {
        const r = foldAllSessions(store, pricing, dshHome, ctx.logger);
        lastFoldHealth = { at: Date.now(), ...r.health };
        // 审计行：数据来源卡"最近同步"列据此显示"最近一轮折叠导入了多少条"。
        // 与 cc-switch 的 db-scan 同样每轮都写，便于判断定时折叠是否还活着；写失败只告警不影响折叠。
        try {
          store.recordSyncLog({
            source: 'dsh-logs', kind: 'fold', startedAt,
            finishedAt: Date.now(), status: r.errors.length ? 'partial' : 'ok',
            imported: r.imported, skipped: r.skipped, skippedUnknownApp: 0,
            watermark: null, filesScanned: r.filesScanned, errors: r.errors,
          });
        } catch (error) {
          ctx.logger.warn(`token-monitor: 折叠审计写入失败：${errorText(error)}`);
        }
        if (r.imported > 0 || r.errors.length > 0) {
          ctx.logger.info(`token-monitor: 折叠完成，新增 ${r.imported} 行（扫描 ${r.filesScanned} 个文件）`);
        }
        // 有异常（读不出 header / 认不出的日志名 / 有事件却 0 行）时记一条审计，
        // 让"日志格式变了"这类问题在 sync_logs 里留痕，而不是只活在内存里
        const h = r.health;
        if (h.noHeader.length || h.unreadable.length || h.unrecognizedLogs.length || h.emptyUsage.length) {
          ctx.logger.warn(
            `token-monitor: 折叠健康告警 —— 读不出 header ${h.noHeader.length} 个、`
            + `不可读 ${h.unreadable.length} 个、命名不认识 ${h.unrecognizedLogs.length} 个、`
            + `有事件但 0 用量行 ${h.emptyUsage.length} 个`,          );
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

  // 启动即折一轮（不阻塞插件加载），之后按固定周期增量折叠（周期为内置常量 FOLD_INTERVAL_MS，不再可配）
  const bootFold = setImmediate(foldOnce);
  const foldTimer = setInterval(foldOnce, FOLD_INTERVAL_MS);
  ctx.on('dispose', () => {
    clearImmediate(bootFold);
    clearInterval(foldTimer);
  });

  // CC-switch 自动同步（§11.3）：与折叠同周期（FOLD_INTERVAL_MS）、独立防重入。
  // 每轮先探测 cc-switch.db：不存在（未安装/未初始化）即跳过，出现后下一轮自动接管，无需重启。
  // 幂等：record_id = CC request_id + INSERT OR IGNORE + db-scan watermark；失败只记状态
  // （弹层据其显示"自动同步失败"条），下一轮自动重试。
  let ccSyncing = null;
  let ccAuto = { at: 0, ok: null, error: null, imported: 0 };
  function ccAutoSync() {
    if (ccSyncing) return ccSyncing;
    const task = Promise.resolve().then(() => {
      try {
        if (!fs.existsSync(ccDbPath)) return; // 无 cc-switch 数据：不推进状态（安装后自动接管）
        const r = importCcSwitch(store, ccDbPath, ctx.logger, pricing);
        ccAuto = { at: Date.now(), ok: !r.error, error: r.error || null, imported: r.imported || 0 };
        if (r.error) ctx.logger.warn(`token-monitor: cc-switch 自动同步失败：${errorText(r.error)}`);
      } catch (error) {
        ccAuto = { at: Date.now(), ok: false, error: errorText(error), imported: 0 };
        ctx.logger.warn(`token-monitor: cc-switch 自动同步异常：${errorText(error)}`);
      } finally {
        if (ccSyncing === task) ccSyncing = null;
      }
    });
    ccSyncing = task;
    return task;
  }
  const bootCc = setImmediate(ccAutoSync);
  const ccTimer = setInterval(ccAutoSync, FOLD_INTERVAL_MS);
  ctx.on('dispose', () => {
    clearImmediate(bootCc);
    clearInterval(ccTimer);
  });

  /** 写回配置：读现有文件（可能不存在）→ 合并已知键更新 → 写回 → 更新内存。
   * 未知键（用户手加的字段）原样保留；已废弃的 foldIntervalMs 不再写入（config.json 随之清理）。
   * 损坏文件以空对象为基底（用户显式保存即认可覆盖）；写文件失败抛错，由路由调用方返回 500。 */
  function savePluginConfig(update) {
    let current = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(PLUGIN_CONFIG_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
    } catch { /* 不存在/损坏：空基底 */ }
    const next = sanitizeConfig({ ...current, ...update });
    const merged = { ...current, ...next };
    delete merged.foldIntervalMs; // 已从配置移除的废弃键，避免残留
    fs.mkdirSync(path.dirname(PLUGIN_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(PLUGIN_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    pluginConfig = next;
    ctx.logger.info(`token-monitor: 配置已保存 ${PLUGIN_CONFIG_PATH}`);
    return { ...next };
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/config',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        let body = '';
        try {
          try { body = await readBody(req); } catch (error) { sendJson(res, error.code === BODY_TOO_LARGE ? 413 : 400, { ok: false, error: errorText(error) }); return; }
        } catch (error) {
          sendJson(res, 400, { ok: false, error: errorText(error) });
          return;
        }
        let update;
        try { update = JSON.parse(body || '{}'); } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
        if (!update || typeof update !== 'object' || Array.isArray(update)) {
          sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
          return;
        }
        // 至少包含一个已知配置字段才写（空对象/只含未知键属于无意义写入，明确拒绝）
        const KNOWN_KEYS = ['defaultDays', 'pollMs', 'retentionDays'];
        if (!KNOWN_KEYS.some((k) => k in update)) {
          sendJson(res, 400, { ok: false, error: '没有可保存的配置字段' });
          return;
        }
        try {
          const saved = savePluginConfig(update);
          sendJson(res, 200, { ok: true, pluginSettings: saved });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    });
    ctx.logger.info('token-monitor: 配置写回路由已注册 POST /token-monitor/config');
    return dispose;
  }, 'token-monitor: config route');

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  /** 纳美元 → 美元数值（展示换算，§5）。 */
  const toUsd = (nano) => (nano === null || nano === undefined ? null : Number(nano) / 1e9);

  function windowStartDay(days) {
    if (days === 0) return '0000-01-01'; // "全部"时间窗：无时间下限
    if (days === -1) return dayOf(Date.now() - 86_400_000); // "昨天"：昨天单天
    const n = Number.isInteger(days) && days > 0 && days <= 3650 ? days : 30;
    return dayOf(Date.now() - (n - 1) * 86_400_000);
  }

  /** 时间窗 SQL 条件：days=0 不加；days=-1（昨天）限定 [昨天, 今天)；其余 [start, ∞)。
   *  prefix 用于明细表列前缀（如 r.day）。 */
  function pushWindowCond(conds, args, days, prefix = '') {
    if (days === 0) return;
    const col = `${prefix}day`;
    if (days === -1) {
      const now = Date.now();
      conds.push(`${col} >= ?`); args.push(dayOf(now - 86_400_000));
      conds.push(`${col} < ?`); args.push(dayOf(now));
      return;
    }
    conds.push(`${col} >= ?`); args.push(windowStartDay(days));
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
  let providerMap = PROVIDER_MAP;
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
          pushWindowCond(conds, args, days);
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
        pushWindowCond(conds, args, days);
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
        pushWindowCond(conds, args, days);
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
        if (denyUntrusted(req, res)) return;
        if (req.method === 'POST') {
          let body = '';
          try { body = await readBody(req); } catch (error) { sendJson(res, error.code === BODY_TOO_LARGE ? 413 : 400, { ok: false, error: errorText(error) }); return; }
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
        // 汇率：后台触发拉取（fire-and-forget，不阻塞响应），随 sources 下发供前端费用换算
        refreshUsdCnyRate();
        // 每来源最近有记录的时间（数据来源卡"最近更新"列；无记录为 null）
        const lastUpdated = {};
        for (const s of ['dsh-logs', 'cc-switch']) {
          try {
            const r = store.db.prepare('SELECT MAX(created_at) AS m FROM usage_requests WHERE source = ?').get(s);
            lastUpdated[s] = r && r.m ? r.m : null;
          } catch {
            lastUpdated[s] = null;
          }
        }
        // 每来源"最近一次真正有新增的同步"（数据来源卡"最近同步"列）。
        // 口径两句话：
        //  ① 只看**明细**导入——限定 fold / db-scan / file-import / sql-import，
        //     排除 db-rollup（那是 cc-switch 的"按天聚合"表，75 行是 75 天、不是 75 条请求，
        //     量纲不同）与 prune（清理审计，本就不是同步）；
        //  ② 优先取最近一条 imported > 0 的行，该源从未有过新增时退回最近一条。
        // 为什么不是"最近一条"：折叠/扫描每 5 分钟一轮，空转轮会把上一轮的条数冲成 0，
        // 于是出现"最近更新时间有、最近同步却是 0 条"的割裂观感。
        const lastSync = {};
        for (const s of ['dsh-logs', 'cc-switch']) {
          try {
            const row = store.db.prepare(`
              SELECT kind, status, imported, skipped, files_scanned, finished_at
              FROM sync_logs
              WHERE source = ? AND kind IN ('fold', 'db-scan', 'file-import', 'sql-import')
              ORDER BY (imported > 0) DESC, id DESC LIMIT 1
            `).get(s);
            lastSync[s] = row
              ? { kind: row.kind, status: row.status, imported: row.imported, skipped: row.skipped, files: row.files_scanned, at: row.finished_at }
              : null;
          } catch {
            lastSync[s] = null;
          }
        }
        sendJson(res, 200, {
          ok: true,
          dshSessions: dirs.dsh,
          ccSwitchDb: ccDbPath,
          usdCnyRate,
          rateFetchedAt,
          version: PLUGIN_VERSION,
          lastUpdated,
          lastSync,
          // 折叠健康统计（最近一轮）：前端据此在数据来源卡上告警"日志读不出来/格式可能已变"
          foldHealth: lastFoldHealth,
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
        if (denyUntrusted(req, res)) return;
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

  // 模型定价维护（model_prices 表，见 docs/PRICING-DESIGN.md）：
  // GET 返回"当前正在生效"的版本列表（start_time <= now < end_time；未开始的未来档、已封口的旧档都不列）。
  // POST 保存一模型价格：封口当前生效行 + 插入新版本（从现在起生效）。
  // 新增路由独立 effect，不触碰既有表与逻辑。
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/model-prices',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
        try {
          const url = new URL(req.url, 'http://localhost');
          if (req.method === 'GET') {
            const now = Date.now();
            const rows = store.db.prepare(`
              SELECT model, display_name, mode, currency,
                     input_cache_hit_price, input_price, output_price, cache_create_price,
                     start_time, end_time, source, peak_multiplier, peak_windows
              FROM model_prices
              WHERE start_time <= ? AND end_time > ?
              ORDER BY model
            `).all(now, now);
            sendJson(res, 200, {
              ok: true,
              rows: rows.map((r) => ({
                model: r.model, displayName: r.display_name, mode: r.mode, currency: r.currency,
                cacheHitInput: p4ToYuan(r.input_cache_hit_price),
                input: p4ToYuan(r.input_price),
                output: p4ToYuan(r.output_price),
                cacheCreate: p4ToYuan(r.cache_create_price),
                startTime: r.start_time, endTime: r.end_time, source: r.source,
                peakMultiplier: r.peak_multiplier, peakWindows: r.peak_windows,
              })),
            });
            return;
          }
          if (req.method === 'POST') {
            let body = '';
            try { body = await readBody(req); } catch (error) { sendJson(res, error.code === BODY_TOO_LARGE ? 413 : 400, { ok: false, error: errorText(error) }); return; }
            let b;
            try { b = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { ok: false, error: 'JSON 无效' }); return; }
            const model = typeof b.model === 'string' ? b.model.trim() : '';
            if (!model) { sendJson(res, 400, { ok: false, error: '缺少模型名' }); return; }
            const mode = b.mode === 'time' ? 'time' : 'fixed';
            const currency = b.currency === 'CNY' ? 'CNY' : 'USD';
            const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
            const hit = num(b.cacheHitInput); const input = num(b.input); const output = num(b.output);
            const cacheCreate = b.cacheCreate === undefined || b.cacheCreate === null || b.cacheCreate === '' ? 0 : num(b.cacheCreate);
            if (!(isFinite(hit) && isFinite(input) && isFinite(output) && isFinite(cacheCreate))) {
              sendJson(res, 400, { ok: false, error: '价格必须为数字' });
              return;
            }
            // mode='time' 的高峰倍率（模型级，独立字段 peak_multiplier）：默认 2，须 > 0；fixed 不适用（存 NULL）
            const pkRaw = num(b.multiplier);
            const peakMultiplier = mode === 'time'
              ? (isFinite(pkRaw) && pkRaw > 0 ? pkRaw : 2)
              : null;
            // mode='time' 的高峰窗口（时段，不含倍率）：
            // 优先 windows：[{ days:'1-5'|'6,7'|'*', start:'HH:mm', end:'HH:mm' }, …]
            // 其次 peakTimes 时段串兼容；最后 peakWindows JSON 兼容；缺省"工作日 09-12 / 14-18"
            const DEFAULT_WINDOWS = JSON.stringify({
              timezone: 'Asia/Shanghai',
              windows: [
                { days: '1-5', start: '09:00', end: '12:00' },
                { days: '1-5', start: '14:00', end: '18:00' },
              ],
            });
            const validTime = (s) => /^\d{1,2}:\d{2}$/.test(String(s || ''));
            let peakWindows = null;
            if (mode === 'time') {
              if (Array.isArray(b.windows)) { // 空数组 = 无高峰（全天按基础价）
                const spans = b.windows.map((w) => {
                  const days = w && w.days;
                  if (!(days === '1-5' || days === '6,7' || days === '*')) throw new Error(`高峰时段的日期范围只能为 工作日(1-5)/周末(6,7)/每天(*)，收到：${String(days)}`);
                  if (!validTime(w.start) || !validTime(w.end)) throw new Error(`高峰时段时间应为 HH:mm（如 09:00），收到：${String(w.start)}-${String(w.end)}`);
                  return { days, start: String(w.start), end: String(w.end) };
                });
                peakWindows = JSON.stringify({ timezone: 'Asia/Shanghai', windows: spans });
              } else if (typeof b.peakTimes === 'string' && b.peakTimes.trim()) {
                const spans = b.peakTimes.split(',').map((s) => s.trim()).filter(Boolean)
                  .map((seg) => {
                    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(seg);
                    if (!m) throw new Error(`高峰时段格式应为 HH:mm-HH:mm（如 09:00-12:00），收到：${seg}`);
                    return { days: '1-5', start: m[1], end: m[2] };
                  });
                if (spans.length === 0) throw new Error('高峰时段不能为空');
                peakWindows = JSON.stringify({ timezone: 'Asia/Shanghai', windows: spans });
              } else if (b.peakWindows && typeof b.peakWindows === 'string') {
                peakWindows = b.peakWindows;
              } else {
                peakWindows = DEFAULT_WINDOWS;
              }
            }
            const now = Date.now();
            // 生效起点（ms）：缺省 = 当前时刻；可给未来时间 = 预约调价（到点自动生效）；
            // 早于当前时间则收拢到现在（历史不刷，不接受过去生效）。
            const stRaw = num(b.startTime);
            const startTime = isFinite(stRaw) && stRaw > 0 ? Math.max(stRaw, now) : now;
            const clash = store.db.prepare('SELECT 1 AS x FROM model_prices WHERE model = ? AND start_time = ?').get(model, startTime);
            if (clash) {
              sendJson(res, 400, { ok: false, error: `该生效时刻已有价格版本（${model}），请换一个开始时间` });
              return;
            }
            store.db.exec('BEGIN');
            try {
              // 封口"开始时刻之前仍在生效"的行：现在/过去开始 = 封当前生效行到开始时刻；
              // 未来开始（预约）= 把将先到期的当前行/已公布档也封到开始时刻，保证无重叠。
              store.db.prepare('UPDATE model_prices SET end_time = ? WHERE model = ? AND start_time <= ? AND end_time > ?')
                .run(startTime, model, startTime, startTime);
              store.db.prepare(`
                INSERT INTO model_prices
                  (model, display_name, mode, currency,
                   input_cache_hit_price, input_price, output_price, cache_create_price,
                   start_time, end_time, source, created_at, peak_multiplier, peak_windows)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', ?, ?, ?)
              `).run(model,
                (typeof b.displayName === 'string' && b.displayName.trim()) ? b.displayName.trim() : model,
                mode, currency,
                yuanToP4(hit), yuanToP4(input), yuanToP4(output), yuanToP4(cacheCreate),
                startTime, VALID_UNTIL_OPEN, now, peakMultiplier, peakWindows);
              store.db.exec('COMMIT');
            } catch (error) {
              store.db.exec('ROLLBACK');
              throw error;
            }
              sendJson(res, 200, { ok: true, model, mode, currency, multiplier: peakMultiplier, startTime });
              return;
          }
          res.writeHead(405, { allow: 'GET, POST' });
          res.end();
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    });
    ctx.logger.info('token-monitor: 模型定价路由已注册 GET/POST /token-monitor/model-prices');
    return dispose;
  }, 'token-monitor: model-prices route');

  // 手动触发"内置价同步到已有库"（随包发版后执行一次；尊重用户自定义，见 syncBuiltinPrices）
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/prices/sync-builtin',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        try {
          const result = syncBuiltinPrices(store.db, ctx.logger);
          sendJson(res, result.ok ? 200 : 500, result);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) });
        }
      },
    });
    ctx.logger.info('token-monitor: 内置价同步路由已注册 POST /token-monitor/prices/sync-builtin');
    return dispose;
  }, 'token-monitor: prices sync-builtin route');

  // 手动触发一轮日志折叠（定时器之外的另一驱动：页面打开后后台调用、手动刷新按钮）
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/fold',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
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
          if (denyUntrusted(req, res)) return;
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
          if (denyUntrusted(req, res)) return;
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' });
            res.end();
            return;
          }
          try {
            const pending = checkCcPending(store, ccDbPath);
            sendJson(res, 200, {
              ok: true,
              pending,
              // 5 分钟自动同步最近一次失败（仅失败时携带；成功/无状态为 null → 前端不打扰）
              auto: ccAuto.error ? { error: ccAuto.error, at: ccAuto.at, imported: ccAuto.imported } : null,
            });
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
          if (denyUntrusted(req, res)) return;
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

  ctx.effect(() => {
    const disposers = [
      // DSH 用量导出：下载本机 dsh-logs 全量快照（明细 + rollup 的 JSON），
      // 跨设备手动同步用（另一台设备"导入"后合并，§2.2/§11.3 扩展）。
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/export/dsh',
        handler: async (req, res) => {
          if (denyUntrusted(req, res)) return;
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' });
            res.end();
            return;
          }
          try {
            const payload = exportDshUsage(store);
            const body = JSON.stringify(payload);
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="${exportFileName()}"`,
              'cache-control': 'no-store',
            });
            res.end(body);
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) });
          }
        },
      }),
      // DSH 用量导入：body = 导出文件内容（UTF-8 JSON 文本），幂等合并
      // （明细 INSERT OR IGNORE + rollup 覆盖 upsert）。保存到临时文件后读，
      // 与 CC sql-import 同思路：内容大时避免整块驻留内存。
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/import/dsh',
        handler: async (req, res) => {
          if (denyUntrusted(req, res)) return;
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          try {
            const tmp = path.join(os.tmpdir(), `dsh-import-${Date.now()}.json`);
            const ws = fs.createWriteStream(tmp);
            for await (const chunk of req) ws.write(chunk);
            await new Promise((resolve, reject) => { ws.end(resolve); ws.on('error', reject); });
            try {
              const text = await fs.promises.readFile(tmp, 'utf8');
              const result = importDshUsage(store, text, ctx.logger);
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
    ctx.logger.info('token-monitor: DSH 导入/导出路由已注册');
    return () => disposers.forEach((d) => d());
  }, 'token-monitor: dsh sync routes');

  /* ---------------- 前端静态资源（echarts） ---------------- */

  // DSH 的 /plugins/<id>/ 路由只认 client.js，第三方库走自己的路由分发。
  ctx.effect(() => {
    const vendorFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'util', 'echarts.min.js');
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/token-monitor/echarts.min.js',
      handler: async (req, res) => {
        if (denyUntrusted(req, res)) return;
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
          res.end(`echarts 静态文件缺失：${errorText(error)}`);
        }
      },
    });
    ctx.logger.info('token-monitor: echarts 静态路由已注册');
    return dispose;
  }, 'token-monitor: echarts route');

  /* ---------------- 版本检查与升级（设置页"版本更新"行） ----------------
   * 实现见 util/market-upgrade.js：按插件市场同款思路——profile 动态定位、
   * 子进程环境补全、npm 渠道钉版本升级、落盘版本双重校验、link 渠道拒绝、
   * 服务端插件更新后需重启 dsh web 生效（restartRequired）。 */

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/version',
        handler: async (req, res) => {
          if (denyUntrusted(req, res)) return;
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' });
            res.end();
            return;
          }
          try {
            const info = await versionInfo();
            sendJson(res, 200, {
              ok: true,
              current: PLUGIN_VERSION,   // 当前正在运行的代码版本（升级后重启前仍是旧值）
              latest: info.latest || null,
              hasUpdate: !!info.hasUpdate,
              channel: info.channel,
              dep: info.dep,
              profile: info.profile,
              installed: info.installed,
            });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/token-monitor/upgrade',
        handler: async (req, res) => {
          if (denyUntrusted(req, res)) return;
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          // 单飞：升级是重操作（跑 pnpm，最长 5 分钟），并发触发只会排队做重复工作。
          // 前端按钮虽有 disabled，但那只是 UI 状态，这里必须服务端兜底。
          if (upgradeBusy) {
            sendJson(res, 200, { ok: false, code: 'busy', error: '已有升级正在进行，请稍候' });
            return;
          }
          upgradeBusy = true;
          try {
            const result = await upgradePlugin();
            if (result.ok) sendJson(res, 200, result);
            else sendJson(res, 200, { ok: false, error: result.message || '升级失败', code: result.code, detail: result.detail });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) });
          } finally {
            upgradeBusy = false;
          }
        },
      }),
    ];
    ctx.logger.info('token-monitor: 版本检查/升级路由已注册');
    return () => disposers.forEach((d) => d());
  }, 'token-monitor: version routes');
}
