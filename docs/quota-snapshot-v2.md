# 余量快照 v2（统一提供方数据契约）

> 状态：**设计定稿，未实施** ｜ 目标：新增一家提供方 = 写一个抓取器 + 一张映射表，前端零改动。

## 1. 设计原则

1. **一条规则只写一次**：判色、选窗口、拼文案，各只有一份实现，与提供方无关。
2. **协议只传事实，不传展示**：不出现中文文案、不出现预格式化的倒计时字符串。
3. **按类型取数据**：拿到快照先看 `billingType`，直接去 `quota` 或 `balance`，不做"字段存在性探测"。
4. **各家自行封装**：原始响应差异由 `fetchXxx` 自己消化，直接产出合规结构；中心不假设字段路径。
5. **校验兜底**：`validate()` 保证「写法自由、产出一致」。
6. **没有独有字段**：装不进结构的数据说明本来就不该展示。

## 2. 结构

### 2.1 公用层（所有提供方）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `providerId` | string | ✅ | 提供方 id，与 `/token-monitor/provider-mappings` 的键一致 |
| `billingType` | `"quota"` \| `"balance"` | ✅ | 计费类型：订阅额度 / 按量余额 |
| `status` | number | ✅ | 状态码 1–7，见第 3 节 |
| `message` | string \| null | | `status ≠ 1` 时的补充说明（仅白名单文案） |

### 2.2 `billingType = "quota"`

```jsonc
"quota": {
  "plan": "Pro",                    // 可选：套餐名或权益等级名（Free / Go / plus …）
  "timeWindows": [                  // 必填，至少一项（status = 1 时）
    {
      "period": "5h",               // 必填：5h | 7d | 30d | month（受控枚举）
      "usedPct": 12,                // 必填：已用百分比 0–100
      "used": 1234,                 // 可选：数值用量
      "limit": 10000,               // 可选：窗口上限（token / 次数 / 额度单位）
      "resetAt": 1767000000000,     // 可选：重置时刻，毫秒时间戳
      "resetInSec": 14400           // 可选：剩余秒数（平台只给相对时间时用）
    }
  ],
  "extraQuotas": [                  // 可选：结转额度、加油包等附加额度
    { "label": "额外额度（结转）", "amount": 12.34, "currency": "CNY" }
  ]
}
```

**关于 `timeWindows`**

- `period` 是受控枚举，只有 `5h` / `7d` / `30d` / `month` 四个值；将来新增周期就扩展枚举，不引入自由字符串。
- 窗口的展示文案由前端按 `period` 映射，协议不传 `label`。
- 长周期由前端集合 `['7d', '30d', 'month']` 推导，协议不传标记字段。
- `usedPct` 是**已用**百分比（与官方额度页口径一致），不是剩余。

### 2.3 `billingType = "balance"`

```jsonc
"balance": {
  "amount": 49.59,                  // 主余额
  "currency": "CNY",
  "accounts": [                     // 可选：各币种 / 各分项
    {
      "label": "人民币账户",
      "amount": 49.59,              // 该账户总余额
      "currency": "CNY",
      "recharged": 40.00,           // 可选：充值部分
      "granted": 9.59,              // 可选：赠送部分
      "spent": 123.45               // 可选：累计消费
    }
  ],
  "alertThreshold": 2,              // 可选：用户自设的余额预警线
  "spending": {                     // 可选：消耗统计
    "thisMonth": 1.23,
    "total": 45.6,
    "currency": "USD"
  }
}
```

**约束**：`balance.amount` 必须等于主币种账户余额（`accounts` 中主账户的 `amount`），由归一层保证，前端不做求和。

## 3. 状态码

### 3.1 编码表

| 码 | 名称 | 含义 | 数据 | 前端表现 |
|---|---|---|---|---|
| **1** | 成功 | 拿到了有效额度/余额 | `quota` 或 `balance` 必有内容 | 正常渲染（颜色由判色决定） |
| **2** | 未配置凭证 | 没有 API Key / 认证文件 / 配置无效 | 无 | 灰，「未配置 API Key」 |
| **3** | 未适配 | 插件还不支持这家 | 无 | 灰，「插件未适配，敬请期待」 |
| **4** | 凭证被拒 | 401/403、key 无效或过期 | 无 | 红，`message` |
| **5** | 请求失败 | 网络错误、超时、5xx、响应解析失败 | 无 | 红，`message` |
| **6** | 无有效额度数据 | 请求成功但字段没识别到 / 窗口全缺失 | 无 | 黄，`message` 或「未识别到额度字段」 |
| **7** | 无生效套餐 | 账号查得通，但没有生效订阅 | 无 | 灰，「无订阅」 |

### 3.2 判定规则

| 条件 | 码 |
|---|---|
| 抓到有效窗口或余额 | 1 |
| 没有凭证、认证文件读不到、认证字段无效、端点配置被篡改 | 2 |
| 该提供方在插件里没有抓取器 | 3 |
| HTTP 401/403，或平台用业务码表示 key 无效/过期 | 4 |
| 网络异常、超时、HTTP 4xx/5xx、响应无法解析 | 5 |
| 请求成功但没有任何有效窗口/余额字段（含"官方暂未提供查询接口"） | 6 |
| 请求成功、账号有等级但无生效套餐 | 7 |

### 3.3 通用规则

