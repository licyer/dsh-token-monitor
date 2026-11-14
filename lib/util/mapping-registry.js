/**
 * 名称登记表（单一权威）。
 *
 * 设计约束：**数据源保持原样，映射只发生在读取/展示层**。
 * 这个文件不碰数据库、不碰文件、不碰网络，只提供"已知实体 + 查询函数"：
 *  - 库里存的是源里的原值（`moonshotai/Kimi-K3`、`deepseek-official`…）；
 *  - 所有端点读出来后经 `canonicalProvider()` / `canonicalModel()` 投影成规范身份；
 *  - 页面只渲染 `labelOf*()` 给的名字。
 *
 * 换映射规则的成本：改这个文件 → 重启 → 历史数据按新规则重新解释，零迁移。
 *
 * 新增实体的方式：
 *  - 新提供方 → 在 PROVIDERS 加一行（vendor / label / urls / fetch）
 *  - 新厂商   → 在 VENDORS 加一行（label / order / color / kind）
 *  - 新模型   → 在 MODELS 加一行（display / vendor / aliases）
 *
 * ⚠️ 不猜模型等价：名字不认识就走「未知」分支（原样显示），绝不合并到相近的模型
 *    （`deepseek-flash` ≠ `deepseek-v4-flash`、`kimi-for-coding` ≠ `k3`、`k3-256k` ≠ `k3`）。
 */

/* ------------------------------ 厂商 ------------------------------ */

/**
 * vendorId → { label, order?, color?, kind }
 *  - kind: 'owner' 厂商（自研直出）/ 'reseller' 中转站（转发上游）/ 'unknown'
 *  - color: 厂商基础色；null = 不占色系（中转站柱内按模型取色）
 *  - order: 显式排序，deepseek 恒为 0
 */
export const VENDORS = {
  deepseek: { label: 'DeepSeek', order: 0, color: '#3964fe', kind: 'owner' },
  google: { label: 'Google', color: '#06b6d4', kind: 'owner' },
  kimi: { label: { zh: 'Kimi', en: 'Kimi' }, color: '#9333ea', kind: 'owner' },
  'ant-ling': { label: { zh: '蚂蚁灵积（Ling）', en: 'Ant Ling' }, color: '#d946ef', kind: 'owner' },
  zhipu: { label: { zh: '智谱（GLM）', en: 'Zhipu (GLM)' }, color: '#a16207', kind: 'owner' },
  xiaomi: { label: { zh: '小米（Xiaomi）', en: 'Xiaomi' }, color: '#f97316', kind: 'owner' },
  anthropic: { label: 'Anthropic', color: '#dc2626', kind: 'owner' },
  mistral: { label: 'Mistral', color: '#fb7185', kind: 'owner' },
  qwen: { label: { zh: '通义（Qwen）', en: 'Qwen' }, color: '#65a30d', kind: 'owner' },
  openai: { label: 'OpenAI', color: '#16a34a', kind: 'owner' },
  minimax: { label: 'MiniMax', color: '#0d9488', kind: 'owner' },
  xai: { label: 'xAI', color: '#64748b', kind: 'owner' },
  nvidia: { label: 'NVIDIA', color: null, kind: 'owner' },

  opencode: { label: 'OpenCode', color: null, kind: 'reseller' },
  commandcode: { label: 'Command Code', color: null, kind: 'reseller' },
  openrouter: { label: 'OpenRouter', color: null, kind: 'reseller' },
  'vercel-ai-gateway': { label: 'Vercel AI Gateway', color: null, kind: 'reseller' },
  cloudflare: { label: 'Cloudflare', color: null, kind: 'reseller' },
  'github-copilot': { label: 'GitHub Copilot', color: null, kind: 'reseller' },
  'azure-openai': { label: 'Azure OpenAI', color: null, kind: 'reseller' },
  'amazon-bedrock': { label: 'Amazon Bedrock', color: null, kind: 'reseller' },
  huggingface: { label: 'Hugging Face', color: null, kind: 'reseller' },
  groq: { label: 'Groq', color: null, kind: 'reseller' },
  cerebras: { label: 'Cerebras', color: null, kind: 'reseller' },
  together: { label: 'Together AI', color: null, kind: 'reseller' },
  fireworks: { label: 'Fireworks AI', color: null, kind: 'reseller' },

  'cc-switch': { label: 'cc-switch', color: null, kind: 'unknown' },
  unknown: { label: { zh: '未知', en: 'Unknown' }, order: 999, color: '#9ca3af', kind: 'unknown' },
};

