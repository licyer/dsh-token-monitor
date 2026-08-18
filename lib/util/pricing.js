/**
 * 定价模块：读取 pi-ai 本地模型目录（随 DSH 安装），把刊例价（$/百万 token，
 * 可有 4 位小数，如 deepseek cacheRead 0.0028）换算为整数价格供费用计算。
 *
 * 定点方案（避免浮点）：价格量化到"万分之一美元/百万 token"（P4 整数），
 * 单次调用费用 cost_nano = round(tokens × P4 / 10)，单位 1e-9 美元。
 * 每次请求的取整误差 ≤ 0.5 纳美元（$5e-10），累加精确（整数加法）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 定位 pi-ai 的 providers/data 目录。 */
function findDataDir() {
  const candidates = [];
  // DSH Host 进程内 argv[1] 是启动器（<dsh>/lib/bin.js），数据在 <dsh>/node_modules 下
  if (process.argv[1]) {
    const dshRoot = path.dirname(path.dirname(process.argv[1]));
    candidates.push(path.join(dshRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'));
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // 兜底：require 解析
  try {
    const req = createRequire(process.argv[1] ? path.join(path.dirname(process.argv[1]), 'noop.js') : import.meta.url);
    const pkg = req.resolve('@earendil-works/pi-ai/package.json');
    const dir = path.join(path.dirname(pkg), 'dist', 'providers', 'data');
    if (fs.existsSync(dir)) return dir;
  } catch { /* 找不到则定价缺失 */ }
  return null;
}

/** 价格（$/1M token，可 4 位小数）→ P4 整数（1e-4 $/1M token）。 */
function toP4(price) {
  const n = Number(price);
  return isFinite(n) ? Math.round(n * 1e4) : 0;
}

/**
 * 加载全部目录文件，建两级索引：
 * byRoute: '<provider>/<model>' → 价格；byModel: model → 价格（先见先得，供 CC 行按模型名兜底）。
 */
export function loadPricing(logger) {
  const byRoute = new Map();
  const byModel = new Map();
  const providerByModel = new Map();
  const dir = findDataDir();
  if (!dir) {
    logger?.warn?.('token-monitor: 未找到 pi-ai 模型目录，所有费用标记为未定价');
    return { priceFor: () => null, costNano: () => null, providerOf: () => null, dir: null };
  }
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
        };
        byRoute.set(`${provider}/${model}`, price);
        if (!byModel.has(model)) byModel.set(model, price);
        // 模型 → 供应商反查（先见先得）：cc-switch 导入只有模型名、没有真实供应商时用
        if (!providerByModel.has(model)) providerByModel.set(model, provider);
      }
    }
  }
  logger?.info?.(`token-monitor: 定价目录已加载（${byRoute.size} 条路由价格，来自 ${dir}）`);

  function priceFor(provider, model) {
    return byRoute.get(`${provider}/${model}`) || byModel.get(model) || null;
  }

  /** 单次调用费用（纳美元），未定价返回 null。 */
  function costNano(provider, model, usage) {
    const p = priceFor(provider, model);
    if (!p) return null;
    return Math.round(
      (usage.input * p.input + usage.output * p.output
        + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 10,
    );
  }

  /** 模型 → 供应商反查（cc-switch 导入推断真实供应商用）；查不到返回 null。 */
  function providerOf(model) {
    return providerByModel.get(model) || null;
  }

  return { priceFor, costNano, providerOf, dir };
}
