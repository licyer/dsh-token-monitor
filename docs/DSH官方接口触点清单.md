# dsh-token-monitor × DSH 官方接口触点清单

> 用途：本插件与 DSH（deepseek-harness）官方运行时交互的**全部触点**。
> DSH 升级后做兼容排查时，按本文档逐项“定向核对”，不需要再全量扫源码。
> 定位一律用【检索词】（函数名 / 常量 / 槽名 / 事件名）而非行号——行号随改动漂移。
>
> 兼容策略约定：凡存在新旧两代调用的点，一律 **新版优先，新版不可用（未升级）再回退旧版**；
> 两代共用同一机制的（如 useProjection 会话投影）无分支。
> 当前基线：实测环境 DSH **0.1.7-alpha.2**；上一基线 0.1.5-rc.1，再上一基线 0.1.2-rc.1（"新版/旧版"的分界仍以 0.1.2 计）。≤0.1.1 分支为按旧契约写的回退路径（当前环境无法回归）。

---

## ⚠️ 头号铁律：`inject` / `dsh.client.inject` 是**硬闸门**

两者都**没有超时、不会跳过**——声明了某个不存在的东西，插件就是**永远不启动**，代码里写得再完备的回退逻辑也**没机会执行**：

```js
// cordis v4：任一注入服务缺失 → epoch = INACTIVE → 执行 _unload()，apply 永不调用
_refresh() { for (const name of Object.keys(this.inject)) { if (!this._store[name]) { epoch = INACTIVE; break; } } … }
// dsh-client-modules：包级声明同理（activation gating on inject）
// dsh-cordis-client-runner：waitingFor = Object.keys(fiber.inject).filter(name => ctx.get(name) === undefined)
```

因此**跨版本插件**必须遵守：

1. `inject`（client.js）**只放各版本都提供的服务**。当前为 `["slots","connection","locale","theme"]`——这四个在 0.1.2 基线就有。0.1.7 才出现的 `sessions` / `remote` **一律不得加入**。
2. `dsh.client.inject`（package.json）**只放各版本都存在的宿主包**。当前仅 `@deepseek-ai/dsh-client-connection`；`dsh-api-remotes`、`dsh-client-ui-theme` 等 0.1.7 包名不得写入。
3. 新版能力一律用 **`ctx.get` + `ctx.inject([...], cb)` 双路探测**：前者当场取（新版已就绪时），后者等晚注册（服务注册晚于本插件时）；老版本两者都拿不到 → 保持 null → 自动回退旧通道。
4. 服务端清理**不要用 `ctx.on('dispose')`**——cordis 只 `emit` `internal/dispatch|plugin|status`，没有该事件，监听体永不执行；统一写 `ctx.effect(() => () => { …清理… })`（新旧版通用）。

---



---

## A. 客户端运行与声明契约

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 客户端模块格式 | `window.__ModuleLoader__.load`（client.js 首行） | 手写懒 CJS 模块，无需构建 | 0.1.1 / 0.1.2 通用（dsh-client-modules） | bundle 加载协议是否变化 |
| 客户端入口导出 | `exports["./client"]`（package.json） | 官方发现客户端 bundle | 两版通用 | exports 子路径是否变化 |
| 客户端平台/注入声明 | `dsh.client.platform: "web"`、`dsh.client.inject`（package.json） | 声明注入的宿主包 | **硬闸门**（见文首铁律）：只放各版本都存在的包。当前仅 `@deepseek-ai/dsh-client-connection`。**不要**因为"依赖了 theme/sessions"就加上 `dsh-client-ui-theme` / `dsh-api-remotes` / `dsh-api-session-controller`——0.1.7 才有的包名会让旧版等待永不满足。**0.1.5 起 `@deepseek-ai/dsh-client-runtime` 已不再发布，声明已移除** | 0.1.1 宿主插件清单变化时更新 |
| profile 补丁契约 | `cordis.patch.yml` + `dsh.bundle.patch`（package.json） | 把插件插入 web profile 的 cordis 根 | 两版通用 | patch insert 语法/加载机制变化 |
| 插件注入清单 | `inject = ["slots", "connection", "locale", "theme"]`（client.js 模块级） | 声明要用的 Cordis 客户端服务 | **硬闸门**：这 4 个在 0.1.2 基线即有。**0.1.7 的 `sessions` / `remote` 不得加入**（旧版无此服务 → apply 永不执行）；改用双路探测 | 服务名若改名需同步 |


