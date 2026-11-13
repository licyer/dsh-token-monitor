/**
 * 提供方映射种子数据：provider_id（库内存储的提供方 ID）→ 提供方名称 + 供应商。
 *
 * 规则：
 * - vendor 归并：同一厂商的不同提供方（国内/国际、套餐/走量、token-plan 等）归同一 vendor。
 *   如 kimi-coding / moonshotai-cn / moonshotai → kimi（月之暗面）。
 * - provider_name 保留具体提供方（路由/账号体系）名，供明细/组合列展开。
 * - 纯网关/代理类（openrouter、vercel-ai-gateway、cloudflare 等）vendor 用自身名。
 *
 * 数据来源：pi-ai 本地模型目录（@earendil-works/pi-ai）2026-08 各 provider 文件的模型归属。
 */

/** [{ providerId, providerName, vendor, sortOrder? }] */
export const PROVIDER_MAPPING_SEED = [
  // ---- DeepSeek（只按量） ----
  { providerId: 'deepseek', providerName: 'DeepSeek', vendor: 'deepseek', sortOrder: 0 },
  // 桌面版"账号登录"渠道：与单独配置的 key 同属 DeepSeek 官方，供应商统计归并到同一
  // vendor（用量页统计/筛选合并为 DeepSeek）；但提供方名保留完整——弹层的提供方列表
  // 与当前卡片要能区分渠道，两个渠道可能是不同账户，余额不能混同。
  { providerId: 'deepseek-account', providerName: 'DeepSeek Account', vendor: 'deepseek' },

  // ---- 月之暗面 / Kimi ----
  { providerId: 'kimi-coding', providerName: 'Kimi For Coding', vendor: 'kimi' },
  { providerId: 'moonshotai-cn', providerName: 'Moonshot AI（CN）', vendor: 'kimi' },
  { providerId: 'moonshotai', providerName: 'Moonshot AI', vendor: 'kimi' },

  // ---- 智谱 ----
  // 一条覆盖两种接入：DSH 原生路由 glm-code-plan（GLM_CODE_PLAN_API_KEY）与 pi-ai 渠道
  // zai-coding-cn（ZAI_CODING_CN_API_KEY）——两者打同一个官方额度端点、同一套解析与渲染，
  // 已把 zai-coding-cn 在 fold 层归一到 glm-code-plan，不再单列条目。
  { providerId: 'glm-code-plan', providerName: 'GLM Coding Plan', vendor: 'zhipu' },
  { providerId: 'zai', providerName: 'GLM', vendor: 'zhipu' },

  // ---- 阿里通义 ----
  { providerId: 'qwen-token-plan-cn', providerName: 'Qwen Token Plan（CN）', vendor: 'qwen' },
  { providerId: 'qwen-token-plan', providerName: 'Qwen Token Plan', vendor: 'qwen' },

  // ---- MiniMax ----
  { providerId: 'minimax-cn', providerName: 'MiniMax（CN）', vendor: 'minimax' },
  { providerId: 'minimax', providerName: 'MiniMax', vendor: 'minimax' },

  // ---- 小米 ----
  { providerId: 'xiaomi-token-plan-cn', providerName: 'Xiaomi Token Plan（CN）', vendor: 'xiaomi' },
  { providerId: 'xiaomi-token-plan-ams', providerName: 'Xiaomi Token Plan（AMS）', vendor: 'xiaomi' },
  { providerId: 'xiaomi-token-plan-sgp', providerName: 'Xiaomi Token Plan（SGP）', vendor: 'xiaomi' },
  { providerId: 'xiaomi', providerName: '小米', vendor: 'xiaomi' },

  // ---- 蚂蚁灵积 ----
  { providerId: 'ant-ling', providerName: '蚂蚁灵积 Ling', vendor: 'ant-ling' },

  // ---- Anthropic / OpenAI / Google 官方 ----
  { providerId: 'anthropic', providerName: 'Anthropic', vendor: 'anthropic' },
  { providerId: 'openai', providerName: 'OpenAI', vendor: 'openai' },
  { providerId: 'openai-codex', providerName: 'OpenAI Codex', vendor: 'openai' },
  { providerId: 'chatgpt-codex', providerName: 'ChatGPT Codex', vendor: 'openai' },
  { providerId: 'google', providerName: 'Google Gemini', vendor: 'google' },
  { providerId: 'google-vertex', providerName: 'Google Vertex', vendor: 'google' },
  { providerId: 'xai', providerName: 'xAI', vendor: 'xai' },
  { providerId: 'mistral', providerName: 'Mistral', vendor: 'mistral' },

  // ---- OpenCode ----
  { providerId: 'opencode-go', providerName: 'OpenCode Go', vendor: 'opencode' },
  { providerId: 'opencode', providerName: 'OpenCode', vendor: 'opencode' },

  // ---- Command Code ----
  { providerId: 'commandcode', providerName: 'Command Code', vendor: 'commandcode' },

  // ---- 网关 / 聚合 / 云平台 ----
  { providerId: 'openrouter', providerName: 'OpenRouter', vendor: 'openrouter' },
  { providerId: 'vercel-ai-gateway', providerName: 'Vercel AI Gateway', vendor: 'vercel-ai-gateway' },
  { providerId: 'cloudflare-ai-gateway', providerName: 'Cloudflare AI Gateway', vendor: 'cloudflare' },
  { providerId: 'cloudflare-workers-ai', providerName: 'Cloudflare Workers AI', vendor: 'cloudflare' },
  { providerId: 'github-copilot', providerName: 'GitHub Copilot', vendor: 'github-copilot' },
  { providerId: 'azure-openai-responses', providerName: 'Azure OpenAI', vendor: 'azure-openai' },
  { providerId: 'amazon-bedrock', providerName: 'Amazon Bedrock', vendor: 'amazon-bedrock' },
  { providerId: 'huggingface', providerName: 'Hugging Face', vendor: 'huggingface' },
  { providerId: 'groq', providerName: 'Groq', vendor: 'groq' },
  { providerId: 'cerebras', providerName: 'Cerebras', vendor: 'cerebras' },
  { providerId: 'nvidia', providerName: 'NVIDIA', vendor: 'nvidia' },
  { providerId: 'together', providerName: 'Together AI', vendor: 'together' },
  { providerId: 'fireworks', providerName: 'Fireworks AI', vendor: 'fireworks' },

  // ---- 兜底/未知 ----
  { providerId: 'unknown', providerName: '未知', vendor: 'unknown' },
  { providerId: 'cc-switch', providerName: 'cc-switch', vendor: 'cc-switch' },
];

