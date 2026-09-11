# dsh-token-monitor × DSH 官方接口触点清单

> 用途：本插件与 DSH（deepseek-harness）官方运行时交互的**全部触点**。
> DSH 升级后做兼容排查时，按本文档逐项“定向核对”，不需要再全量扫源码。
> 定位一律用【检索词】（函数名 / 常量 / 槽名 / 事件名）而非行号——行号随改动漂移。
>
> 兼容策略约定：凡存在新旧两代调用的点，一律 **新版（0.1.2+）优先，新版不可用（未升级）再回退旧版（≤0.1.1）**；
> 两代共用同一机制的（如 useProjection 会话投影）无分支。
> 当前基线：实测环境 DSH **0.1.5-rc.1**；上一基线为 0.1.2-rc.1（"新版/旧版"的分界仍以 0.1.2 计）。≤0.1.1 分支为按旧契约写的回退路径（当前环境无法回归）。

---

## A. 客户端运行与声明契约

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 客户端模块格式 | `window.__ModuleLoader__.load`（client.js 首行） | 手写懒 CJS 模块，无需构建 | 0.1.1 / 0.1.2 通用（dsh-client-modules） | bundle 加载协议是否变化 |
| 客户端入口导出 | `exports["./client"]`（package.json） | 官方发现客户端 bundle | 两版通用 | exports 子路径是否变化 |
| 客户端平台/注入声明 | `dsh.client.platform: "web"`、`dsh.client.inject`（package.json） | 声明注入的宿主插件 | `inject` 在 0.1.2 为 **informational**（官方注释），包不存在也不报错；对 0.1.1 仍有意义 → 保留。**0.1.5 起 `@deepseek-ai/dsh-client-runtime` 已不再发布，声明已移除**，只留 `@deepseek-ai/dsh-client-connection` | 0.1.1 宿主插件清单变化时更新 |
| profile 补丁契约 | `cordis.patch.yml` + `dsh.bundle.patch`（package.json） | 把插件插入 web profile 的 cordis 根 | 两版通用 | patch insert 语法/加载机制变化 |
| 插件注入清单 | `inject = ["slots", "connection", "locale"]`（client.js 模块级） | 声明要用的 Cordis 客户端服务 | 0.1.2 均有 | 服务名若改名需同步 |

## B. 客户端 Cordis 服务 / 事件

| 触点 | 定位检索词 | 用途 | 兼容面 / 取值优先级 | 升级核对点 |
|---|---|---|---|---|
| 连接句柄 | `apiRef`、`ctx.connection.api`（apply 内初始化） | ≤0.1.1 聚合 API（`sessions.models`）；0.1.2 连接 handle 无 `.api` → null | 仅作旧版回退 | `.api` 是否回归/改名 |
| 类型化 Remote 命名空间 | `remoteSessionRef`、`ctx.get("remote.session")`、`ctx.inject(["remote.session"], …)`（apply） | 0.1.2 typed remote `session` 命名空间 | 新版探测；老版本无此服务 → inject 永不回调 | 服务 key `remote.session` 是否变化 |
| 语言服务 | `ctx.locale.register / bind / getLocale`、`ctx.on("locale/change")` | 中英字典绑定与切换 | 两版通用 | 方法签名 |
| 主题服务（可选） | `ctx.get("theme")`、`ctx.on("theme/change")`、`themeServiceRef` | 深色主题感知（图表/色板）；缺失走亮度兜底 | 能力存在即用 | 服务名/getTheme 形状 |
| Fiber 生命周期 | `ctx.effect` | 注册槽/监听按插件卸载自动回收 | 通用 | — |

## C. 槽（Slots）注册与渲染契约

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 头部右侧槽 | `slots.inject("conversation.session.header.utilities"` | 徽标入口（id `token-monitor`, order **-99**） | 两版槽名相同。**排序契约**：列表槽按 `order` 升序**稳定排序**（`dsh-client-ui-renderer` 的 `sort((a,b) => a.order - b.order)`），**同值按注册先后**——官方 `open-in-app`（文件夹按钮）也是 `-10`，同值会随插件激活/热替换顺序左右乱跳，故取明显更小的 `-99` 钉在最左 | 槽 key / order 语义、是否有官方组件占用更小 order |
| 会话条目注入 sessionId | register 内 `inject: function (sessionId)` | 0.1.2 会话槽条目标准取 sessionId 的方式（官方同款）；0.1.1 渲染器忽略该字段则 props 照旧 | 0.1.2 必需 | inject 参数契约 |
| 用量页签槽 | `conversation.view`（id `token-monitor-usage`, order 20, label 函数） | 主区“用量”页签 | 两版通用（官方按 slots.entries 建 tab） | 槽 key / tab 渲染方式 |
| 设置页槽 | `settings.section`（id `token-monitor`, order 25） | DSH 设置面板内嵌 Token Monitor 设置页 | 两版通用 | 槽 key |
| 会话渲染 props | `props.useProjection` / `props.useSessions`（TokenMonitorEntry 顶部） | 会话条目 kit 提供的框架 hook | useProjection：两版会话条目 kit 均有；useSessions：新版回退通道 | hook 注入面变化 |
| 会话标准 hook | `useProjection("tokenUsage")`、`useProjection("title")`（TokenMonitorEntry） | 当前会话投影读取 | 0.1.2 由 ui-session 的 `projection` keyed hook + sessionProjections 提供（官方 chat 视图同样用法） | 投影 hook 名 / 值形态 |
| 当前模型槽行为（头像模型选择器同源读取） | 无直接槽调用 | — | 官方 `/model` 走同一 `modelSelection` 投影 | 随 B/D 表核对 |

