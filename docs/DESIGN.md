# dsh-token-monitor 用量数据存储设计

> 状态：实现中 · 2026-08-20 更新
> 范围：按会话 / 按天 / 按模型的 token 用量与估算费用的本地存储与聚合，含 CC-switch 历史数据一键导入。

## 实现状态总览（2026-08-20）

| 章节 | 内容 | 状态 |
|---|---|---|
| §2.1 | DSH 会话日志折叠 | ✅ 已实现（fold.js + fold_watermarks） |
| §2.2 | CC-switch 数据源（读 db + 读 sql 文件） | ✅ 已实现（读 db `importCcSwitch` + 解析 sql 文件 `importCcSqlFile`） |
| §3 | 存储选型（node:sqlite） | ✅ 已实现 |
| §4.1 | `usage_requests` 事实表 | ✅ 已实现 |
| §4.2 | `fold_watermarks` 水位表 | ✅ 已实现 |
| §4.3 | `usage_daily_rollups` 预聚合表 | ✅ 已实现 |
| §4.4 | 模型归属规则 | ✅ 已实现（折叠游标） |
| §5 | 定价与费用口径 | ✅ 已实现（唯源 pi-ai；CC 定价不导入，2026-08-20 定稿） |
| §6 | CC 导入（db 导入） | ✅ 已实现（`importCcSwitch` + `checkCcPending`） |
| §6 | CC 导入（sql 文件导入） | ✅ 已实现（`importCcSqlFile` 解析 `proxy_request_logs`；用量页"导入"入口） |
| §7 | DSH 同步节奏（5 分钟增量折叠） | ✅ 已实现 |
| §8 | 查询路由与用量页签 | ✅ 已实现（daily/by-model/sessions/hourly/distribution/calendar/rank） |
| §8 | 用量页签 UI（conversation.view） | ✅ 已实现 |
| §11.1 | 数据源注册表（SyncSource 接口） | ❌ 未实现（单源写死，多源预留） |
| §11.2 | `sync_logs` 表 | ✅ 已实现（表 + store 方法 + CC 导入接入；DSH 折叠不写，职责见 §11.2） |
| §11.3 | 同步提示条（检测 + 按钮） | ✅ 已实现（弹层打开检测 + 同步按钮 + 结果摘要） |
| §11.3 | CC 增量扫描（按 watermark） | ✅ 已实现（`checkCcPending`/`importCcSwitch` 增量，水位存 sync_logs） |
| §12 | 后续扩展 | ⏸ 预留，不做 |

## 1. 目标与非目标

**目标**

- 把本机产生的大模型调用明细（token 四项 + 估算费用）持久化到本地 SQLite，支持：
  - 按天统计 / 按模型统计（读 `usage_daily_rollups` 预聚合表，毫秒级）
  - 按会话统计（现有 `tokenUsage` 投影已覆盖，本库提供跨会话视图）
  - 估算费用（token × 刊例价，折叠时定格）
- CC-switch 历史记录（`proxy_request_logs`）一键导入，幂等、可重复执行。

**非目标（本期不做）**

- 不做工具耗时 / 审批行为 / 命令使用等行为统计（字段已在日志里，后续可加）。
- 不替代供应商侧额度查询（5h/本周窗口仍走 `/v1/usages` 实时 API）。

## 2. 数据源

### 2.1 DSH 会话日志（主源，增量折叠）

- 位置：`$DSH_HOME/sessions/<cwd编码>/session-<id>/session.jsonl.zstd`；每次扫描重新 glob 整棵树，新会话目录自动发现。
- 身份来自文件首行 header（实测）：`{"type":"session","version":0,"id":"session-…","createdAt":…,"cwd":"…"}`，水位按 header `id` 键控，不依赖目录名。
- **文件是会话级而非天级**：一个会话跨多天 = 同一文件持续追加；事件 `seq` 每个文件独立从 0 递增（实测）。"按天"是折叠/查询时按事件 `time` 分组，与文件边界无关。
- 格式：**多个独立 Zstandard 帧串接**，每帧解压后是若干行 JSONL。信封字段：`{ type, seq, time, data, ... }`，`time` 为毫秒时间戳。
- 折叠所需事件：

| 事件 | 取用字段 | 用途 |
|---|---|---|
| `session`（首行 header） | session id、cwd、createdAt | 会话登记 |
| `session/title` | `title` | 更新水位行的 `title` 列（§4.2） |
| `request/context` | `provider`、`model`、`contextWindow` | 路由归属（见 §4.3） |
| `assistant/message` | `data.usage.{inputTokens, outputTokens, cacheReadTokens}` + `turn/step` + 信封 `seq/time` | 用量事实行 |
| `step/start` / `assistant/chunk`（首 chunk） | 信封 `time` | TTFT：首 chunk 时间 − step 开始时间，写入 `ttft_ms` |
| `turn/end` | `reason` | 轮次结局（completed / error / aborted），后续做可靠性指标 |

