# 余量快照 v2 实施计划

> 配套设计文档：[`quota-snapshot-v2.md`](quota-snapshot-v2.md)
> 状态：**阶段 A/B/C 完成** —— 服务端 9 家产出 v2，聚合层与前端已接入
> 最后更新：2026-11-03

## 0. 进度记录

| 日期 | 完成项 | 证据 |
|---|---|---|
| 2026-11-03 | 阶段 A：`lib/util/quota-snapshot.js`（`STATUS` / `validate` / `mapError` / `assertValid`） | 契约测试 16/16 |
| 2026-11-03 | 阶段 A：`test/quota-snapshot.test.js` | 全量 27/27 |
| 2026-11-03 | 阶段 B：**9 家 fetcher 全部产出 v2** | 39 项场景断言通过 |
| 2026-11-03 | 阶段 B：删除死代码（`parseQuotaMetrics` / `walkLeaves` / `fmtAmt` / `formatCountdown` / `truncateRaw`） | 旧字段残留 0 |
| 2026-11-03 | 阶段 B：`chatgpt-codex.test.js` / `codex-badge.test.js` 改为 v2 断言 | 27/27 |
| 2026-11-03 | 阶段 C：`lib/index.js` 聚合改用 `providerId`/`status`，注入展示名 | 语法通过 |
| 2026-11-03 | 阶段 C：`lib/client.js` 改读 `status`/`billingType`/`timeWindows`/`balance` | 前端逻辑 24/24 |
| 2026-11-03 | 阶段 C：删 `usedPctOf`/`balanceAmountOf`，加 `PERIOD_LABEL`/`LONG_PERIODS`/`statusDot`/`providerRows`/`balanceText` | 旧字段残留 0 |
| 待办 | 真机回归：重启 DSH + 刷新，逐家比对徽标/弹层/设置页 | 需人工验收 |

## 1. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 1.1 | `message` 内容 | 沿用白名单：只返回筛过的可展示原因（`API 密钥无效`、`凭证被拒绝（HTTP 401）`、`请求超时（10000ms）`、`HTTP 502`、`未识别到额度字段`、`官方暂未提供查询接口`），原始错误只进日志 |
| 1.2 | 各家结构差异 | **fetcher 自行封装**，直接产出 v2；中心不假设字段路径 |
| 1.3 | 结构合规 | 手写校验器 `validate()`（零依赖），契约测试强制通过 |
| 1.4 | 发布节奏 | **大改造完成后一次发布**：不做双写、不保留旧字段 |

## 2. 阶段总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| A | 契约与守门：`quota-snapshot.js` + 契约测试 | ✅ 完成 |
| B | 9 家 fetcher 改为产出 v2 | ✅ 完成 |
| C | 聚合层 + 前端切到 v2 | ✅ 完成 |
| D | 清理旧代码 + 贡献指南 + 真机回归 | 待做 |

## 3. 阶段 A：契约与守门 ✅

- [x] `STATUS` 常量：`OK=1`、`NO_CREDENTIAL=2`、`UNSUPPORTED=3`、`UNAUTHORIZED=4`、`REQUEST_FAILED=5`、`NO_DATA=6`、`NO_PLAN=7`
- [x] `validate(snapshot)`：必填 / 枚举 / 范围 / 一致性（`status===1` 必须有数据，`status≠1` 必须无数据）
- [x] `mapError(kind)`：`no-credential`→2、`unsupported`→3、`unauthorized`→4、`network|timeout|http`→5、`unrecognized`→6、`no-plan`→7（未知按 5）
- [ ] `buildQuota()` / `buildBalance()` 辅助（可选，暂未加）
- [x] `test/quota-snapshot.test.js`：16 个用例（合法/非法/枚举/越界/一致性/mapError/状态码固定）

## 4. 阶段 B：9 家改造 ✅

| 序 | 提供方 | billingType | 状态 |
|---|---|---|---|
| 1 | chatgpt-codex | quota | ✅ |
| 2 | moonshotai-cn | balance | ✅ |
| 3 | deepseek | balance | ✅ |
| 4 | deepseek-account | balance | ✅ |
| 5 | openrouter | balance | ✅ |
| 6 | glm-code-plan | quota | ✅ |
| 7 | minimax-cn | quota | ✅ |
| 8 | opencode-go | quota | ✅ |
| 9 | kimi-coding | quota | ✅ |
| 10 | commandcode | quota | ✅ |