## B. 客户端 Cordis 服务 / 事件

| 触点 | 定位检索词 | 用途 | 兼容面 / 取值优先级 | 升级核对点 |
|---|---|---|---|---|
| 连接句柄 | `apiRef`、`ctx.connection.api`（apply 内初始化） | ≤0.1.1 聚合 API（`sessions.models`）；0.1.2 连接 handle 无 `.api` → null | 仅作旧版回退 | `.api` 是否回归/改名 |
| 类型化 Remote 命名空间 | `ctx.remote.session.modelCatalog()`、`ctx.get("remote").session`、`remoteSessionRef`（apply 内 `probeRemote`） | **0.1.7 形态**：`remote` 是 `dsh-api-remotes` 用 `ctx.remote.$mount(...)` 挂载的命名空间，`session` 挂在其下（`remote.session` 作为扁平服务名在 0.1.7 已不可靠）；仍保留 `ctx.get("remote.session")` 与 `ctx.inject(["remote.session"], …)` 兼容 0.1.2~0.1.5 | **不得进 inject**（旧版无此服务）；`ctx.get` + `ctx.inject(["remote"], …)` 双路，老版本保持 null → 回退 `connection.api` | 命名空间名、`$mount` 贡献面、是否回归扁平服务名 |
| 会话服务 | `ctx.sessions`、`ctx.get("sessions")`、`ctx.inject(["sessions"], …)`（apply 内 `sessionsRef`） | **0.1.7**：`dsh-api-session-controller` 客户端 `provide("sessions", …)`；用于读会话投影（`binding(id).session.projections.faceOf("modelSelection")`） | **不得进 inject**；双路探测，缺失时回退旧通道 | 服务名、提供方包、`binding()` 形状 |
| 语言服务 | `ctx.locale.register / bind / getLocale`、`ctx.on("locale/change")` | 中英字典绑定与切换 | 两版通用（0.1.7 由 `dsh-client-locale` `ctx.emit("locale/change", …)`） | 方法签名 |
| 主题服务（可选） | `ctx.get("theme")` + `ctx.inject(["theme"], …)`（`bindTheme`）、`ctx.on("theme/change")`、`themeServiceRef` | 深色主题感知（图表/色板）；服务缺失走 `body[data-ds-dark-theme]` / 亮度兜底 | `theme` 在 0.1.2 基线即有 → 保留在 inject；另加 `ctx.inject` 兜底"注册晚于本插件" | 服务名/getTheme 形状 |
| Fiber 生命周期 | `ctx.effect` | 注册槽/监听/清理按插件卸载自动回收 | **通用**；**不要用 `ctx.on('dispose')`**（cordis 无此事件，永不触发） | — |


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
| 当前会话模型 | `resolveCurrentModel(sessionId, cb)`（client.js） | 徽标/卡片当前 provider·model | **0.1.7 主路**：`sessions.binding(sessionId).session.projections.faceOf("modelSelection").getSnapshot().next`（官方 `dsh-api-session-controller` 同源口径；`next` = pending ?? lastUsed）。**次选**：`remote.session.modelCatalog().default`（部署默认模型）。**旧版回退**：`remote.session.control()` 流 baseline 帧 → `projections[sessionId].values.modelSelection.next`（0.1.2~0.1.5）→ 再回退 `connection.api.sessions.models().result.value.current`（≤0.1.1）；都没有 → null | `binding/faceOf` 形状、modelSelection 快照字段、control 流帧结构、modelCatalog 返回、旧 RPC 是否仍在 |
| 当前会话标题 | TokenMonitorEntry 顶部 `titleProj` / `sessionTitle` | 弹层只读标题行 | **新版优先**：`useProjection("title")`（会话投影，string/null）；新版无该投影 → 回退 `useSessions` 会话列表标题 → 会话 id | title 投影 key/值；useSessions 快照形状（`ids/byId/displayTitle`） |
| 本会话累计用量 | `useProjection("tokenUsage")` → UsageSection | 弹层四桶瓦片 | 两版同一投影机制，无分支 | tokenUsage 投影注册与字段（uncachedInputTokens/outputTokens/cacheReadTokens/cacheWriteTokens） |
| provider 路由 id → 抓取 id | `PROVIDER_ALIASES`（client.js 顶部，`"deepseek-official": "deepseek"`） | 模型 provider 名 → overview provider id | DSH 路由 id 语义（当前 deepseek 官方路由名为 deepseek-official） | llm provider 路由命名变化 |