- 只有 `status === 1` 时才有数据；其余状态 `quota` / `balance` 必须为空。
- `message` 承载细节（`HTTP 502`、`请求超时（10000ms）`、`官方暂未提供查询接口`），状态码只做粗分类。
- `message` 只允许白名单文案，避免把服务端错误原文暴露给用户。

## 4. 静态元数据

以下信息与单次抓取无关，由 `/token-monitor/provider-mappings` 下发，不在快照里：

| 字段 | 说明 |
|---|---|
| `provider_name` | 展示名 |
| `vendor` / `vendorLabels` | 厂商 id 与显示名 |
| `url` | 官网入口 |
| `verified` | 是否用真实凭证实测过 |
| `sortOrder` | 展示排序 |

前端渲染时合并两份：`mappings[providerId]`（静态）+ `overview[providerId]`（动态快照）。

## 5. 九家映射示例

| 提供方 | billingType | 快照内容 |
|---|---|---|
| kimi-coding | quota | `plan` = 权益等级；`timeWindows` = 5h/7d/month；无套餐 → status 7 |
| opencode-go | quota | `plan` = 套餐名；`timeWindows` = 5h/7d/30d |
| commandcode | quota | `timeWindows` = 5h/7d/month；`extraQuotas` = 结转/加油包 |
| glm-code-plan | quota | `timeWindows` = 5h/7d |
| minimax-cn | quota | `timeWindows` = 5h/7d |
| chatgpt-codex | quota | `plan` = plan_type；`timeWindows` = 5h/7d |
| deepseek | balance | `accounts[]` 多币种 |
| deepseek-account | balance | `accounts[]`（recharged/granted/spent）+ `alertThreshold` |
| moonshotai-cn | balance | `accounts[]` = 现金 / 代金券 |
| openrouter | balance | `amount`（积分→USD）+ `spending` 本月/累计 |

## 6. fetcher 契约

每个 `fetchXxx(ctx, config)` 自行完成「取数 + 解析 + 封装」，**直接返回 v2 快照**：

```js
export async function fetchXxx(ctx, config) {
  const key = await resolveCredential(ctx, 'XXX_API_KEY');
  if (!key) {
    return { providerId: 'xxx', billingType: 'quota', status: STATUS.NO_CREDENTIAL };
  }
  const res = await fetchJson(url, headers);
  if (res.status === 401) {
    return { providerId: 'xxx', billingType: 'quota',
             status: STATUS.UNAUTHORIZED, message: 'API 密钥无效' };
  }
  return {
    providerId: 'xxx', billingType: 'quota', status: STATUS.OK,
    quota: { plan, timeWindows: [...], extraQuotas: [...] },
  };
}
```

规则：

1. **各家原始响应的差异由 fetcher 自行消化**，中心不假设任何字段路径、不做提供方专属逻辑；
2. **状态码用 `STATUS` 常量**给出，不写裸数字；
3. `message` 只能取第 3.3 节白名单里的文案；
4. 中心只做两件事：`validate()` 校验 + 聚合排序。

## 7. 校验

`validate(snapshot)` 是契约的守门人，检查：

| 检查项 | 规则 |
|---|---|
| 必填 | `providerId` / `billingType` / `status` |
| 枚举 | `billingType ∈ {quota, balance}`；`period ∈ {5h, 7d, 30d, month}` |
| 范围 | `usedPct` 在 0–100；`status` 在 1–7 |
| 一致性 | `status === 1` 时 `quota`/`balance` 必须有数据；`status ≠ 1` 时必须为空 |

用途：

- **契约测试**：每家 fetcher 的返回值都必须通过，写错立即失败；
- 开发期可选断言（运行时开关）。

由于 fetcher 是自由封装，这道校验是「各家写法可以不同、但产出必须一致」的唯一保障。

## 7. 前端取用规则

```js
// 窗口展示文案：唯一映射表
const PERIOD_LABEL = {
  '5h': ['5小时用量', '5h'], '7d': ['7天用量', '7d'],
  '30d': ['30天用量', '30d'], month: ['本月用量', 'month'],
};
const LONG_PERIODS = new Set(['7d', '30d', 'month']);   // 长周期判定，唯一来源

// 1. 状态分流
status === 1                     → 正常渲染
status === 2 || 3 || 7           → 中性（灰）
status === 4 || 5 || 6           → 告警（红/黄），显示 message

// 2. 按类型取数据
const data = billingType === 'quota' ? quota : balance;

// 3. 选窗口
const short = quota.timeWindows.find(w => !LONG_PERIODS.has(w.period));
const long  = quota.timeWindows.find(w => LONG_PERIODS.has(w.period));

// 4. 判色
quota:   max(usedPct) > 95 || (long && long.usedPct >= 90)  → err
balance: amount <= alertThreshold                            → err

// 5. 文案
`${PERIOD_LABEL[short.period][1]} ${short.usedPct}%`         // 徽标：5h 12%
```

## 8. 实施阶段

| 阶段 | 内容 | 可独立发布 |
|---|---|---|
| **1** | 定 schema + 中心归一层 + 契约测试，让现有 9 家全部通过；前端不动 | ✅ |
| **2** | 前端改读 v2 结构，旧字段保留兼容 | ✅ |
| **3** | 移除旧字段与兼容代码，补 `CONTRIBUTING.md` | ✅ |

## 9. 未决项

- [ ] `message` 白名单范围
- [ ] 归一映射表的字段路径语法（点号是否够用，是否需要数组下标）
- [ ] 契约测试的校验方式（手写校验器 / JSON Schema）
- [ ] 旧字段兼容期长度