每家的落点：

| 项 | quota 型 | balance 型 |
|---|---|---|
| 正常 | `quota.timeWindows[]`（+ `plan` / `extraQuotas`） | `balance.amount` / `currency` / `accounts[]` / `spending` |
| 无凭证 | status 2 | status 2 |
| 未适配 | status 3 | status 3 |
| 401/403 | status 4 + 白名单 message | status 4 |
| 网络/超时/5xx | status 5 + message | status 5 |
| 无有效数据 | status 6 | status 6 |
| 无生效套餐 | status 7（Kimi） | — |

## 5. 阶段 C：聚合层与前端 ✅

### 5.1 `lib/index.js`

- [x] overview 去重改 `providerId`、优先级改 `status`（1 成功 > 2/3 稳定态 > 其余）
- [x] 排序改 `pinRank(providerId)`
- [x] 未适配占位改 `{ providerId, billingType: 'quota', status: 3 }`
- [x] 抓取器抛错兜底改 `status: 5`
- [x] 缓存 TTL：成功/2/3 走正常缓存，其余走 `FAILED_CACHE_MS`
- [x] 注入展示名 `label`（来自 `provider_mappings`，快照本身不带）

### 5.2 `lib/client.js`

- [x] 新增 `PERIOD_LABEL`、`LONG_PERIODS`、`formatResetIn`、`statusDot`、`planOf`、`fmtMoneyWithCurrency`
- [x] `badgeTextState`：`status` 分流 + `timeWindows[].usedPct` / `balance.amount`
- [x] `quotaText`：改读 `timeWindows`，文案 `5h 12%`（已用口径）
- [x] `balanceText`：余额型徽标 `49.59 CNY`
- [x] `providerErrText`：`status` 分流（2/3/7 固定文案，4/5/6 白名单 message）
- [x] `providerRows`：弹层明细（窗口/附加额度/账户/消耗）
- [x] `AllProviders`：一行概览改读 `timeWindows` / `balance`
- [x] 徽标倒计时归零刷新：改读 `timeWindows[].resetAt`
- [x] 删除 `usedPctOf` / `balanceAmountOf`
- [x] 补 i18n：`card.unsupported`、`card.noPlan`

## 6. 阶段 D：清理与文档（待做）

- [ ] `provider-mappings.js` 补 `url` / `verified`（前端不再用三张硬编码表）
- [ ] 前端删除 `PROVIDER_LABELS` / `PROVIDER_URLS` / `VENDOR_OF`（改为读 mappings 下发值）
- [ ] 服务端日志记录原始响应（`raw` 不再下发后的排障手段）
- [ ] 新增 `CONTRIBUTING.md`：新增提供方 4 步 + 契约测试要求
- [ ] 更新 README 提供方适配表
- [ ] 真机回归：9 家逐一比对徽标 / 弹层 / 设置页

## 7. 风险与回滚

| 风险 | 应对 |
|---|---|
| 前端一次切换后某家渲染异常 | 已用「提取真实函数 + v2 快照」跑过 24 项逻辑验证；剩余用真机回归 |
| fetcher 自由封装导致结构漂移 | 契约测试强制，不合规立即失败 |
| 删 `raw` 后排障变难 | 阶段 D 前置：服务端日志先落地 |
| 大改造一次发布、回滚粒度粗 | 结构变更是纯数据契约，回滚 = 回退提交，无数据库迁移 |

## 8. 新增一家提供方（供 CONTRIBUTING.md）

| # | 改什么 | 必须 |
|---|---|---|
| 1 | `lib/util/fetch-quotas.js`（或独立文件）：写 `fetchXxx`，产出 v2 快照 | ✅ |
| 2 | `FETCHERS` 注册一行 | ✅ |
| 3 | `lib/util/provider-mappings.js`：`providerName` / `vendor` / `url` / `verified` | ✅ |
| 4 | `test/xxx.test.js`：v2 断言 + 契约校验 | ✅ |
| 5 | `README.md` 适配表补一行 | ✅ |
| — | `lib/client.js`、`lib/index.js` | ❌ 不许改 |

## 9. 下一步

1. 真机回归（重启桌面应用 + 刷新页面），确认 9 家显示正常；
2. 阶段 D 清理与文档；
3. 回归通过后再考虑提交与发版。