## E. 官方 UI DOM / CSS 依赖（脆弱点）

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 页签切换 hack | `button[role="tab"]` + 文本匹配 `t("usage.tab")` 后 `.click()`（`openUsageDetail`） | 弹层“用量详情”→ 切到用量页签（官方无外部 setView API） | 依赖官方页签 DOM 结构/文案；0.1.2 实测可用 | tab 的 role/文案/结构变化 |
| 设计令牌 | `var(--dsw-alias-*)`、`var(--dsw-specific-menu)` 等（全文件样式） | 外观随 DSH 主题 | 官方 CSS 变量 | 令牌名增减 |
| 深色兜底 | `isDark()` 三级判定：theme 服务 → `document.body.hasAttribute("data-ds-dark-theme")` → body 背景亮度 | theme 服务缺失/未就绪时判深色 | 自家兜底。**暗色标记是宿主权威做法**：设计令牌的暗色分支就写在 `body[data-ds-dark-theme]{…}`（`dsh-client-ui-theme` 注入的 CSS），比"量背景亮度"可靠（新版布局里 body 背景可能仍是浅色/透明） | 属性名是否变化 |
| 热力图格子间隙色 | `heatGapColor(el)`（优先 `cssVar("--dsw-alias-bg-base")`，兜底 `computedBg()`） | 日历底层日格子的填充/描边 = 容器底色（盖住默认浅色透出的线条） | **必须渲染期同步取**：早期实现用"挂载后 setBg 实测 + state"，切主题时 CSS 变量同帧已变而 state 晚一帧 → 间隙闪一下。改成同步读令牌后消失 | — |

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
| 会话日志目录/文件 | 会话目录 `~/.dsh/sessions/<project>/<sessionDir>/` 下的日志；规范命名 `session.jsonl.zstd`（版本 0）或 `session.vN.jsonl.zstd`（N≥1，0.1.7 当前写 **v4**）（fold.js `chooseGenerationLog` / `parseGeneration`） | 用量折叠数据源（读取游标 + 内容键幂等） | **取代际（版本号）最大者**，与官方 `resolveGenerationInDirectory` 同规则；代码里不写死版本号。0.1.5 起 DSH 引入日志版本，旧版日志仍为 v0 | 命名契约（官方 `parseSessionFormatLogFilename`）、当前写入版本 `SESSION_FORMAT_VERSION`、压缩后缀 |
| 日志版本与迁移语义 | `SESSION_FORMAT_VERSION = 4`（`dsh-session`，0.1.7；0.1.5 为 3）、`dsh-session-format-v3-to-v4`、`resolveGenerationInDirectory` / `publishStoredMigration` | 解释"为什么同一个会话会有多个日志文件" | **按需迁移**：打开哪个会话才迁移哪个（不是升级时批量转）；迁移把整段历史**重新编码**进新版本文件（内容保真、`seq` 重编号、打包行展开），旧文件保留不删；迁移期间写 `session.migration.<token>.tmp` 再改名（临时名不是规范名，天然不会被误读）。**v3→v4 的迁移不触碰计费字段**（全文无 `usage`/`inputTokens` 等 → 折叠口径不变） | 版本号常量、是否改为删除旧文件、临时命名规则 |
| 会话日志事件行格式 | fold.js 内 `switch (event.type)`：`request/context`（低频 route 游标）、`step/start`、`assistant/chunk`（**仅 v0**）、`session/title`、`assistant/message{usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}, message:{source:{provider,model}}, stream:[{time,chunk}]}`；行含 `type/seq/time/data` | 折叠 provider/model/四桶/首 token 时延 | 消息自带 `message.source` 为真源（曾误记 opencode-go 教训）。**v3 起 chunk 流并入 `assistant/message.data.stream`**（不再有 `assistant/chunk` 事件）→ TTFT 取 `stream[0].time`；`seq` 在 v3 内为行号。**0.1.7 新增 `assistant/attempt`**：官方只在**没有 usage** 时才写它（`live.usage === undefined ? {} : { usage }` 走 `assistant/message`，否则走 `assistant/attempt`）→ 我们只认 `assistant/message`，**不漏计也不重复计**；若将来 attempt 也带 usage 需补。**事件面单向向前**：新版新增事件若不标 `ignorable`（如 0.1.2 的 `model/selection`），旧版会整会话拒读（`resume failed … SessionFormatUnsupportedError`），会话数据不可跨版本回退 | 事件 type/字段变化、usage 口径、source 语义、stream 结构、新增事件是否带 `ignorable` |
| 插件自管配置 | `~/.dsh/storages/token-monitor/config.json`（config 路由） | 轮询/供应商 URL 等配置 | 两版通用 | storages 目录约定 |
| profile 依赖清单 | `~/.dsh/profiles/web/package.json`（upgrade 路由读取） | 判定安装通道（link/github/npm） | 通用 | 目录/字段 |
| 凭证托管文件 | `~/.dsh/.credentials.yaml`（fetch-quotas 注释） | key 来源说明（`refs:` / `records:` 结构） | 0.1.2 重写含 records 但 refs 仍被 resolve 使用（实测 key 完整） | 文件结构解析方属官方，只读 |