- 分帧规则：按 zstd 帧头（魔数 `28 B5 2F FD` + 帧头内的 frame content size 字段）精确切帧，**不做魔数全文件扫描**（魔数可能恰好出现在压缩载荷里）。`node:zlib.zstdDecompressSync` 逐帧解压。
- 活跃会话：最后未闭合的帧可能不完整，只折叠到最后一个完整帧，剩余部分等下次水位推进再读。只读打开，不干扰 DSH 写入。

**折叠粒度与口径**（与 CC-switch 请求级对齐：一次成功模型请求 = 一行）：

- 一行 = 一条 `assistant/message`（一个 step 一次请求）。usage 在流式 `assistant/chunk` 里也有一份，只认 `assistant/message`，不重复计。
- **计费闸（CC 源码实测教训）**：usage 行四项任一 > 0 即入库，不要求 `output > 0`——CC 曾因要求 stop_reason 非空 + output>0 系统性低估 4.1%（92% 集中在子代理/workflow 短命请求，input/cache 在请求受理时已计费）。
- 辅助调用（标题生成 / compaction 摘要 / 联网搜索等非 step 的直接模型调用）日志只记请求、不记 usage，**不计入**——量级可忽略（标题上限 64 token），口径为"step 级用量"。
- 失败/中断请求无 `assistant/message`，不计入——与 DSH 自带 `tokenUsage` 投影口径一致，界面数字不打架。

### 2.2 CC-switch（外部平台用量来源，文件导入 + 可重入）

**角色定位**：本插件只读 DSH 本平台会话日志（§2.1）；DSH 之外平台众多（Claude Code / Codex / Gemini / OpenClaw / …），每个平台各有自己的会话日志格式，我们无法逐个适配解析——**直接消费 CC-switch 已汇总好的数据**，一份导入补齐全部外部平台用量。

**两个导入入口，两套读取方式（不共用逻辑）**：

> 状态：**两个入口均已实现**——弹层"同步"读 db（`importCcSwitch`）、用量页"导入"读 sql 文件（`importCcSqlFile` + `parseCcSqlFile`）。

- **弹层底部提示条"同步"（§11.3）**：自动检测**本机** CC 库（`~/.cc-switch/cc-switch.db`）有无未同步记录，有则提示，点同步**读 db 文件**导入本机 CC 使用记录——默认行为，无需用户干预。
- **用量页底部数据来源卡片"导入"按钮**：**跨设备**使用记录，**由用户自己手动导入**——CC 导出功能生成的 SQL 文件（`cc-switch-export-*.sql`），用户选文件后**解析 SQL 文本**导入。

**读 db 方式**：`~/.cc-switch/cc-switch.db` **只读**打开（WAL 模式下只读连接不影响其运行），SQL 查询 `proxy_request_logs` 表。
**读 sql 文件方式**：CC 导出功能生成 `cc-switch-export-*.sql`（`sqlite3 .dump` 文本格式，含 `CREATE TABLE` + `INSERT INTO` 语句），解析 `INSERT INTO "proxy_request_logs"` 语句（仅此一张表），不依赖 SQLite 库文件存在。
- **`proxy_request_logs` 字段语义澄清**（2026-08-20 评审修正）：`app_type` 是**客户端应用**（claude/codex/gemini/…），`provider_id='_session'` + `data_source='session_log'` 表示"该条记录来自该平台的会话日志"——即 CC 与我们的折叠是同一件事，只是 CC 汇聚了多个平台。**当前 CC 版本尚不支持 DSH 记录统计**（不产生 `app_type='dsh'` 的行），导入行都是外部平台的用量。
- 取 `proxy_request_logs` 单表；不导入 `usage_daily_rollups`（我们自己重聚合，口径统一）。`model_pricing` 也不导入（2026-08-20 定稿：定价唯源 pi-ai，见 §5）。

## 3. 存储选型与位置

- **`node:sqlite`**（Node 22 内置 `DatabaseSync`）：零依赖、零原生编译；DSH 自带的 session-query-sqlite 已验证同版本可用。
- 路径：`$DSH_HOME/storages/token-monitor/token-monitor.db`（与 DSH 其他存储同级）。按插件归属命名而非内容命名——库内除用量表外还有水位、同步日志等表，归属命名不随加表过时。
- 无外部写者：只有本插件服务端写库，单连接即可；开 WAL 只为读并发宽松。

## 4. Schema

全库三张表：事实表（`usage_requests`）回答"发生了什么"，预聚合表（`usage_daily_rollups`）回答"合计是多少"，进度表（`fold_watermarks`）回答"我读到哪了"。另有计划中的 `sync_logs`（§11）。

### 4.1 `usage_requests` —— 用量事实表

**粒度**：一行 = 一次成功的模型调用。DSH 侧对应一条 `assistant/message` 事件；CC 侧对应一条 `proxy_request_logs` 记录。

