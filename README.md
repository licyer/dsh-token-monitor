# dsh-token-monitor

DeepSeek Harness（DSH）Web 界面的模型余量与用量监控插件：

1. **余量徽标**：会话头部右侧（`conversation.session.header.utilities` 槽位）显示当前会话
   所用模型对应供应商的余量徽标，点击弹出详情层。
2. **用量页签**：主区与"对话 / 轨迹"并列的"用量"页签（`conversation.view` 槽位），
   展示按天/按模型/按会话的 token 用量与估算费用面板。

## 功能

### 余量监控（详情弹层）

- **当前模型余量**：徽标 = 当前模型 + 该供应商关键指标（如 `k3 · 5h 剩 82%`、
  `deepseek-v4 · 12.34 CNY`）。当前模型通过 `session.models` RPC 实时读取。
  余量规则：7 天额度耗尽时显示 `7d 剩 0%`（告急优先），否则显示 5 小时余量；
  5 小时窗口缺失时降级显示 7 天余量。
- **本会话用量**：读 `tokenUsage` / `contextPressure` 投影（输入/输出/缓存读写
  token、上下文占用条），弹层内可切换会话下钻。
- **全部模型监控**：弹层内折叠区列出服务端聚合的所有供应商状态（Kimi 显示
  `5h · 7d` 余量、DeepSeek 显示余额）。
- **同步提示条**：检测到 cc-switch 有未同步数据时，弹层底部出现"检测到
  cc-switch 有 N 条请求记录可同步 [同步]"提示条，一键同步，成功后倒计时自动关闭。

### 用量统计（本地 SQLite）

- **自动折叠**：增量解析 `$DSH_HOME/sessions/**/session.jsonl.zstd`（多帧 zstd
  JSONL），把每次模型调用的 token 四项 + 估算费用写入 `usage_requests` 事实表，
  同事务维护 `usage_daily_rollups` 预聚合与 `fold_watermarks` 水位。启动即扫、
  之后每 5 分钟增量扫，查询路由前也会先增量折叠。
- **明细保留**：`usage_requests` 明细按天保留 60 天（本地午夜对齐完整天），
  清理检查挂载在折叠入口（内存时间闸，24h 内零开销），到点自动删除过期明细；
  只删明细不碰 rollup——历史按天统计由预聚合表继续承载。清理记录写入
  `sync_logs`（kind=`prune`），进程重启后从该表恢复时间闸。
- **定价**：唯一定价源为 pi-ai 本地模型目录（随 DSH 安装，不联网），费用按
  纳美元定点整数计算，折叠时定格；目录缺失该模型时标记"未定价"，计入 token
  不计入费用。
- **用量页签**：时间窗切换（当天/7/30/90 天/**全部**）、大数字卡组（调用次数 / Token 总消耗 /
  估算费用 / 平均 TTFT）、按天趋势折线图（echarts 懒加载：成本 + token 四构成，
  双 Y 轴）、按模型排行（模型 / 供应商 / 客户端 / 调用 / token / 费用）、按会话
  明细（弹层"用量详情"→ 聚焦该会话：客户端=dsh、时间窗=全部、横幅可取消聚焦）。
- **CC-switch 历史导入**：只读打开 `~/.cc-switch/cc-switch.db`，幂等导入
  （`INSERT OR IGNORE`），app_type 白名单 + 输入口径归一防双算。供应商按模型
  反查 pi-ai 目录推断真实供应商（`deepseek-v4-pro` → `deepseek`），并在写入时
  归一化 DSH 路由名（`deepseek-official` → `deepseek`），两源口径统一。
  **历史聚合一并迁移**：CC 的 `usage_daily_rollups`（30 天前归档的按天聚合）
  以覆盖语义（有则替换、无则新增）同步进本库 rollup，走独立水位
  `kind='db-rollup'` 增量——6 月起的归档历史（如 9.6 亿 token）一次补齐，
  重复同步/明细老化均不会双算。

## 数据源（服务端）

| 供应商 | 类型 | 端点 |
|---|---|---|
| Kimi For Coding | 订阅额度 | `GET /coding/v1/usages`（7天用量 + 频限明细滚动窗口）+ `GET /coding/v1/me`（权益等级名）——2026-08 实测校准，展示口径对齐官方控制台 |
| DeepSeek | 账户余额 | `GET /user/balance`（官方接口） |

凭证按 `apiKeyEnv` 引用解析：先走 DSH 的 credentials seam
（`~/.dsh/.credentials.yaml`），再退回进程环境变量。Key 不离开服务端。

## 安装

```sh
# 在 web profile 里安装本包（pnpm link）
dsh plugin --profile web add E:\VsCodeProjects\dsh-token-monitor
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 的顶层数组里追加一行：

```yaml
- insert:
    - id: token-monitor
      name: dsh-token-monitor
      # config:
      #   cacheMs: 60000
      #   providers:
      #     kimi-coding:
      #       url: https://api.kimi.com/coding/v1/usages   # 端点漂移时钉死/改指
      #   ccSwitchDb: ~/.cc-switch/cc-switch.db             # CC 导入库位置
```

重启 `dsh web` 后生效。改**前端**（`lib/client.js`）会被 dsh-client-hmr 轮询
发现并热替换，刷新页面即生效；改**服务端**（`lib/index.js` 及其引用的模块）
需要重启进程。

## 文件

- `lib/index.js` — 服务端：webServer 路由（overview + usage/daily、by-model、
  sessions + CC 导入 + 同步探测 + echarts vendor 静态分发）、供应商抓取器、
  60s 缓存、折叠调度。
- `lib/client.js` — 前端：余量徽标 + 详情弹层 + "用量"页签（趋势图用 echarts，
  经 vendor 路由懒加载），手写 `__ModuleLoader__` 懒 CJS 格式，无构建步骤。
- `vendor/echarts.min.js` — echarts 5.6.0 完整构建（Apache-2.0），由
  `GET /token-monitor/vendor/echarts.min.js` 分发；升级时替换此文件即可。
- `lib/util/store.js` — `node:sqlite`（`DatabaseSync`）打开/初始化用量库，明细插入 +
  rollup upsert + 水位读写 + 事务包装。
- `lib/util/fold.js` — 会话日志折叠器：zstd 帧精确切分、增量水位、TTFT 计时、供应商名归一化。
- `lib/util/import-cc.js` — CC-switch `proxy_request_logs` 幂等导入 + 未同步探测。
- `lib/util/pricing.js` — pi-ai 刊例价目录加载、纳美元定点费用计算、模型→供应商反查。
- `DESIGN.md` — 存储与同步设计（schema、口径、同步节奏、演进）。

## 设计要点（详见 DESIGN.md）

- 计费闸：usage 四项任一 > 0 即入库，不要求 output > 0（CC 曾因此低估 4.1%）。
- 防重复三道防线：文件 mtime 跳过 → seq 水位 → 主键 `INSERT OR IGNORE`，
  数据行 / rollup / 水位同事务提交。
- 高频汇总读 `usage_daily_rollups` 预聚合表；含客户端维度时读明细表（数千行，
  毫秒级），与明细增长解耦。
