# 贡献指南

## 新增一家提供方

前端不用动。只需改服务端两个文件：

### 1. 写抓取器：`lib/util/fetch-quotas.js`

加一个 `fetchXxx(ctx, config)`，返回余量快照（字段见 [`docs/余量快照契约.md`](docs/余量快照契约.md)）：

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

  // 各家原始响应差异在此自行消化：自己解析、换算成规范结构
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

**硬规则**（写错契约测试会立刻报路径）：

- `usedPct` 是**已用**百分比（不是剩余）；剩余由前端算。
- `status === 1` 必须有 `quota` / `balance`；`status !== 1` 时**不得**带数据。
- `period` 只能取 `5h` / `7d` / `30d` / `month`。
- 不要返回 `raw` / `endpoint` / `stats` / `metrics` / `headline` —— 已废弃，排障看服务端日志。

### 2. 注册抓取器：同文件末尾的 `FETCHERS`

```js
export const FETCHERS = {
  // ...
  example: fetchExample,
};
```

## 提交前自检

```sh
node --test test/*.test.js          # 全部测试必须全绿（69 条，含契约、登记表、价格表等）
node --check lib/util/fetch-quotas.js
```