```sql
CREATE TABLE IF NOT EXISTS usage_requests (
  -- 主键
  record_id      TEXT PRIMARY KEY,           -- dsh: '<sessionId>:<seq>'；cc: request_id
  -- 维度
  source         TEXT NOT NULL,              -- 'dsh-logs' | 'cc-switch'（= SyncSource.id，§11.1）；来源筛选与分组键
  client         TEXT NOT NULL,              -- 产出应用（客户端）标识：DSH 行存 'dsh'；CC 行存其 app_type
  provider       TEXT NOT NULL,              -- 'kimi-coding' / 'deepseek' / cc 的 provider_id
  model          TEXT NOT NULL,
  session_id     TEXT,                       -- 会话下钻维度；CC 数据可能为空
  -- 用量
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,  -- 沉睡字段：Anthropic 系才有非 0
  -- 派生指标
  cost_usd_nano  INTEGER,                    -- 纳美元（1e-9 $）定点；折叠/导入时定格；定价缺失为 NULL
  ttft_ms        INTEGER,                    -- 首 token 延迟，可空
  -- 时间戳收尾
  day            TEXT NOT NULL,              -- 'YYYY-MM-DD'（折叠时本地时区冻结）：分桶事实，与 rollup 口径一致
  created_at     INTEGER NOT NULL,           -- 事件时间，毫秒（CC 秒级 × 1000）
);
CREATE INDEX IF NOT EXISTS idx_usage_day        ON usage_requests (day);
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model      ON usage_requests (model, day);
```

逐列说明：

| 列 | 类型 | 来源与语义 |
|---|---|---|
| `record_id` | TEXT | **单字段主键**。DSH：`sessionId:seq`（seq 会话内单调递增，拼上会话 id 即全局唯一）；CC：它的 `request_id`（UUID / `session:{app_type}:…`）。**幂等的根基**：重复折叠主键冲突，`INSERT OR IGNORE` 跳过。已评审接受的假设：跨源 id 格式不同（`session-uuid:N` vs UUID），不撞靠格式差异而非联合主键约束 |
| `source` | TEXT | 数据来源标识，取值 = SyncSource.id（§11.1）：`dsh-logs` = 本地日志折叠；`cc-switch` = CC 导入。来源筛选与分组键，为将来第三个来源留位 |
| `client` | TEXT | 产出该请求的客户端应用，**统一非空**：DSH 自有行存 `'dsh'`；CC 行存其 `app_type`（claude/codex/…，CC 的 `type` 是误命名——值是应用标识不是类型，故不沿用）。**前瞻性过滤锚点**：若 CC 将来支持 DSH 会话日志，其行会与自有折叠双算——按 `source` + `client` 即可精确区分"DSH 自采"与"经 CC 转手的 DSH"（§6 另有导入白名单双保险） |
| `provider` | TEXT | 供应商路由。DSH：`request/context` 的 provider（如 `kimi-coding`）；CC：`provider_id`（`_session` 显示为 "cc-switch"） |
| `model` | TEXT | 模型 id（如 `k3`、`deepseek-v4-pro`）。按模型统计的分组键，也是定价查询的键 |
| `session_id` | TEXT 可空 | 会话下钻维度。CC 的 session 概念与 DSH 不同（Claude Code 的会话 id），原样保留，只做展示不关联 |
| `input_tokens` | INTEGER | 未缓存输入 token（供应商回报值） |
| `output_tokens` | INTEGER | 输出 token（含推理 token，pi-ai 口径已折叠进去） |
| `cache_read_tokens` | INTEGER | 缓存命中 token。DSH 事件里叫 `cacheReadTokens`，CC 同名 |
| `cache_write_tokens` | INTEGER | 缓存写入 token。当前供应商恒 0（DeepSeek 无此计量、Kimi k3 写入价 0）；CC 的 `cache_creation_tokens` 映射到此列。为 Anthropic 系预留，schema 不动即可启用 |
| `cost_usd_nano` | INTEGER 可空 | 估算费用，**纳美元（1e-9 $）定点整数**——不用 REAL：f64 无法精确表示十进制小数，海量行 `SUM` 会积累尾差。纳刻度精确覆盖 CC 数据的 9 位小数（64 位上限 ~92 亿美元，无溢出之虞）。写入时定格（§5）。可空：目录无此模型定价时为 NULL，统计计入 token 但不计入费用。CC 行搬它的 `total_cost_usd`（9 位小数 → ×1e9 精确转整数） |
| `ttft_ms` | INTEGER 可空 | 首 token 延迟。DSH：该 step 首个 `assistant/chunk` 时间 − `step/start` 时间；CC：直接搬 `first_token_ms`。衡量"模型今天快不快"的体感指标 |
| `day` | TEXT | `created_at` 按**折叠时本地时区**折算的 `YYYY-MM-DD`，写入时冻结。**职责是分桶事实的物化而非分组优化**（按天分组已由 rollup 承担）：下钻查询 `WHERE day = :day` 与 rollup 行的构成口径逐字一致——若只存 `created_at`，跨时区后按查询时时区切范围会和 rollup 的冻结分桶对不上账 |
| `created_at` | INTEGER | 事件发生的毫秒时间戳。DSH 取事件信封 `time`；CC 的 `created_at` 是秒，×1000。时间窗查询（"近 7 天"）走它的索引 |

索引设计：

