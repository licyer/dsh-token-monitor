# 模型定价表设计（新增单表，不改既有表）

> 状态：已落地（表 + 内置多档 + 取价接入 + 用量页 UI）。
> 只**新增一张** `model_prices` 表，**不修改**既有
> `usage_requests` / `usage_daily_rollups` / `fold_watermarks` / `sync_logs`。
> 现有"折叠时即固化 `cost_usd_nano`"语义不变——历史行的金额不受后续调价影响。

---

## 1. 背景与目标

- 定价现只来自一份"当前刊例"（pi-ai 目录，单档固定价、无生效时间）；
- 模型会调价：需要"按生效时间版本化"，历史可审计、可复核；
- DeepSeek 等模型**错峰计价**：官方以**人民币**标价，高峰 = 空闲 × 倍率（§6）；
- **定价与"提供方"无关**：代理/网关/订阅只是入口，实际计费对象是**模型**。`usage_requests.provider` 保留作统计维度，计价不依赖它；
- **初始数据随包内置**，不依赖 cc-switch / pi-ai 等外部运行环境（没有 cc 的用户同样能初始化）。

## 2. 设计要点

1. **一个字段控制计价方式**：`mode`（`fixed` 固定 / `time` 峰谷）；
2. **行 = 一个模型的一个价格版本**（无 provider 维度）：`mode='time'` 的错峰规则由 `peak_windows`（只列高峰窗口）+ 模型级 `peak_multiplier`（高峰倍率）描述；
3. **单价带币种**：每行 `currency`（`USD`/`CNY`），价格列（命中输入 / 未命中输入 / 输出 / 缓存创建）均以本币种计量，P4 定点（= 币种 ×1e-4 / 1M token）；
4. **生效期不用空值**：`end_time` 非空；**当前生效版本 = 9999-12-31（哨兵 `VALID_UNTIL_OPEN`）**，调价封口 = 把区间终点改为切换时刻——查询/排序免 NULL 处理；
5. 调价 = 封口旧版 + 插入新版，旧行永久保留 → 历史金额不受影响；
6. **同模型可多行分段**（`UNIQUE(model, start_time)`）：内置"当前档 + 已公布即将生效档"，取价按请求时刻命中对应段，到点自动切换；
7. **只内置 DeepSeek 官方价**；不刷历史、不做已有库迁移（新增功能，旧库可删表重建或由用户自行维护）。

## 3. 表结构（lib/util/store.js）

```sql
CREATE TABLE IF NOT EXISTS model_prices (
  id              INTEGER PRIMARY KEY,     -- 主键，自增
  model           TEXT NOT NULL,           -- 模型 id（计价键）：deepseek-v4-flash / deepseek-chat；与代理/入口无关
  display_name    TEXT,                    -- 展示名（可选，对齐 cc-switch）
  mode            TEXT NOT NULL DEFAULT 'fixed'
                  CHECK (mode IN ('fixed', 'time')),  -- 'fixed'=固定价（全天同价）；'time'=峰谷价（高峰窗口 × 倍率）
  currency        TEXT NOT NULL DEFAULT 'USD'
                  CHECK (currency IN ('USD', 'CNY')), -- 'CNY'=DeepSeek 官方人民币；'USD'=内置价目/用户
  input_cache_hit_price INTEGER NOT NULL DEFAULT 0,  -- 输入·命中单价；P4 定点（0.05 元 → 500）
  input_price           INTEGER NOT NULL,            -- 输入·未命中单价（1.5 元 → 15000）
  output_price          INTEGER NOT NULL,            -- 输出单价（4.5 元 → 45000）
  cache_create_price    INTEGER NOT NULL DEFAULT 0,  -- 缓存创建单价；多数不收（恒 0），Anthropic 等按需
  start_time      INTEGER NOT NULL,        -- 本版本生效起点（Unix ms）；调价 = 封口旧行 + 插入新行
  end_time        INTEGER NOT NULL
                  DEFAULT ${VALID_UNTIL_OPEN}, -- 生效终点；当前生效 = 9999-12-31 哨兵（不用 NULL）
  source          TEXT NOT NULL DEFAULT 'custom',   -- 价格来源（表内统一 'custom'，预留区分外部导入）
  created_at      INTEGER NOT NULL,        -- 本行录入时间（Unix ms，审计用）
  peak_multiplier REAL,                    -- 高峰倍率（mode='time' 必填 > 0，如 2 = 高峰 ×2；'fixed' 为 NULL）
  peak_windows    TEXT,                    -- 高峰窗口规则 JSON（§3.1，mode='time' 必填；'fixed' 为 NULL）
  UNIQUE (model, start_time),              -- 同一模型同一生效起点唯一
  CHECK (mode = 'fixed' OR peak_windows IS NOT NULL),
  CHECK (mode = 'fixed' OR peak_multiplier IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_model_prices_lookup
  ON model_prices (model, start_time);     -- 取价索引：按 model + 生效期查询
```

