# 贡献指南

## 新增一家提供方

只需要改**服务端**的 4 个地方，前端一行都不用动（余量快照契约已把渲染逻辑与提供方解耦）。

### 1. 写抓取器：`lib/util/fetch-quotas.js`

新增一个 `fetchXxx(ctx, config)`，直接返回**余量快照**：

```js
async function fetchExample(ctx, config) {
  const base = { providerId: 'example', billingType: 'quota' };   // 或 'balance'
  const key = await resolveCredential(ctx, 'EXAMPLE_API_KEY');
  if (!key) return { ...base, status: STATUS.NO_CREDENTIAL };

  let res;
  try {
    res = await fetchJson('https://api.example.com/quota', { authorization: `Bearer ${key}` });
  } catch (error) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: errorText(error) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, status: STATUS.UNAUTHORIZED, message: `凭证被拒绝（HTTP ${res.status}）` };
  }
  if (!res.ok || !res.data) {
    return { ...base, status: STATUS.REQUEST_FAILED, message: `HTTP ${res.status}` };
  }

  // 各家的原始响应差异在这里自行消化：自己解析、自己换算成规范结构
  const usedPct = Math.round(res.data.used / res.data.limit * 100);
  if (!Number.isFinite(usedPct)) {
    return { ...base, status: STATUS.NO_DATA, message: '未识别到额度字段' };
  }
  return {
    ...base,
    status: STATUS.OK,
    quota: {
      timeWindows: [{ period: '5h', usedPct, resetAt: Date.parse(res.data.reset_at) || undefined }],
    },
  };
}
```

**快照结构**（完整定义见 [`docs/余量快照契约.md`](docs/余量快照契约.md)）：

| 字段 | 说明 |
|---|---|
| `providerId` | 提供方 id（与 DSH 路由名一致） |
| `billingType` | `quota`（订阅额度）/ `balance`（按量余额） |
| `status` | `STATUS.OK`=1、`NO_CREDENTIAL`=2、`UNSUPPORTED`=3、`UNAUTHORIZED`=4、`REQUEST_FAILED`=5、`NO_DATA`=6、`NO_PLAN`=7 |
| `message` | 可选，仅限白名单文案（`API 密钥无效`、`凭证被拒绝（HTTP 401）`、`请求超时（10000ms）`、`HTTP 502`、`未识别到额度字段`、`官方暂未提供查询接口`） |
| `quota.timeWindows[]` | `{ period: '5h'│'7d'│'30d'│'month', usedPct: 0-100, resetAt?, scope? }`；`scope` 为 `'code'` 表示编程专项额度（只进明细，不参与徽标选窗） |
| `quota.plan` | 可选，套餐/等级名 |
| `quota.extraQuotas[]` | 可选，`{ label, amount, currency, detail?, progress? }`；`progress = { used, limit, currency? }`，`limit: null` 表示无上限 |
| `balance` | `{ amount, currency, accounts?, alertThreshold?, spending? }` |

**硬规则**：

- `usedPct` 是**已用**百分比（不是剩余）；剩余量由前端算。
- `status === 1` 时必须有数据；`status !== 1` 时**不得**带 `quota` / `balance`。
- `period` 只能用 `5h` / `7d` / `30d` / `month` 四个值。
- 不要返回 `raw`、`endpoint`、`stats`、`metrics`、`headline` —— 这些已废弃，排障走服务端日志。

### 2. 注册：`lib/util/fetch-quotas.js` 末尾

```js
export const FETCHERS = {
  // ...
  example: fetchExample,
};
```

### 3. 登记映射：`lib/util/provider-mappings.js`

```js
// PROVIDER_MAPPING_SEED
{ providerId: 'example', providerName: 'Example', vendor: 'example' },

// PROVIDER_URL_SEED（可选，官网/管理页入口）
example: 'https://example.com/billing',
```

### 4. 加测试：`test/example.test.js`

必须包含：

1. **契约校验**：正常快照过 `validate()`；
2. **状态码**：无凭证→2、401→4、网络失败→5、字段缺失→6（按该家实际情况）；
3. **数值正确**：`usedPct` 与原始响应的换算对得上；
4. **不泄露**：返回对象里不含 token / 账号 ID / 原始响应。

```js
import { validate, STATUS } from '../lib/util/quota-snapshot.js';

const result = await FETCHERS.example(ctx, {});
assert.equal(validate(result).ok, true, JSON.stringify(validate(result).errors));
assert.equal(result.status, STATUS.OK);
```

### 5. README 适配表补一行

在「供应商适配」表格里加上新提供方、类型与验证状态。

## 不允许改的文件

| 文件 | 原因 |
|---|---|
| `lib/client.js` | 前端只认快照契约，与具体提供方无关 |
| `lib/index.js` | 聚合/路由编排层，与提供方无关 |

如果发现"必须改前端才能支持"，说明契约缺字段——请在 PR 里说明，先讨论再动。

## 提交前自检

```sh
node --test test/*.test.js          # 契约测试必须全绿
node --check lib/util/fetch-quotas.js
node --check lib/client.js
```

## 契约测试是什么

`lib/util/quota-snapshot.js` 提供 `validate(snapshot)`：检查必填字段、枚举、范围，以及
"`status === 1` 必须有数据 / 非 1 必须无数据"的一致性。

它保证**各家写法可以不同，但产出必须一致**——前端因此只写一套渲染逻辑。
测试里务必调用它；写错会立刻失败并给出具体路径（如 `quota.timeWindows[0].period 必须是 …`）。