| 索引 | 服务的查询 |
|---|---|
| `idx_usage_day (day)` | 按天分组、按天过滤（最高频） |
| `idx_usage_created_at (created_at)` | 任意毫秒时间窗范围扫描 |
| `idx_usage_model (model, day)` | 按模型排行、单模型的时间序列 |

主键 `record_id` 本身产生唯一 B-tree，会话维度的查询走前缀（`record_id LIKE '<sessionId>:%'`）即可命中，不单列 `session_id` 索引（低频，全表扫也小）。

示例行（Kimi 一次调用）：

```
source='dsh-logs', record_id='session-0e7c…:146',
session_id='session-0e7c…', client='dsh', provider='kimi-coding', model='k3',
input_tokens=1912, output_tokens=220, cache_read_tokens=5632, cache_write_tokens=0,
cost_usd_nano=1912×3000 + 220×15000 + 5632×300 = 10,725,600（= $0.0107256，全程整数运算）,
ttft_ms=3488,
day='2026-08-17', created_at=1786952002247
```

### 4.2 `fold_watermarks` —— 折叠水位表

**粒度**：一行 = 一个 DSH 会话日志的读取进度。CC 导入不参与此表（它靠 `usage_requests` 主键幂等）。

```sql
CREATE TABLE IF NOT EXISTS fold_watermarks (
  session_id    TEXT PRIMARY KEY,
  log_path      TEXT NOT NULL,
  last_seq      INTEGER NOT NULL,            -- 已折叠到的最大 seq
  file_mtime_ms INTEGER NOT NULL,            -- 上次见到的文件 mtime（毫秒），用于快速跳过未变文件
  title         TEXT,                        -- 会话标题：折叠到 session/title 事件时更新，可空（未生成标题的会话）
  updated_at    INTEGER NOT NULL
);
```

逐列说明：

| 列 | 语义 |
|---|---|
| `session_id` | 主键，取自日志首行 header 的权威 `id`（不是目录名），文件改名/移动不影响正确性 |
| `log_path` | 该会话日志的绝对路径，仅作登记与诊断用，不作为身份依据 |
| `last_seq` | 已折叠的最大事件 seq。新会话水位初始 -1（首事件 seq=0 会被收入）。每轮扫描只处理 `seq > last_seq` |
| `file_mtime_ms` | 上轮见到的文件修改时间（**毫秒**，列名带单位——CC 曾因秒/纳秒混用被迫做兼容，此处预防）。扫描入口先 stat，`file_mtime_ms` 没变直接跳过整个文件——不解压、不解析，活跃但无新事件的会话零成本 |
| `title` | 会话标题，可空。日志里有 `session/title` 事件（`{title, messageSeqs, source}`，标题刷新会产生新事件），折叠到该事件时顺手更新此列。会话下拉/下钻列表显示名称就不必再查别的存储 |
| `updated_at` | 水位行本身的最近推进时间，诊断用（能看出某个会话最后一次产生数据是什么时候） |

生命周期：

- **插入**：发现一个从未见过的 session id（新会话目录）时插入初始行（`last_seq = -1`）
- **更新**：每轮成功折叠后，与 `usage_requests` 的数据行在**同一事务**内更新（§7 防重复三道防线）
- **删除**：日志文件消失（会话被删）时清掉对应水位行；已折叠进 `usage_requests` 的历史数据保留

### 4.3 `usage_daily_rollups` —— 按天预聚合表

**粒度**：一行 = （天 × 来源 × 供应商 × 模型）的合计。仿 CC-switch 的同名表，但两点改良：①折叠**同事务增量 upsert**，非定期回灌，永远新鲜；②**未定价请求单列计数**，不会把"没定价"悄悄当 0 混进费用。

```sql
CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  day       TEXT NOT NULL,                 -- 'YYYY-MM-DD'（本地时区）
  source    TEXT NOT NULL,                 -- 'dsh-logs' | 'cc-switch'，保留来源以支持筛选/下钻
  provider  TEXT NOT NULL,
  model     TEXT NOT NULL,
  requests         INTEGER NOT NULL DEFAULT 0,   -- 调用次数
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_nano    INTEGER NOT NULL DEFAULT 0,  -- 纳美元定点，仅累加已定价的行
  unpriced_requests INTEGER NOT NULL DEFAULT 0,  -- cost_usd_nano 为 NULL 的行数（改良点②）
  ttft_sum_ms      INTEGER NOT NULL DEFAULT 0,   -- 配合 ttft_count 算均值
  ttft_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, provider, model)
);
```

逐列说明：

| 列 | 语义 |
|---|---|
| `day` / `source` / `provider` / `model` | 联合主键，即聚合维度。`source` 保留进主键（CC 的 provider 命名与 DSH 不同，直接合并会串行） |
| `requests` | 该组调用次数（对应 CC 的 `request_count`） |
| token 四列 | 该组 token 合计，与明细表同口径 |
| `cost_usd_nano` | 该组费用合计（纳美元定点）；只累加 `cost_usd_nano IS NOT NULL` 的明细行，整数加法精确无漂移 |
| `unpriced_requests` | 定价缺失的行数：界面可提示"另有 N 次调用未定价"，而不是让费用显得虚假精确 |
| `ttft_sum_ms` / `ttft_count` | TTFT 累加器，均值 = sum/count；不存 avg 是避免增量更新的浮点漂移 |