哨兵常量：`VALID_UNTIL_OPEN = 253402300799000`（9999-12-31T23:59:59.999Z），定义于 `lib/util/store.js` 并导出（建表默认值与 seed/封口共用同一来源）。

约束/惯例：

- 同一 `model` 生效期不重叠；任一时刻命中 ≤ 1 行；
- `mode='fixed'`：只填四个 `*_price`，`peak_windows` / `peak_multiplier` = NULL；
- `mode='time'`：四个 `*_price` = **基准价（空闲价）**，`peak_windows` 与 `peak_multiplier` 必填；
- 高峰命中 = 四个桶统一 × `peak_multiplier`（结果四舍五入回整，防浮点）；未命中任何窗口 = 自动按基准价，无需穷举空闲时段。

### 3.1 `peak_windows`（JSON，仅 mode='time' 有值）

只描述高峰窗口；**倍率是模型级字段，不进窗口 JSON**。

```json
{
  "timezone": "Asia/Shanghai",
  "windows": [
    { "days": "1-5", "start": "09:00", "end": "12:00" },
    { "days": "1-5", "start": "14:00", "end": "18:00" }
  ]
}
```

- `days`：`*` 每天；`1-5` 周一至五；`6,7` 周末（可多段重复列）；
- `start` / `end`：本地时间 `HH:mm`（含起、不含止）；
- 窗口互不重叠；空数组 `[]` = 无高峰（全天按基础价）。

## 4. 取价与维护

### 4.1 取价（折叠/复核统一入口，lib/util/pricing.js）

1. **版本命中**：`ts` 查 `model_prices`：`model = ? AND start_time <= ts AND end_time > ts`，`ORDER BY start_time DESC LIMIT 1`；
2. **计价**：`mode='time'` 时按 `peak_windows.timezone` 转本地 → 命中窗口 → 各桶 × `peak_multiplier`；未命中 → 基准价；`fixed` 直接用行内价；
3. **费用**（以 `currency` 计；`cacheCreate` 通常为 0 不影响）：

```
cost_cur_nano = round((input×p_in + cacheHitInput×p_ch + output×p_out + cacheCreate×p_cc) / 10)
```

4. **固化到美元纳米**（CNY 需汇率）：

```
cost_usd_nano = (currency = 'USD') ? cost_cur_nano
               : round(cost_cur_nano / usd_cny_rate)
```

- 折叠取价 ts ≈ 请求发生时刻（实时管道，事件与折叠几乎同时）；CNY 折美元用 `getUsdCnyRate()` 当时汇率；
- 未命中任何版本 / 无任何来源 → **unpriced**（`cost = NULL`）。

### 4.2 维护（服务端 GET/POST /token-monitor/model-prices）

- **GET**：只返回**当前正在生效**的版本（`start_time <= now < end_time`，每模型一条）；未开始的已公布档、已封口旧档都不出现——到点自动换成新档行。
- **POST 保存 = 封口 + 插入**（单事务）：