/** vendor id → 供应商展示名（供应商聚合时的分组名）。未列出的 vendor 用其首个 provider 的提供方名。 */
export const VENDOR_LABELS = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  zhipu: '智谱（GLM）',
  qwen: '通义（Qwen）',
  minimax: 'MiniMax',
  xiaomi: '小米（Xiaomi）',
  'ant-ling': '蚂蚁灵积（Ling）',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  mistral: 'Mistral',
  opencode: 'OpenCode',
  commandcode: 'Command Code',
  openrouter: 'OpenRouter',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  cloudflare: 'Cloudflare',
  'github-copilot': 'GitHub Copilot',
  'azure-openai': 'Azure OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  huggingface: 'Hugging Face',
  groq: 'Groq',
  cerebras: 'Cerebras',
  nvidia: 'NVIDIA',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  unknown: '未知',
  'cc-switch': 'cc-switch',
};

/**
 * providerId → 官网/管理页入口（前端"↗ 详情"链接）。
 * 值可以是字符串（不区分计费类型），或 { balance, quota }（按量充值页 / 订阅续费页分开）。
 *
 * 这里下发后，前端不再需要维护自己的一份 url 表——新增提供方只改这个文件即可。
 * 未列出的提供方前端不显示链接（不会报错）。
 */
export const PROVIDER_URL_SEED = {
  deepseek: 'https://platform.deepseek.com/top_up',
  'deepseek-account': 'https://platform.deepseek.com/top_up',
  'kimi-coding': { quota: 'https://www.kimi.com/code/console?from=kfc_overview_topbar', balance: 'https://platform.kimi.com/console/pay' },
  'moonshotai-cn': { quota: 'https://www.kimi.com/code/console?from=kfc_overview_topbar', balance: 'https://platform.kimi.com/console/pay' },
  moonshotai: { quota: 'https://www.kimi.com/code/console?from=kfc_overview_topbar', balance: 'https://platform.kimi.com/console/pay' },
  'glm-code-plan': 'https://bigmodel.cn/coding-plan/personal/overview',
  zai: 'https://bigmodel.cn/finance-center/finance/pay',
  'qwen-token-plan-cn': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview',
  'qwen-token-plan': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview',
  'minimax-cn': 'https://platform.minimaxi.com/subscribe/token-plan',
  minimax: 'https://platform.minimaxi.com/subscribe/token-plan',
  'xiaomi-token-plan-cn': { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  'xiaomi-token-plan-ams': { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  'xiaomi-token-plan-sgp': { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  xiaomi: { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  'opencode-go': 'https://opencode.ai/zh/go',
  'chatgpt-codex': 'https://chatgpt.com/codex/settings/usage',
  commandcode: 'https://commandcode.ai/billing',
  openrouter: 'https://openrouter.ai/settings/credits',
};

/**
 * 按模型名推断所属厂商（仅用于「模型定价」列表分组排序，不参与计费/归并）。
 * 作用：设置页里先按厂商聚在一起，再按时间排序，避免 DeepSeek 与 Kimi 交错排列。
 * 未命中任何规则的返回 undefined（调用方把它排在最后）。
 */
const MODEL_VENDOR_RULES = [
  [/^deepseek|^ds[-_]/, 'deepseek'],
  [/^k[23](?:[.-]|$)|^kimi|^moonshot/, 'kimi'],
  [/^glm|^zhipu|^chatglm/, 'zhipu'],
  [/^qwen|^qwq/, 'qwen'],
  [/^minimax|^m[23](?:[.-]|$)|^abab/, 'minimax'],
  [/^mimo/, 'xiaomi'],
  [/^claude/, 'anthropic'],
  [/^gpt|^o[134](?:[.-]|$)|^codex/, 'openai'],
  [/^gemini|^gemma/, 'google'],
  [/^grok/, 'xai'],
  [/^mistral|^mixtral|^codestral|^magistral/, 'mistral'],
  [/^ling|^ring/, 'ant-ling'],
];

/** 模型名 → 厂商 id；无法识别返回 undefined。 */
export function vendorOfModel(model) {
  const s = String(model || '').toLowerCase();
  const base = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
  for (const [re, vendor] of MODEL_VENDOR_RULES) {
    if (re.test(base) || re.test(s)) return vendor;
  }
  return undefined;
}