维护方式（改良点①）：折叠每条 `usage_requests` 时，在**同一事务**内对 rollup 做 upsert：

```sql
INSERT INTO usage_daily_rollups (day, source, provider, model, requests, input_tokens, ..., ttft_count)
VALUES (:day, :source, :provider, :model, 1, :in, ..., :hasTtft)
ON CONFLICT(day, source, provider, model) DO UPDATE SET
  requests = requests + 1,
  input_tokens = input_tokens + excluded.input_tokens,
  -- …其余列同理；cost_usd_nano 用 COALESCE(excluded.cost_usd_nano, 0)
```

CC 导入走同一个 upsert，无需特殊处理。行数上界 = 天数 × 来源 × 供应商 × 模型，一年千级，查询永远毫秒。

修复路径：明细表是唯一事实源，rollup 损坏或口径调整时 `DELETE` + `INSERT ... SELECT ... GROUP BY` 全量重建。

### 4.4 模型归属规则

`assistant/message` 本身不带模型。折叠时维护"最近一个 `request/context` 的 (provider, model)"游标，后续 usage 行归到该路由；会话中途换模型时归属自动切换。

## 5. 定价与费用口径

- **唯一定价源（主）**：pi-ai 本地模型目录（`@earendil-works/pi-ai` 包内 `dist/providers/data/*.json`），随 DSH 安装，读取不联网。
- **计算时点**：折叠（或导入）时定格，写入 `cost_usd_nano`。全程整数运算：刊例价（$/百万 token，可有 4 位小数如 0.0028）量化为 P4 整数（price × 1e4），`cost_nano = round(tokens × P4 / 10)`——单请求取整误差 ≤ 0.5 纳美元，聚合为精确整数加法。
- **定价缺失**：目录查不到该 model → `cost_usd_nano = NULL`，统计时该行不计入费用但计入 token；界面显示"未定价"。
- **CC 导入行**：搬它的 `total_cost_usd`（TEXT 十进制 → 定点解析 ×1e9 取整，9 位小数内精确），**不用任何定价目录重算**（其价格为当时口径，且重算会丢失它实付的 multiplier 等因素）。
- **展示换算**：API 返回前由 Host 统一 ÷1e9 转成美元数值/字符串；界面永远不见纳美元。
- 单位统一 USD；界面如需 ¥ 展示，乘以固定汇率展示层处理（本期不做）。

## 6. CC-switch 导入计划

> 状态：**db 文件导入已实现**（`importCcSwitch` + `checkCcPending`）；**SQL 文件导入已实现**（`importCcSqlFile` + `parseCcSqlFile`，只解析 `proxy_request_logs` 一张表）；**定价表不导入**（2026-08-20 定稿：定价唯源 pi-ai，见 §5）。

导入对象：**请求记录**（`proxy_request_logs`），来源可为 CC 库文件（`~/.cc-switch/cc-switch.db`）或 CC 导出的 SQL 文件（`cc-switch-export-*.sql`）。

**SQL 文件解析器**（`parseCcSqlFile`）：逐行扫描，两步判断（先认 `INSERT INTO` 大小写不敏感 → 再提取表名只留 `proxy_request_logs`，可带引号/无引号/表名大小写），引号感知逗号切分 VALUES，跨行 INSERT 收集兜底。实测真实导出 3180 行全提取 + 5 种书写变体全通过。

**请求记录字段映射**（CC `proxy_request_logs` → `usage_requests`）：

| CC `proxy_request_logs` | `usage_requests` | 转换 |
|---|---|---|
| `request_id` | `record_id`（source='cc-switch'） | 直接 |
| `created_at` | `created_at` | 秒 → 毫秒 ×1000 |
| `session_id` | `session_id` | 直接，可空 |
| `provider_id` | `provider` | `_session` 显示名映射为 `cc-switch` |
| `app_type` | `client` | 直接搬；**导入白名单**：只接受已知类型（claude/codex/gemini/opencode/grokbuild/pi），未知类型（如将来的 `dsh`）整行跳过计入 skipped——防止 CC 支持 DSH 后与自有折叠双算 |
| `model` | `model` | 直接 |
| `input_tokens` / `output_tokens` | 同名列 | 直接 |
| `cache_read_tokens` | `cache_read_tokens` | 直接 |
| `cache_creation_tokens` | `cache_write_tokens` | **改名映射**，同一概念 |
| `total_cost_usd` | `cost_usd_nano` | TEXT 十进制 → 定点解析 ×1e9（9 位小数内精确） |
| `first_token_ms` | `ttft_ms` | 直接搬，可空 |

执行规则：

- **两套导入逻辑，不共用**：
  - **弹层"同步"（§11.3）**：读 **db 文件**——SQLite 只读打开 `~/.cc-switch/cc-switch.db`，直接查询 `proxy_request_logs` 表。本机记录，默认自动检测。
  - **用量页"导入"**：解析 **SQL 文件**——CC 导出功能生成的 `cc-switch-export-*.sql`（`sqlite3 .dump` 文本格式，含 `CREATE TABLE` + `INSERT INTO` 语句）。逐条解析 `INSERT INTO "proxy_request_logs"`，不依赖 SQLite 库文件存在。跨设备记录，用户手动选文件。