/* ----------------------------- 提供方 ----------------------------- */

/**
 * providerId（库里的 provider 列）→ 登记项
 *  - vendor: 上级厂商
 *  - label:  本提供方的展示名（弹层/提供方列表用）
 *  - displayAs: 统计口径的显示名（目前只有 deepseek-account 用到：统计里并入 DeepSeek）
 *  - aliasOf: 该名字是某个规范 providerId 的旧写法，读取时归并
 *  - kind:  'quota' 订阅额度 / 'balance' 按量余额 / 'unknown'
 *  - urls:  官网入口，字符串或 { balance / quota / usage }
 *  - fetch: 单测/文档用的抓取器名（真实实现仍在 fetch-quotas.js 的 FETCHERS）
 */
export const PROVIDERS = {
  // ---- DeepSeek ----
  deepseek: {
    vendor: 'deepseek', label: 'DeepSeek', kind: 'balance',
    urls: { balance: 'https://platform.deepseek.com/top_up' }, fetch: 'deepseek',
  },
  'deepseek-official': { aliasOf: 'deepseek' },
  'deepseek-account': {
    vendor: 'deepseek', label: 'DeepSeek Account', displayAs: 'DeepSeek', kind: 'quota',
    urls: { balance: 'https://platform.deepseek.com/top_up' }, fetch: 'deepseek-account',
  },

  // ---- 月之暗面 / Kimi ----
  'kimi-coding': {
    vendor: 'kimi', label: 'Kimi For Coding', kind: 'quota',
    urls: {
      quota: 'https://www.kimi.com/code/console?from=kfc_overview_topbar',
      balance: 'https://platform.kimi.com/console/pay',
    },
    fetch: 'kimi',
  },
  'moonshotai-cn': {
    vendor: 'kimi', label: { zh: 'Moonshot AI（CN）', en: 'Moonshot AI (CN)' }, kind: 'balance',
    urls: {
      quota: 'https://www.kimi.com/code/console?from=kfc_overview_topbar',
      balance: 'https://platform.kimi.com/console/pay',
    },
    fetch: 'moonshotai-cn',
  },
  moonshotai: {
    vendor: 'kimi', label: 'Moonshot AI', kind: 'balance',
    urls: {
      quota: 'https://www.kimi.com/code/console?from=kfc_overview_topbar',
      balance: 'https://platform.kimi.com/console/pay',
    },
  },

  // ---- 智谱 ----
  'glm-code-plan': {
    vendor: 'zhipu', label: 'GLM Coding Plan', kind: 'quota',
    urls: { quota: 'https://bigmodel.cn/coding-plan/personal/overview' }, fetch: 'glm-code-plan',
  },
  zai: {
    vendor: 'zhipu', label: 'GLM', kind: 'balance',
    urls: { balance: 'https://bigmodel.cn/finance-center/finance/pay' }, fetch: 'zai',
  },
  // pi-ai 渠道名：与 glm-code-plan 打同一端点，读取时归并
  'zai-coding-cn': { aliasOf: 'glm-code-plan' },

  // ---- 阿里通义 ----
  'qwen-token-plan-cn': {
    vendor: 'qwen', label: { zh: 'Qwen Token Plan（CN）', en: 'Qwen Token Plan (CN)' }, kind: 'quota',
    urls: { quota: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview' },
  },
  'qwen-token-plan': {
    vendor: 'qwen', label: 'Qwen Token Plan', kind: 'quota',
    urls: { quota: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview' },
  },

  // ---- MiniMax ----
  'minimax-cn': {
    vendor: 'minimax', label: { zh: 'MiniMax（CN）', en: 'MiniMax (CN)' }, kind: 'quota',
    urls: { quota: 'https://platform.minimaxi.com/subscribe/token-plan' }, fetch: 'minimax-cn',
  },
  minimax: {
    vendor: 'minimax', label: 'MiniMax', kind: 'quota',
    urls: { quota: 'https://platform.minimaxi.com/subscribe/token-plan' }, fetch: 'minimax',
  },

  // ---- 小米 ----
  'xiaomi-token-plan-cn': {
    vendor: 'xiaomi', label: { zh: '小米 Token Plan（CN）', en: 'Xiaomi Token Plan (CN)' }, kind: 'quota',
    urls: { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  },
  'xiaomi-token-plan-ams': {
    vendor: 'xiaomi', label: { zh: '小米 Token Plan（AMS）', en: 'Xiaomi Token Plan (AMS)' }, kind: 'quota',
    urls: { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  },
  'xiaomi-token-plan-sgp': {
    vendor: 'xiaomi', label: { zh: '小米 Token Plan（SGP）', en: 'Xiaomi Token Plan (SGP)' }, kind: 'quota',
    urls: { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  },
  xiaomi: {
    vendor: 'xiaomi', label: { zh: '小米', en: 'Xiaomi' }, kind: 'balance',
    urls: { balance: 'https://platform.xiaomimimo.com/console/balance', quota: 'https://platform.xiaomimimo.com/console/plan-manage' },
  },

  // ---- 蚂蚁灵积 ----
  'ant-ling': { vendor: 'ant-ling', label: '蚂蚁灵积 Ling', kind: 'balance' },

  // ---- Anthropic / OpenAI / Google / xAI / Mistral ----
  anthropic: { vendor: 'anthropic', label: 'Anthropic', kind: 'balance' },
  openai: { vendor: 'openai', label: 'OpenAI', kind: 'balance' },
  'openai-codex': { vendor: 'openai', label: 'OpenAI Codex', kind: 'quota' },
  'chatgpt-codex': {
    vendor: 'openai', label: 'ChatGPT Codex', kind: 'quota',
    urls: { usage: 'https://chatgpt.com/codex/settings/usage' }, fetch: 'chatgpt-codex',
  },
  google: { vendor: 'google', label: 'Google Gemini', kind: 'balance' },
  'google-vertex': { vendor: 'google', label: 'Google Vertex', kind: 'balance' },
  xai: { vendor: 'xai', label: 'xAI', kind: 'balance' },
  mistral: { vendor: 'mistral', label: 'Mistral', kind: 'balance' },

  // ---- OpenCode ----
  'opencode-go': {
    vendor: 'opencode', label: 'OpenCode Go', kind: 'balance',
    urls: { balance: 'https://opencode.ai/zh/go' }, fetch: 'opencode-go',
  },
  opencode: { vendor: 'opencode', label: 'OpenCode', kind: 'balance' },

  // ---- Command Code ----
  commandcode: {
    vendor: 'commandcode', label: 'Command Code', kind: 'balance',
    urls: { balance: 'https://commandcode.ai/billing' }, fetch: 'commandcode',
  },

  // ---- 网关 / 聚合 / 云平台 ----
  openrouter: {
    vendor: 'openrouter', label: 'OpenRouter', kind: 'balance',
    urls: { balance: 'https://openrouter.ai/settings/credits' }, fetch: 'openrouter',
  },
  'vercel-ai-gateway': { vendor: 'vercel-ai-gateway', label: 'Vercel AI Gateway', kind: 'balance' },
  'cloudflare-ai-gateway': { vendor: 'cloudflare', label: 'Cloudflare AI Gateway', kind: 'balance' },
  'cloudflare-workers-ai': { vendor: 'cloudflare', label: 'Cloudflare Workers AI', kind: 'balance' },
  'github-copilot': { vendor: 'github-copilot', label: 'GitHub Copilot', kind: 'quota' },
  'azure-openai-responses': { vendor: 'azure-openai', label: 'Azure OpenAI', kind: 'balance' },
  'amazon-bedrock': { vendor: 'amazon-bedrock', label: 'Amazon Bedrock', kind: 'balance' },
  huggingface: { vendor: 'huggingface', label: 'Hugging Face', kind: 'balance' },
  groq: { vendor: 'groq', label: 'Groq', kind: 'balance' },
  cerebras: { vendor: 'cerebras', label: 'Cerebras', kind: 'balance' },
  nvidia: { vendor: 'nvidia', label: 'NVIDIA', kind: 'balance' },
  together: { vendor: 'together', label: 'Together AI', kind: 'balance' },
  fireworks: { vendor: 'fireworks', label: 'Fireworks AI', kind: 'balance' },

  // ---- 兜底 ----
  'cc-switch': { vendor: 'cc-switch', label: 'cc-switch', kind: 'unknown' },
  unknown: { vendor: 'unknown', label: { zh: '未知', en: 'Unknown' }, kind: 'unknown' },
};

/* ----------------------------- 客户端 ----------------------------- */

/** client id（dsh 自采 / cc-switch 的 app_type）→ 展示名。 */
export const CLIENTS = {
  dsh: 'DSH',
  claude: 'Claude',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  grokbuild: 'Grok Build',
  pi: 'Pi',
};

/* ------------------------------ 模型 ------------------------------ */

/**
 * 规范模型 id → { display, vendor?, provider?, aliases? }
 *  - 只登记**已确认**的模型；未登记的名字读取时原样显示（不猜等价）
 *  - aliases 里的写法会归并到这个规范 id（大小写、空白不敏感）
 *  - provider 是该模型的默认归属（源里缺 provider 时补缺，如 CC 的 _session 行）
 */
export const MODELS = {
  // ---- DeepSeek ----
  'deepseek-flash': {
    display: 'DeepSeek Flash', vendor: 'deepseek', provider: 'deepseek',
    aliases: ['deepseek/deepseek-v4.1-flash', 'deepseek-v4.1-flash'],
  },
  'deepseek-v4-flash': { display: 'DeepSeek V4 Flash', vendor: 'deepseek', provider: 'deepseek' },
  'deepseek-v4-flash-vision-exp': { display: 'DeepSeek V4 Flash Vision Exp', vendor: 'deepseek', provider: 'deepseek' },
  'deepseek-v4-pro': { display: 'DeepSeek V4 Pro', vendor: 'deepseek', provider: 'deepseek' },

  // ---- Kimi ----
  k3: {
    display: 'Kimi K3', vendor: 'kimi', provider: 'kimi-coding',
    aliases: ['Kimi-K3', 'kimi-k3', 'moonshotai/Kimi-K3'],
  },
  // 256k 上下文档，与 k3 不同款，不合并
  'k3-256k': { display: 'Kimi K3-256K', vendor: 'kimi', provider: 'kimi-coding' },
  'k3.1-pro': { display: 'Kimi K3.1 Pro', vendor: 'kimi', provider: 'kimi-coding' },
  'k3.1-pro-highspeed': { display: 'Kimi K3.1 Pro Highspeed', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-for-coding': { display: 'Kimi For Coding', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-for-coding-highspeed': { display: 'Kimi For Coding Highspeed', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-k2.5': { display: 'Kimi K2.5', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-k2.6': { display: 'Kimi K2.6', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-k2.7': { display: 'Kimi K2.7', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-k2.7-code': { display: 'Kimi K2.7 Code', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-k2.7-code-highspeed': { display: 'Kimi K2.7 Code Highspeed', vendor: 'kimi', provider: 'kimi-coding' },
  'kimi-k2-thinking': { display: 'Kimi K2 Thinking', vendor: 'kimi', provider: 'kimi-coding' },
};

/* --------------------------- 导入规则 --------------------------- */

/** cc-switch 导入：app_type 白名单 / 显式排除 / 含缓存的输入。 */
export const APP_RULES = {
  whitelist: ['claude', 'claude-desktop', 'codex', 'gemini', 'opencode', 'grokbuild', 'pi'],
  excluded: ['dsh'],
  cacheInclusive: ['codex', 'gemini', 'grokbuild'],
};

/* --------------------------- 归一与查询 --------------------------- */

/** 名称比较键：去首尾空白、折叠空白、小写。 */
function keyOf(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 去掉最后一个 '/' 之前的 vendor 前缀（`moonshotai/kimi-k3` → `kimi-k3`）。 */
function stripVendorPrefix(raw) {
  const s = String(raw ?? '');
  const i = s.lastIndexOf('/');
  return i > 0 && i < s.length - 1 ? s.slice(i + 1) : s;
}

// 模型索引：规范 id + 别名 → 规范 id（值里存规范 id）
const MODEL_INDEX = new Map();
for (const [id, meta] of Object.entries(MODELS)) {
  MODEL_INDEX.set(keyOf(id), id);
  for (const alias of meta.aliases || []) MODEL_INDEX.set(keyOf(alias), id);
}

// 提供方索引：id → 规范 id（含 aliasOf 链）
const PROVIDER_INDEX = new Map();
for (const id of Object.keys(PROVIDERS)) PROVIDER_INDEX.set(keyOf(id), id);

/** 按模型名前缀推断厂商（仅在模型未登记时使用；不改名字）。 */
const VENDOR_PREFIX_RULES = [
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

function inferVendor(model) {
  const s = String(model ?? '').toLowerCase();
  const base = stripVendorPrefix(s);
  for (const [re, vendor] of VENDOR_PREFIX_RULES) {
    if (re.test(base) || re.test(s)) return vendor;
  }
  return undefined;
}

/**
 * 提供方归一到规范 id。未知的原样返回（不猜）。
 * @param {string} raw 库里的 provider 原值
 * @returns {string} 规范 providerId
 */
export function canonicalProvider(raw) {
  if (raw === null || raw === undefined || raw === '') return 'unknown';
  let id = PROVIDER_INDEX.get(keyOf(raw)) || String(raw);
  // aliasOf 链最多追两层，防止表里写出环
  for (let i = 0; i < 2; i++) {
    const alias = PROVIDERS[id] && PROVIDERS[id].aliasOf;
    if (!alias) break;
    id = alias;
  }
  return id;
}

/**
 * 模型归一到规范身份。
 * @param {string} raw 库里的 model 原值
 * @returns {{ id: string, display: string, model: string, vendor?: string, provider?: string, known: boolean }}
 */
export function canonicalModel(raw) {
  const original = raw === null || raw === undefined || String(raw).trim() === '' ? 'unknown' : String(raw).trim();
  let id = MODEL_INDEX.get(keyOf(original));
  if (!id) id = MODEL_INDEX.get(keyOf(stripVendorPrefix(original)));

  if (id) {
    const meta = MODELS[id];
    return {
      id,
      model: id,
      display: meta.display,
      vendor: meta.vendor || inferVendor(id),
      provider: meta.provider,
      known: true,
    };
  }
  return {
    id: original,
    model: original,
    display: original,
    vendor: inferVendor(original),
    provider: undefined,
    known: false,
  };
}

/** providerId → vendorId（未登记时把自身当厂商，不并入 unknown）。 */
export function vendorOfProvider(rawProvider) {
  const pid = canonicalProvider(rawProvider);
  const meta = PROVIDERS[pid];
  if (meta && meta.vendor) return meta.vendor;
  return pid === 'unknown' ? 'unknown' : pid;
}

/** 模型名 → vendorId（表内优先，其次前缀推断，最后 unknown）。 */
export function vendorOfModel(rawModel) {
  const c = canonicalModel(rawModel);
  return c.vendor || 'unknown';
}

/** 模型名 → 默认归属 providerId（未登记返回 undefined，调用方决定是否补缺）。 */
export function providerOfModel(rawModel) {
  return canonicalModel(rawModel).provider;
}

/** 展示名取值：字符串直出，{ zh, en } 按语言取（默认中文）。 */
export function resolveLabel(label, lang = 'zh') {
  if (label === null || label === undefined) return '';
  if (typeof label === 'string') return label;
  return label[lang] || label.zh || label.en || '';
}

/** 提供方展示名（统计口径优先 displayAs）。 */
export function labelOfProvider(rawProvider, lang) {
  const pid = canonicalProvider(rawProvider);
  const meta = PROVIDERS[pid];
  if (!meta) return String(rawProvider ?? 'unknown');
  return resolveLabel(meta.displayAs || meta.label, lang);
}

/** 厂商展示名。 */
export function labelOfVendor(vendorId, lang) {
  const meta = VENDORS[vendorId];
  return meta ? resolveLabel(meta.label, lang) : String(vendorId ?? 'unknown');
}

/** 模型展示名（未登记原样返回）。 */
export function labelOfModel(rawModel, lang) {
  const c = canonicalModel(rawModel);
  return c.known ? resolveLabel(MODELS[c.id].display, lang) : c.display;
}

/** 客户端展示名（未登记原样返回）。 */
export function labelOfClient(rawClient, lang) {
  const label = CLIENTS[String(rawClient ?? '')];
  return label === undefined ? String(rawClient ?? 'unknown') : resolveLabel(label, lang);
}

/** 提供方官网入口（原样返回登记值；未登记返回 null）。 */
export function urlsOfProvider(rawProvider) {
  const pid = canonicalProvider(rawProvider);
  const meta = PROVIDERS[pid];
  return (meta && meta.urls) || null;
}

/** 抓取器名（fetch-quotas.js 的 FETCHERS 键）；未登记返回 null。 */
export function fetcherOfProvider(rawProvider) {
  const pid = canonicalProvider(rawProvider);
  const meta = PROVIDERS[pid];
  return (meta && meta.fetch) || null;
}

/** 厂商基础色；不占色系（中转站）或未登记返回 null。 */
export function colorOfVendor(vendorId) {
  const meta = VENDORS[vendorId];
  return meta ? meta.color || null : null;
}

/** 厂商性质：owner / reseller / unknown。 */
export function kindOfVendor(vendorId) {
  const meta = VENDORS[vendorId];
  return meta ? meta.kind : 'unknown';
}

/** 提供方计费类型：quota / balance / unknown。 */
export function kindOfProvider(rawProvider) {
  const meta = PROVIDERS[canonicalProvider(rawProvider)];
  return meta && meta.kind ? meta.kind : 'unknown';
}

/** 取价键：规范模型 id（价表按规范 id 存）。 */
export function priceKeyOf(rawModel) {
  return canonicalModel(rawModel).id;
}

/**
 * 一条用量行的完整投影：规范身份 + 展示名。
 * 服务端所有返回用量数据的端点都应经过它，前端不再做名称处理。
 */
export function project(provider, model, lang) {
  const p = canonicalProvider(provider);
  const m = canonicalModel(model);
  // 两个 vendor 不是一回事：
  //  - vendor      = 提供方所属厂商 → 供应商统计的分组（中转站自己一根柱子）
  //  - modelVendor = 模型所属厂商 → 柱子里的配色（中转站转发来的模型沿用厂商色）
  const providerVendor = vendorOfProvider(p);
  const modelVendor = m.vendor || providerVendor;
  return {
    provider: p,
    model: m.id,
    providerLabel: labelOfProvider(p, lang),
    modelLabel: m.known ? resolveLabel(MODELS[m.id].display, lang) : m.display,
    vendor: providerVendor,
    vendorLabel: labelOfVendor(providerVendor, lang),
    modelVendor,
    modelVendorLabel: labelOfVendor(modelVendor, lang),
    known: m.known,
  };
}