## H. DSH CLI

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 插件自升级 | `runDshPlugin`（`lib/util/market-upgrade.js`）：**异步** `spawn(node, [argv[1], "plugin", "--profile", <p>, "update", <name>@<ver>])`，Windows 上经 `cmd.exe` 包 `.cmd` | 设置页“升级”按钮 | 通用。**必须异步**：插件与 GUI 同进程，`spawnSync` 会把事件循环钉住（最长 5 分钟超时）；路由另有单飞锁（进行中返回 `code:'busy'`）。环境需补 PATH / `npm_config_*` 代理 / `CI=true` | CLI 子命令/参数、profile 定位方式 |

---

## 升级后建议的定向排查顺序

1. **先看守则（文首铁律）**：`inject` / `dsh.client.inject` 里有没有混进新版才有的服务/包——这是"插件整个不启动"的唯一原因，优先排除。
2. `resolveCurrentModel` → 0.1.7 的 `sessions.binding(id).session.projections.faceOf("modelSelection")` 与 `remote.session.modelCatalog()`（D 表第一行；0.1.2 故障在 `api.sessions.models` 被移除，0.1.5→0.1.7 故障在 `remote.session.control()` 通道 → 现为三段回退）。
3. `ctx.remote` / `ctx.sessions` 双路探测是否仍能取到（B 表；`remote` 是命名空间、`sessions` 由 `dsh-api-session-controller` 提供）。
4. `useProjection("tokenUsage"/"title")` 投影注册与字段（D 表；以官方源码为准）。
5. 会话槽 `inject(sessionId)` 与槽名（C 表）。
6. 官方 DOM/CSS 脆弱点（E 表：tab hack、`--dsw-alias-*`、`body[data-ds-dark-theme]`）。
7. 服务端 `webServer / webRuntime.trustedHosts / llm.listProviders / credentials.resolve`（F 表）。
8. 会话日志**版本与命名**（G 表）：当前写 **v4**；命名契约、事件结构（v3 起 chunk 流并入 message，0.1.7 新增 `assistant/attempt` 但不带 usage）。版本变化时插件自动跟随（取代际最大）；行结构真变了会由健康统计告警（来源卡提示）。
9. `cordis.patch.yml` 声明（A 表）。
10. **跨版本回退**（实测踩坑）：0.1.2 写过的会话在 0.1.1 上 `resume failed`（0.1.2 新增 `model/selection` 等事件未标 `ignorable`，旧版整会话拒读）。插件对旧版只做接口级兼容，**数据不可跨版本回退**；切回旧版必须连同会话数据一起回退（备份/移出新版期间新建或续写的会话）。