- 两种来源的字段映射与口径归一规则完全一致（上文两张映射表），只是读取方式不同：db 走 SQL 查询、sql 文件走语句解析。
- `INSERT OR IGNORE`：主键去重，重复导入/点多次无副作用。
- 导入的明细行同样按 §4.3 的 upsert 规则进 `usage_daily_rollups`（以 INSERT 的 `changes() > 0` 为条件），导入完成汇总立即可查。
- 失败处理：db 文件不存在 → 提示未安装 CC-switch；sql 文件不存在/格式不符 → 提示文件无效；schema 版本不符（缺列）→ 报具体缺失列，不部分导入。
- **输入口径归一**：CC 的 `input_tokens` 是否含缓存由 `input_token_semantics` 列标记（CC 踩过的坑）；导入时按该列换算为"未缓存输入"，与 DSH 侧 `uncachedInputTokens` 同口径，保证"新增输入"指标两源可比。

## 7. 同步节奏（DSH 日志折叠）

- 插件启动时全量扫一次 `$DSH_HOME/sessions/**/session.jsonl.zstd`（mtime ≤ 水位的跳过）。
- 之后每 **5 分钟**增量扫；详情弹层打开时触发一次增量扫。
- 每次只折叠 `seq > watermark.last_seq` 的事件，完成后推进水位。单遍顺序读，内存占用 O(1)。

**防重复三道防线**：① file_mtime_ms 不变直接跳过文件；② seq 水位线，只折 `seq > last_seq`；③ 主键 `record_id` + `INSERT OR IGNORE` 幂等吸收。数据行写入、rollup upsert（§4.3）与水位推进在**同一事务**提交——崩溃不产生"数据已进、水位未进"的半截状态。实现细节：rollup upsert 以明细 INSERT 的 `changes() > 0` 为条件执行，保证病态场景（水位表丢失但明细仍在）下重折也不会双计。

## 8. 查询与展示

服务端新增路由（与现有 `/token-monitor/overview` 并列）。**按天/按模型的汇总一律读 `usage_daily_rollups`**（毫秒级），明细表只服务于会话级下钻：

- `GET /token-monitor/usage/daily?days=30` → 读 rollup：`[{ day, model, requests, input_tokens, output_tokens, cache_read_tokens, cost_usd, unpriced_requests, ttft_avg_ms }]`（`cost_usd` 为 Host 由 `cost_usd_nano` ÷1e9 换算后的展示值）
- `GET /token-monitor/usage/by-model?days=30` → 读 rollup 按模型汇总
- `GET /token-monitor/usage/sessions?day=...` → 读明细表按会话下钻（低频，量小）
- `GET /token-monitor/usage/hourly` → 当天趋势（渲染就绪 buckets，含平均 TTFT）
- `GET /token-monitor/usage/distribution` / `calendar` / `rank` → 历史全量图（服务端聚合）
- `GET /token-monitor/usage/sources` → 数据来源路径；`POST` 同路由 `{ source }` 打开本地目录
- `POST /token-monitor/import/cc-switch` → db 导入（`{ imported, skipped, skippedUnknownApp }`）；`DELETE` → 清空 CC 来源数据（含 sync_logs）
- `POST /token-monitor/import/cc-switch/sql` → SQL 文件导入（body 为文件内容）
- `GET /token-monitor/sync/pending` → 本机 CC 库未同步探测（增量）

界面路线（已评审定稿）：

- **弹层（保持轻量，不再加料）**：供应商额度卡 + 本会话用量卡（会话下拉）。**跨会话的用量统计不进弹层**——弹层信息量已饱和。
- **终态（方案 4，用量统计的唯一归宿）**：注册 `conversation.view` 槽位，在主区与"对话 / 轨迹"并列加"**用量**"页签，整区做数据面板——时间窗切换、大数字卡组、按天趋势图、按模型排行、按会话明细表、费用专题。
- **入口**：详情弹层会话下拉的**名称右侧加"↗ 详情"入口**，点击打开主区"用量"页签（通过运行时的视图切换机制激活对应 view）。

弹层与主区页签读同一组 Host 路由，无数据口径分叉。

## 9. 容量与演进

增长模型：一次模型调用 = 明细一行。参考 CC-switch 实测：4.5 个月 ≈ 3416 行（~25 行/天，轻度）；重度使用按一天数千行估算，一年数百万行。

**汇总查询与明细增长解耦**：按天/按模型/费用等所有高频汇总一律读 `usage_daily_rollups`——其行数上界 = 天数 × 来源 × 供应商 × 模型（一年千级），无论明细涨到多少行，汇总查询恒为毫秒级。明细表只服务会话级下钻（带窗口 + 索引，实测百万行 <150ms）。

实测 benchmark（node:sqlite，100 万行合成明细，2026-08-17）：近 30 天按天聚合 81ms、近 30 天 × 模型 132ms、全量全表汇总 1127ms——rollup 让交互路径完全绕开第三种。