```sql
BEGIN;
-- ① 生效起点：缺省 = 现在；早于现在 → 收拢到现在（不接受过去生效）；与已存在 start_time 冲突 → 400 换时间
-- ② 封口"开始时刻之前仍在生效"的行（保证无重叠）
UPDATE model_prices SET end_time = :start
 WHERE model = :model AND start_time <= :start AND end_time > :start;
-- ③ 插入新版本（end_time = 哨兵 = 生效中/待生效）
INSERT INTO model_prices
  (model, display_name, mode, currency,
   input_cache_hit_price, input_price, output_price, cache_create_price,
   start_time, end_time, source, created_at, peak_multiplier, peak_windows)
VALUES (..., :start, 253402300799000, 'custom', :now, :multiplier, :windows);
COMMIT;
```

- **现在生效**（默认）：封口当前档到"现在"，插入新档即生效；
- **未来生效（预约调价）**：`startTime` 填未来 → 当前/已公布档被封到该时刻，新档到点自动生效（列表届时自动切换）；
- 已封口历史行与已固化金额**永不变**。

### 4.3 内置档（BUILTIN_CNY，seed 仅空表写入）

内置 DeepSeek 官方价（元 / 百万 token，CNY，峰谷；工作日 09–12、14–18 高峰 ×2，倍率=2）：

| 模型 | 段 | 输入·命中 | 输入·未命中 | 输出 |
|---|---|---|---|---|
| deepseek-v4-flash | 2026-08-17 00:00 → 2026-09-10 12:00 | 0.05 | 1.5 | 4.5 |
| deepseek-v4-flash | 2026-09-10 12:00（北京，官方调价）→ open | 0.02 | 1 | 4 |
| deepseek-v4-flash-vision-exp | 2026-08-21 00:00 → 2026-09-10 12:00 | 0.05 | 1.5 | 4.5 |
| deepseek-v4-flash-vision-exp | 2026-09-10 12:00 → open | 0.02 | 1 | 4 |
| deepseek-v4-pro | 2026-08-13 00:00 → open | 0.15 | 4.5 | 13.5 |

- 每段带 `start_time`/`end_time`（open 用哨兵）；`seedModelPrices` **仅当表为空**时写入（5 行，幂等），写 `source='custom'`；
- 同 model 旧档终点 = 新档起点，无缝衔接；调价只改常量，重启后新库/删表重建自动生效（已有库不自动迁移）。

## 5. 价格桶语义映射

| 列 | pi-ai/cc-switch 对应 | 界面列 |
|---|---|---|
| `input_cache_hit_price` | cache read / `cache_read_cost_per_million` | 输入·命中 |
| `input_price` | `input_cost_per_million` | 输入·未命中 |
| `output_price` | `output_cost_per_million` | 输出 |
| `cache_create_price` | cache create | 缓存创建（不维护，按 0） |

## 6. 落地范围

- **A（已完成）**：建表 + 空表 seed（内置 DeepSeek 多档价），初始化不依赖外部环境；
- **B（已完成）**：统一取价入口 `loadPricing`（表 → pi-ai 兜底 → null），`mode='time'` 高峰窗口 × 模型级倍率，折叠计价接入（fold/CC 写行按 `model + ts` 取价、汇率折算固化）；
- **C（已完成）**：服务端 GET/POST 路由（当前生效列表 / 封口+插入，支持预约调价）与用量页"模型定价"卡片 UI（列表列：模型/定价/币种/输入·命中/输入·未命中/输出/高峰时段/高峰倍率/开始时间/操作；编辑：原行就地输入 + 高峰时段弹窗（行内增删改）+ 开始时间可改（默认当天 00:00）/自定义分段输入；字段文案与筛选下拉风格统一）。

## 7. 不变更清单（防误伤）

- 不 ALTER `usage_requests` / `usage_daily_rollups`（不加列、不改索引）；
- 不重建、不清空任何既有表（定价相关仅新建 `model_prices`，开发期可单独删表重建以重新 seed）；
- 不改 `fold_watermarks` / `sync_logs`；
- 既有页签与 rollup 查询逻辑零改动（只读固化金额）；历史记录不回刷。
