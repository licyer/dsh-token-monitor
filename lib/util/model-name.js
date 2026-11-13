/**
 * 展示用模型名归一（只影响聚合分组与显示，不改库里存的原始值）。
 *
 * 日志里的 model 取自 `message.source.model`，不同路由 / 不同版本写法不同：
 *  - 转手上游会带 vendor 前缀：`deepseek/deepseek-v4.1-flash`、`moonshotai/Kimi-K3`
 *  - 同一个模型还可能以不同 id 出现：Kimi 官方 id 是 `k3`，日志里也有 `Kimi-K3`
 *
 * 注意：**名字相近不等于同款**，以下这些都**不能**合并（已确认是不同模型）：
 *  - `deepseek-flash` ≠ `deepseek-v4-flash`
 *  - `kimi-for-coding`（官方模型）≠ `k3`
 *  - `k3-256k`（256k 上下文档）≠ `k3`
 */

/** 去掉 vendor 前缀之后仍需要对映的名字（键统一小写比较）。 */
const ALIASES = Object.freeze({
  // Command Code 转手的「DeepSeek V4.1 Flash」实际就是 deepseek-flash（与取价别名同口径）
  'deepseek-v4.1-flash': 'deepseek-flash',
  // Kimi 官方模型 id 是 k3；转手上游写作 Kimi-K3 / moonshotai/Kimi-K3
  'kimi-k3': 'k3',
});

/**
 * 模型名归一：先去掉最后一个 `/` 之前的 vendor 前缀，再查显式别名。
 * @param {string} model 原始模型名
 * @returns {string} 归一后的名字（无法识别时原样返回，绝不猜测）
 */
export function normalizeModelName(model) {
  if (typeof model !== 'string' || model === '') return model;
  const slash = model.lastIndexOf('/');
  const base = slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
  return ALIASES[base.toLowerCase()] || base;
}