演进余量：明细表涨到千万级时，下钻查询可加 `(source, session_id)` 索引或按年分表；rollup 口径调整时从明细 `DELETE` + `INSERT SELECT GROUP BY` 重建。

## 10. 风险与注意

| 风险 | 缓解 |
|---|---|
| DSH 日志格式版本演进 | 读取时对未知事件类型跳过；`session.jsonl.zstd` 布局变化会在启动扫描时报错并跳过该会话，不影响整体 |
| 活跃会话写入中读取 | 只读 + 只折叠完整帧；水位推进天然处理 |
| CC-switch 运行中占用 db | 只读连接；WAL 下读不阻塞 |
| 删除会话日志 | 已折叠数据保留在库里（历史不因删日志消失）；被删会话的水位行顺手清掉 |
| 刊例价更新 | 历史成本定格不重算；token 在库可随时全量重定价 |
| 多 DSH 实例同写 token-monitor.db | 当前部署单实例；暂不处理，多实例时加文件锁 |

## 11. 同步日志与按需同步

> 状态说明：§11.3 检测 + 同步按钮**已实现**；§11.2 `sync_logs` 表已建（含 2026-08-20 新增两列），**写入逻辑未实现**；§11.1 注册表**未实现**（当前单源写死）。

需求：新增同步日志表；每次启动检查各数据源是否有待同步数据，有则给出按钮按需同步；设计时考虑多数据源扩展。

### 11.1 数据源注册表（扩展性的根）

参考 CC `sync_all_unlocked` 内核：所有数据源实现统一接口，注册进一张表驱动的清单：

```ts
interface SyncSource {
  id: string;                    // 'dsh-logs' | 'cc-switch' | 将来的新工具
  label: string;                 // 界面显示名
  mode: 'auto' | 'manual';       // dsh-logs 常驻自动折叠；cc-switch 等导入源为 manual
  check(): Promise<PendingInfo>; // 轻量探测：有无新数据（不读全量）
  sync():  Promise<SyncResult>;  // 执行同步
}
interface SyncResult { imported: number; skipped: number; filesScanned: number; errors: string[] }
```

- 新数据源 = 实现接口 + 注册一行，框架/日志/按钮逻辑零改动（CC 就是这么加 Codex/Gemini/OpenCode/Pi 源的）。
- 全局单飞互斥（参考 CC 的 `session_sync_mutex`），手动与自动不并发。
- 单源失败不拖垮全局：按源捕获错误进 `errors`，结果按源合并（CC 的 `merge_sync_step` 模式）。

### 11.2 `sync_logs` 表

> 状态：**表已建 + store 方法已实现 + CC 导入已接入（2026-08-20 定稿）**；DSH 折叠**不写** sync_logs（增量走 `fold_watermarks`，§4.2/§7；sync_logs 仅作 manual 源审计）。

```sql
CREATE TABLE IF NOT EXISTS sync_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,        -- SyncSource.id
  kind        TEXT NOT NULL,        -- 'db-scan'（弹层读本机 db）| 'sql-import'（用量页解析 SQL 文件）
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,              -- NULL = 进行中（崩溃遗留据此识别）
  status      TEXT NOT NULL,        -- 'running' | 'ok' | 'partial' | 'failed'
  imported    INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  skipped_unknown_app INTEGER NOT NULL DEFAULT 0,  -- 2026-08-20 新增：定稿口径（只统计未知应用跳过）
  watermark   INTEGER,               -- 2026-08-20 新增：本次同步扫到的最大 created_at（毫秒），增量探测游标
  files_scanned INTEGER NOT NULL DEFAULT 0,
  errors      TEXT                  -- JSON 数组
);
```

界面可回答"上次什么时候同步的、同步进来多少、有没有失败"。

**职责划分（2026-08-20 定稿）**：
- **DSH 折叠（auto）**：增量走 `fold_watermarks`（字节/序号水位），**不写** sync_logs。
- **CC db-scan（弹层"同步"）**：`importCcSwitch` 导入后写一行 sync_logs（kind='db-scan'，含 imported / skipped_unknown_app / watermark）；`checkCcPending` 以**该 kind** 最近成功同步的 watermark 为起点增量探测本机 db。
- **CC sql-import（用量页"导入"）**：`importCcSqlFile` 解析 SQL 文件后写一行 sync_logs（kind='sql-import'，**无水位语义**——SQL 文件是全量快照，无法确认是否同机，去重靠 `record_id` 幂等；watermark 恒 null，不参与任何增量探测）。**两种 kind 的水位互不混用**：`getLastSyncWatermark(source, kind)` 按 kind 过滤，sql-import 的水位不污染 db-scan 探测。
- **删除 CC 数据**：`deleteBySource('cc-switch')` 同时清空该源 sync_logs（审计 + 水位）——否则删除后 `checkCcPending` 会认为记录全部"未同步"（imported 集合已空）→ 弹层又提示可同步 → 重新导入，删除形同虚设（2026-08-20 修复）。
- 三表各司其职：`fold_watermarks`=折叠游标、`sync_logs.watermark`（db-scan）=导入游标、`sync_logs` 行=审计。