## D. 会话模型 / 会话列表取值（双通道）

| 触点 | 定位检索词 | 用途 | 兼容面 / 取值优先级 | 升级核对点 |
|---|---|---|---|---|
| 当前会话模型 | `resolveCurrentModel(sessionId, cb)`（client.js） | 徽标/卡片当前 provider·model | **新版优先**：`remote.session.control()` 流 baseline 帧 → `projections[sessionId].values.modelSelection.next`（= pending ?? lastUsed，与官方 model-selection 同口径），无选择时 `remote.session.modelCatalog().default`；新版不可用/无结果/异常/10s 超时 → **回退旧版** `connection.api.sessions.models().result.value.current`；都没有 → null | control 流帧结构（baseline/projections/modelSelection/view 形态）、modelCatalog 返回、旧 RPC 是否仍在 |
| 当前会话标题 | TokenMonitorEntry 顶部 `titleProj` / `sessionTitle` | 弹层只读标题行 | **新版优先**：`useProjection("title")`（会话投影，string/null）；新版无该投影 → 回退 `useSessions` 会话列表标题 → 会话 id | title 投影 key/值；useSessions 快照形状（`ids/byId/displayTitle`） |
| 本会话累计用量 | `useProjection("tokenUsage")` → UsageSection | 弹层四桶瓦片 | 两版同一投影机制，无分支 | tokenUsage 投影注册与字段（uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens） |
| provider 路由 id → 抓取 id | `PROVIDER_ALIASES`（client.js 顶部，`"deepseek-official": "deepseek"`） | 模型 provider 名 → overview provider id | DSH 路由 id 语义（当前 deepseek 官方路由名为 deepseek-official） | llm provider 路由命名变化 |

## E. 官方 UI DOM / CSS 依赖（脆弱点）

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 页签切换 hack | `button[role="tab"]` + 文本匹配 `t("usage.tab")` 后 `.click()`（`openUsageDetail`） | 弹层“用量详情”→ 切到用量页签（官方无外部 setView API） | 依赖官方页签 DOM 结构/文案；0.1.2 实测可用 | tab 的 role/文案/结构变化 |
| 设计令牌 | `var(--dsw-alias-*)`、`var(--dsw-specific-menu)` 等（全文件样式） | 外观随 DSH 主题 | 官方 CSS 变量 | 令牌名增减 |
| 深色兜底 | `isDark()` 读 body 背景亮度 | theme 服务缺失时判深色 | 自家兜底 | — |

## F. 服务端 Host 服务

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| Web 路由注册 | `ctx.webServer.register({ kind: "exact", path, handler })`（lib/index.js 多处 + `ROUTES` 数组） | 全部 `/token-monitor/*` 接口（overview / usage / config / import-export / version / upgrade / echarts 静态） | 0.1.5 实测正常。**宿主只按 pathname 分发，不做 Host / Origin 校验，也没有 web token**——插件自行校验（见下一行） | register 契约、是否新增认证基座 |
| LAN 信任名单 | `ctx.get("webRuntime").trustedHosts`（lib/index.js 的 `pluginTrustedHosts`） | 路由来源校验：允许的 Host = loopback ∪ trustedHosts；非只读方法再校验 Origin。老版本无此服务且绑 0.0.0.0 时降级为"只信 IP 字面量" | 0.1.5 由 `@deepseek-ai/dsh-web-app`（web-runtime 行）`provide("webRuntime", { lanAddresses, trustedHosts })`；仅 LAN 模式（`--host 0.0.0.0`）下非空 | 服务名/字段；宿主是否改为自己校验 |
| LLM 提供方列表 | `ctx.get("llm").listProviders()`（overview()） | 徽标/弹层“用户配置并激活的提供方”列表 | 0.1.2 实测正常 | 服务名/方法/返回值（id 路由名） |
| 凭证解析 | `ctx.get("credentials").resolve(ref)`（lib/util/fetch-quotas.js `resolveCredential`） | 各家 API key（ref = `DEEPSEEK_API_KEY` 等） | 0.1.2 文件式 `.credentials.yaml` 实测可读；0.1.1 兼容 | resolve 签名、ref 命名、托管文件结构 |

