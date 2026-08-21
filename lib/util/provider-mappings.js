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

  // ---- 月之暗面 / Kimi ----
  { providerId: 'kimi-coding', providerName: 'Kimi For Coding', vendor: 'kimi' },
  { providerId: 'moonshotai-cn', providerName: '月之暗面（国内）', vendor: 'kimi' },
  { providerId: 'moonshotai', providerName: 'Moonshot AI', vendor: 'kimi' },

  // ---- 智谱 ----
  { providerId: 'zai-coding-cn', providerName: '智谱 Coding（国内）', vendor: 'zhipu' },
  { providerId: 'zai', providerName: '智谱', vendor: 'zhipu' },

  // ---- 阿里通义 ----
  { providerId: 'qwen-token-plan-cn', providerName: '通义 Token 套餐（国内）', vendor: 'qwen' },
  { providerId: 'qwen-token-plan', providerName: 'Qwen Token Plan', vendor: 'qwen' },

  // ---- MiniMax ----
  { providerId: 'minimax-cn', providerName: 'MiniMax（国内）', vendor: 'minimax' },
  { providerId: 'minimax', providerName: 'MiniMax', vendor: 'minimax' },

  // ---- 小米 ----
  { providerId: 'xiaomi-token-plan-cn', providerName: '小米 Token 套餐（国内）', vendor: 'xiaomi' },
  { providerId: 'xiaomi-token-plan-ams', providerName: '小米 Token 套餐（AMS）', vendor: 'xiaomi' },
  { providerId: 'xiaomi-token-plan-sgp', providerName: '小米 Token 套餐（SGP）', vendor: 'xiaomi' },
  { providerId: 'xiaomi', providerName: '小米', vendor: 'xiaomi' },

  // ---- 蚂蚁灵积 ----
  { providerId: 'ant-ling', providerName: '蚂蚁灵积 Ling', vendor: 'ant-ling' },

  // ---- Anthropic / OpenAI / Google 官方 ----
  { providerId: 'anthropic', providerName: 'Anthropic', vendor: 'anthropic' },
  { providerId: 'openai', providerName: 'OpenAI', vendor: 'openai' },
  { providerId: 'openai-codex', providerName: 'OpenAI Codex', vendor: 'openai' },
  { providerId: 'google', providerName: 'Google Gemini', vendor: 'google' },
  { providerId: 'google-vertex', providerName: 'Google Vertex', vendor: 'google' },
  { providerId: 'xai', providerName: 'xAI', vendor: 'xai' },
  { providerId: 'mistral', providerName: 'Mistral', vendor: 'mistral' },

  // ---- OpenCode ----
  { providerId: 'opencode-go', providerName: 'OpenCode Go', vendor: 'opencode' },
  { providerId: 'opencode', providerName: 'OpenCode', vendor: 'opencode' },

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
  kimi: '月之暗面（Kimi）',
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