### 11.3 启动检查 + 详情底部同步提示（交互定稿）

> 定位：manual 源（CC-switch）的**自动检测 + 按需同步**（**本机**记录）。默认行为——弹层打开时自动探测本机 CC 库有无未同步记录，有则底部提示条给出"同步"入口；检测与同步是两件事，检测不写日志，点同步才执行导入。**跨设备记录不在弹层提示范围**——那是用量页数据来源卡片"导入"按钮的职责（用户手动导入，§2.2）。

交互流程（以 CC-switch 为例，其他 manual 源同构）：

1. **启动检查**：插件启动时对每个注册源跑 `check()`——轻量探测，不读全量（cc-switch：库存在且存在未导入行；dsh-logs：`file_mtime_ms` 有变化的文件数）→ 得出每源 pending 摘要。
2. **底部提示条**：有 manual 源 pending 时，**详情弹层底部**（"更新于 … / 刷新"一行之上）出现提示条：

   ```
   ┌──────────────────────────────┐
   │ ⓘ CC-switch 有 1,234 条使用记录未同步  [ 同步 ] │
   └──────────────────────────────┘
   ```

   多个源 pending 时逐源一行；无 pending 则整条不渲染（不占日常界面）。
3. **用户点击同步**：按钮进入"同步中…"（禁用，复用刷新按钮的 loading 态）→ Host 执行 `sync()` → 完成后提示条更新为结果摘要（"已同步 1,234 条 · 跳过 12 条"），3 秒后淡出；失败则显示失败原因与重试按钮。
4. **落日志**：CC 导入（manual 源）每次同步写 `sync_logs` 一行；启动检查发现 pending 但用户未点，不写日志（只检测不算同步）。
5. **auto 源**（dsh-logs）维持 §7 常驻折叠，增量走 `fold_watermarks`，**不写** sync_logs（§11.2 职责划分）。

Host 路由（当前实现）：`GET /token-monitor/sync/pending`（弹层打开时拉一次 + 同步后重拉）/ `POST /token-monitor/import/cc-switch`（读本机 db 导入；返回 `{ imported, skipped, skippedUnknownApp, filesScanned, errors }`）。通用 `POST /token-monitor/sync { source? }` 路由为将来多源预留，当前未实现（§12 或单源先跑通后加）。

**统计口径（2026-08-20 定稿）**：导入结果**只向用户展示两数**——`imported`（新导入）与 `skippedUnknownApp`（未知应用跳过）。已导入的重复行（主键冲突）与白名单内正常导入都不算"跳过"、不统计；`skipped` 字段保留在返回体里供内部调试，前端提示条不显示它（避免"跳过 3180 条"这类对重复数据的误导性提示）。

## 12. 后续扩展（预留，不做）

- 可靠性面板：`llm/retry` 重试率、`turn/end` 失败率
- 工具维度：调用频率、平均耗时、错误率（`tool/call` ↔ `tool/result`）
- 会话级明细页：点某天展开到会话列表
- 手动重定价命令（定价表更新后回刷历史）
- 明细保留期 + 剪枝（参考 CC `rollup_and_prune`：30 天前明细归档进 rollup 后删除；本地午夜对齐 + 剪枝前成本回填。我们 rollup 实时 upsert 已完整，届时剪枝只是 `DELETE FROM usage_requests WHERE day < cutoff`）

## 附录 A：CC-switch 源码参考结论（2026-08-17 评审）

| CC 的设计 |  verdict | 说明 |
|---|---|---|
| `SessionSyncResult` 按源合并 + 单源错误不拖垮全局 | ✅ 采纳（§11.1/§11.2） | 同步结果形状与 sync_logs 列直接沿用 |
| 游标推进与数据插入绑成原子事务 | ✅ 已在设计（§7） | 与我们三道防线方案互相印证 |
| "任一计费维度 > 0 即导入" | ✅ 采纳（§2.1 计费闸） | 他们实测旧口径低估 4.1%，集中在子代理短命请求 |
| 全局同步互斥锁（单飞） | ✅ 采纳（§11.1） | 手动/自动同步不并发 |
| mtime 秒→纳秒免迁移技巧 | 🔶 备用 | 旧值自然触发一次幂等重扫；我们水位若改精度可用同款 |
| 跨源指纹去重（DedupKey：时间窗 ±N 秒 + token 全等 + model 模糊匹配） | 🔶 备档 | 他们代理+日志双写同一请求才需要；我们双源不重叠。将来若引入代理源再启用 |
| `rollup_and_prune` 保留期剪枝 | 🔶 可选扩展（§12） | 本地午夜对齐、剪枝前回填缺失成本两个细节值得照搬 |
| 文件内同 message.id 多快照选代表行 | ❌ 不适用 | Claude 日志同一消息多条快照才需要；DSH 的 `assistant/message` 一请求一条 |
| 写穿式托盘缓存 `usage_cache.rs` | ❌ 不参考 | 我们前端 60s 轮询已覆盖，无托盘场景 |