## G. DSH 数据 / 文件面

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| DSH 家目录 | `dshHome = $DSH_HOME \|\| ~/.dsh`（index.js、store.js） | 定位会话日志/配置/凭证 | 通用 | 路径约定 |
| 会话日志目录/文件 | 会话目录 `~/.dsh/sessions/<project>/<sessionDir>/` 下的日志；规范命名 `session.jsonl.zstd`（版本 0）或 `session.vN.jsonl.zstd`（N≥1，当前写 **v3**）（fold.js `chooseGenerationLog` / `parseGeneration`） | 用量折叠数据源（读取游标 + 内容键幂等） | **取代际（版本号）最大者**，与官方 `resolveGenerationInDirectory` 同规则；代码里不写死版本号。0.1.5 起 DSH 引入日志版本，旧版日志仍为 v0 | 命名契约（官方 `parseSessionFormatLogFilename`）、当前写入版本 `SESSION_FORMAT_VERSION`、压缩后缀 |
| 日志版本与迁移语义 | `SESSION_FORMAT_VERSION = 3`（`dsh-session-format`）、`resolveGenerationInDirectory` / `publishStoredMigration`（`dsh-session-persistence-jsonl`） | 解释"为什么同一个会话会有多个日志文件" | **按需迁移**：打开哪个会话才迁移哪个（不是升级时批量转）；迁移把整段历史**重新编码**进新版本文件（内容保真、`seq` 重编号、打包行展开），旧文件保留不删；迁移期间写 `session.migration.<token>.tmp` 再改名（临时名不是规范名，天然不会被误读） | 版本号常量、是否改为删除旧文件、临时命名规则 |
| 会话日志事件行格式 | fold.js 内 `switch (event.type)`：`request/context`（低频 route 游标）、`step/start`、`assistant/chunk`（**仅 v0**）、`session/title`、`assistant/message{usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}, message:{source:{provider,model}}, stream:[{time,chunk}]}`；行含 `type/seq/time/data` | 折叠 provider/model/四桶/首 token 时延 | 消息自带 `message.source` 为真源（曾误记 opencode-go 教训）。**v3 起 chunk 流并入 `assistant/message.data.stream`**（不再有 `assistant/chunk` 事件）→ TTFT 取 `stream[0].time`；`seq` 在 v3 内为行号。**事件面单向向前**：新版新增事件若不标 `ignorable`（如 0.1.2 的 `model/selection`），旧版会整会话拒读（`resume failed … SessionFormatUnsupportedError`），会话数据不可跨版本回退 | 事件 type/字段变化、usage 口径、source 语义、stream 结构、新增事件是否带 `ignorable` |
| 插件自管配置 | `~/.dsh/storages/token-monitor/config.json`（config 路由） | 轮询/供应商 URL 等配置 | 两版通用 | storages 目录约定 |
| profile 依赖清单 | `~/.dsh/profiles/web/package.json`（upgrade 路由读取） | 判定安装通道（link/github/npm） | 通用 | 目录/字段 |
| 凭证托管文件 | `~/.dsh/.credentials.yaml`（fetch-quotas 注释） | key 来源说明（`refs:` / `records:` 结构） | 0.1.2 重写含 records 但 refs 仍被 resolve 使用（实测 key 完整） | 文件结构解析方属官方，只读 |

## H. DSH CLI

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 插件自升级 | `runDshPlugin`（`lib/util/market-upgrade.js`）：**异步** `spawn(node, [argv[1], "plugin", "--profile", <p>, "update", <name>@<ver>])`，Windows 上经 `cmd.exe` 包 `.cmd` | 设置页“升级”按钮 | 通用。**必须异步**：插件与 GUI 同进程，`spawnSync` 会把事件循环钉住（最长 5 分钟超时）；路由另有单飞锁（进行中返回 `code:'busy'`）。环境需补 PATH / `npm_config_*` 代理 / `CI=true` | CLI 子命令/参数、profile 定位方式 |

---

## 升级后建议的定向排查顺序

1. `resolveCurrentModel` → `remote.session.control()` 帧结构与 `modelSelection` 投影（D 表第一行；上轮 0.1.2 故障即在此：`api.sessions.models` 被移除）。
2. `useProjection("tokenUsage"/"title")` 投影注册与字段（D 表；0.1.2 官方 chat 仍用 tokenUsage → 优先以官方源码为准）。
3. 会话槽 `inject(sessionId)` 与槽名（C 表）。
4. 官方 DOM/CSS 脆弱点（E 表：tab hack、`--dsw-alias-*`）。
5. 服务端 `webServer / llm.listProviders / credentials.resolve`（F 表；0.1.2 已实测）。
6. 会话日志**版本与命名**（G 表）：命名契约、当前写入版本、事件结构（v3 起 chunk 流并入 message）。版本变化时插件应自动跟随（取代际最大）；行结构真变了会由健康统计告警（来源卡提示），需据此适配并重折叠。
7. `dsh.client.inject`、`cordis.patch.yml` 声明（A 表）。
8. **跨版本回退**（实测踩坑）：0.1.2 写过的会话在 0.1.1 上 `resume failed`（0.1.2 新增 `model/selection` 等事件未标 `ignorable`，旧版整会话拒读）。插件对旧版只做接口级兼容，**数据不可跨版本回退**；切回旧版必须连同会话数据一起回退（备份/移出新版期间新建或续写的会话）。
