# dsh-token-monitor × DSH 官方接口触点清单

> 用途：本插件与 DSH（deepseek-harness）官方运行时交互的**全部触点**。
> DSH 升级后做兼容排查时，按本文档逐项“定向核对”，不需要再全量扫源码。
> 定位一律用【检索词】（函数名 / 常量 / 槽名 / 事件名）而非行号——行号随改动漂移。
>
> 兼容策略约定：凡存在新旧两代调用的点，一律 **新版优先，新版不可用（未升级）再回退旧版**；
> 两代共用同一机制的（如 useProjection 会话投影）无分支。
> 当前基线：实测环境 **桌面版 0.2.0-rc.2、web 端 CLI 0.2.0-rc.1**（同属 0.2 线，两端 rc 号可以不同步）——本轮已就 A/B/C/D/E/F/G 全表逐项复核通过：槽名 ×3、`inject` 四服务、`sessions`/`remote` 双路、`modelSelection` 投影、服务端四服务、主题令牌（含 `--dsw-menu-backdrop-filter`）、bundle 协议、会话日志 `SESSION_FORMAT_VERSION = 4` 均未变；新增触点见下表内 **0.2** 标注。上一基线 0.1.7-rc.2、0.1.7-alpha.2、0.1.5-rc.1、0.1.2-rc.1（"新版/旧版"的分界仍以 0.1.2 计）。≤0.1.1 分支为按旧契约写的回退路径（当前环境无法回归）。
> 注：rc.1 → rc.2（桌面）复核结论——17 项触点字样全命中；4 个客户端文件哈希有差异，但**我们依赖的内容逐项完好**（`remote` 命名空间的 `$mount`/`session`/`modelCatalog`/`account`、`dshDesktop` 渲染闸门、主题令牌取值、`transcriptView` 仍接受 `standard`）；引用到的 28 个 `--dsw-*` 令牌**无一在 rc.2 新缺失**。rc.2 官方变更里与本插件相关的两条见 **H 表**（pi-ai 0.87.1 模型目录增删、桌面内置 dsh 命令）。
> 注：核对 `modelSelection` 这类投影时——键名是**数据帧携带**的运行时字符串，客户端侧源码里搜不到字面量不代表缺失（rc.2 的 client.js 就搜不到，实测正常），必须以运行实测为准。
> 注：0.2 起 `@deepseek-ai/dsh-desktop-runtime` **不再单独发布**（桌面端包结构变化）；本插件未直接依赖它，无需处理。

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
| **DeepSeek 账号渠道路由**（0.2 复核） | `dsh-llm-deepseek-account`（`const PROVIDER = "deepseek-account"`）、`registerDeepSeekProvider` → `ctx.llm.registerAdapter` | 桌面版"账号登录"渠道；它的余额卡片与原生充值入口 | **路由无条件注册**：`dsh-llm-deepseek-account` 在 `dsh-base/cordis.patch.yml` 里无任何条件，`registerAdapter` 也无条件 → **`llm.listProviders()` 在任何宿主（含纯 web）都含 `deepseek-account`**，官方模型选择器因此在 web 端也列它（未登录时 `discoverModels` 捕获 `ACCOUNT_SIGN_IN_REQUIRED` 返回 `[]`，路由仍在）。本插件按"宿主是否 Electron"屏蔽 web 端展示（`lib/index.js` `isDesktopHost`） | 路由 id、是否改为条件注册、`resolveAuth` 的凭证来源 |

## E. 官方 UI DOM / CSS 依赖（脆弱点）

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 页签切换 hack | `button[role="tab"]` + 文本匹配 `t("usage.tab")` 后 `.click()`（`openUsageDetail`） | 弹层“用量详情”→ 切到用量页签（官方无外部 setView API） | 依赖官方页签 DOM 结构/文案；0.1.2 实测可用 | tab 的 role/文案/结构变化 |
| 设计令牌 | `var(--dsw-alias-*)`、`var(--dsw-specific-menu)` 等（全文件样式） | 外观随 DSH 主题 | 官方 CSS 变量 | 令牌名增减 |
| 深色兜底 | `isDark()` 三级判定：theme 服务 → `document.body.hasAttribute("data-ds-dark-theme")` → body 背景亮度 | theme 服务缺失/未就绪时判深色 | 自家兜底。**暗色标记是宿主权威做法**：设计令牌的暗色分支就写在 `body[data-ds-dark-theme]{…}`（`dsh-client-ui-theme` 注入的 CSS），比"量背景亮度"可靠（新版布局里 body 背景可能仍是浅色/透明） | 属性名是否变化 |
| 热力图格子间隙色 | `heatGapColor(el)`（优先 `cssVar("--dsw-alias-bg-base")`，兜底 `computedBg()`） | 日历底层日格子的填充/描边 = 容器底色（盖住默认浅色透出的线条） | **必须渲染期同步取**：早期实现用"挂载后 setBg 实测 + state"，切主题时 CSS 变量同帧已变而 state 晚一帧 → 间隙闪一下。改成同步读令牌后消失 | — |
| **渲染环境判别**（0.2 复核） | `"dshDesktop" in globalThis`（官方客户端插件通用写法）、`globalThis.dshPlatform` | 官方用它判断"是否在**桌面渲染进程**里"，我们用它解释 web 端的账号 UI 为何不显示 | `dshDesktop` / `dshPlatform` 都由桌面渲染进程的 preload 注入；纯浏览器里没有。官方 `dsh-client-ui-settings-account` 的 `apply()` 首行就是 `if (!("dshDesktop" in globalThis)) return;`（整个账号 UI 只在桌面渲染器注册）；同类用法另有 `dsh-client-shortcuts`（`window.dshDesktop?.shortcuts`）、`dsh-client-ui-settings-general`（`globalThis.dshDesktop` 作更新源载体）、`dsh-client-ui-chat`（桌面默认 `transcriptView: standard`）、`dsh-client-product-analytics`。**注意宿主与渲染是两个面**：桌面宿主 + 浏览器打开同一地址时，宿主是 Electron（本插件宿主侧判据为真）而渲染器没有 `dshDesktop`（官方 UI 不显示）——两者结论会相反 | 注入名是否变化；官方是否新增其它环境判据 |

## F. 服务端 Host 服务

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| Web 路由注册 | `ctx.webServer.register({ kind: "exact", path, handler })`（lib/index.js 多处 + `ROUTES` 数组） | 全部 `/token-monitor/*` 接口（overview / usage / config / import-export / version / upgrade / echarts 静态） | 0.1.5 实测正常。**宿主只按 pathname 分发，不做 Host / Origin 校验，也没有 web token**——插件自行校验（见下一行） | register 契约、是否新增认证基座 |
| LAN 信任名单 | `ctx.get("webRuntime").trustedHosts`（lib/index.js 的 `pluginTrustedHosts`） | 路由来源校验：允许的 Host = loopback ∪ trustedHosts；非只读方法再校验 Origin。老版本无此服务且绑 0.0.0.0 时降级为"只信 IP 字面量" | 0.1.5 由 `@deepseek-ai/dsh-web-app`（web-runtime 行）`provide("webRuntime", { lanAddresses, trustedHosts })`；仅 LAN 模式（`--host 0.0.0.0`）下非空 | 服务名/字段；宿主是否改为自己校验 |
| LLM 提供方列表 | `ctx.get("llm").listProviders()`（overview()） | 徽标/弹层“用户配置并激活的提供方”列表 | 0.1.2 实测正常 | 服务名/方法/返回值（id 路由名） |
| 凭证解析 | `ctx.get("credentials").resolve(ref)`（lib/util/fetch-quotas.js `resolveCredential`） | 各家 API key（ref = `DEEPSEEK_API_KEY` 等） | 0.1.2 文件式 `.credentials.yaml` 实测可读；0.1.1 兼容 | resolve 签名、ref 命名、托管文件结构 |
| **profile 权威来源**（0.2 新增依赖） | `ctx.get("profileContext")`：`name`（`"desktop"`/`"web"`）、`dir`、`packageManager?`（lib/util/market-upgrade.js `resolveOwnProfile` / `runtimeOf`） | ① 定位"本插件所在的 profile"；② 判定端类型：`packageManager` 存在 = **packaged**（打包应用，带内置运行时）/ 否则 **hosted**。两者共同决定升级通路与重启文案 | **必须优先于路径推断**：本插件以 `link:` 挂载时自身真实路径在 `profiles/` 之外，只能落到"扫描 `profiles/*`"兜底，而扫描按目录名排序 → 两端都会推成 `desktop`（web 实例会拿桌面 profile 去升级）。契约原文：`packageManager` = "Packaged applications supply their bundled runtime instead of a PATH executable."；`dsh-desktop-host` 启动 profile 时注入 `{ command: process.execPath, args: ["--expose-internals", <内置 pnpm.mjs>], env: { ELECTRON_RUN_AS_NODE: "1", … } }` | 服务名/字段（`name`/`dir`/`packageManager`）、桌面是否仍注入内置 pnpm |
| **官方插件管理服务**（0.2 新增依赖） | `ctx.get("pluginManager").installBundle(spec, options)`（lib/util/market-upgrade.js `installViaManager`） | 设置页"升级"的**首选通路**：两端通用，且以 `ctx.profileContext` 绑定**当前 profile**、包管理器由 `profileContext.packageManager` 决定（桌面用应用内置 pnpm、web 用 PATH pnpm）；自带 bundle 注册、失败回滚（`package.json`/`pnpm-lock.yaml`）、文件锁与 `application: "applied" \| "restart-required" \| "failed" \| "cancelled"` 结果 | 声明在 **`dsh-base`**（web 与桌面都挂载）。内部就是 `pnpm add <spec>` → **对已安装的包即升/降级**。**必须先不调 `inspect()`**：它对已安装直接 `refused("already-installed")`（官方 UI 因此只给"先卸载再安装"的引导，并在文案里写明"暂不支持自动更新"）——官方未在 UI 暴露升级，但服务层面可用。取不到该服务（旧版 DSH）→ 回退 H 表的 CLI 子进程。**验证状态**：源码级（`installBundle` → `runPnpm(["add", spec])`）+ 官方服务实时视图（`listBundles` 里 `dsh-token-monitor` 为 `installed:true, removable:true`、无 `readOnlyReason`，而 `dsh-base`/`dsh-web-app` 是 `management-required`）均已通过；**桌面端到端升级实测待补**（需非 link 安装） | 服务名/方法/`options`（`enabled` 默认 true、`registry`、`approvedBuilds`、`requestId`）、`application` 取值、是否新增官方升级动作 |
| **账号服务**（0.2 复核） | `ctx.get("deepseekAccount")`（服务名由 `dsh-deepseek-account` 的 `super(ctx, "deepseekAccount")` 定义；实现类由 `dsh-deepseek-account-platform` 提供） | 账号登录状态/资料/钱包；`dsh-api-account-controller` 以 `static inject = ["deepseekAccount", "agents"]` **硬注入**它 | `dsh-base` 含 `deepseek-account-platform` 与 `llm-deepseek-account`，**不含**账号控制器（后者由 `dsh-web-app` 的 bundle 声明）。硬注入意味着该服务缺失时账号控制器**整个不激活**（见文首铁律） | 服务名、实现类、注入面 |

## G. DSH 数据 / 文件面

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| DSH 家目录 | `dshHome = $DSH_HOME \|\| ~/.dsh`（index.js、store.js） | 定位会话日志/配置/凭证 | 通用 | 路径约定 |
| 会话日志目录/文件 | 会话目录 `~/.dsh/sessions/<project>/<sessionDir>/` 下的日志；规范命名 `session.jsonl.zstd`（版本 0）或 `session.vN.jsonl.zstd`（N≥1，0.1.7 当前写 **v4**）（fold.js `chooseGenerationLog` / `parseGeneration`） | 用量折叠数据源（读取游标 + 内容键幂等） | **取代际（版本号）最大者**，与官方 `resolveGenerationInDirectory` 同规则；代码里不写死版本号。0.1.5 起 DSH 引入日志版本，旧版日志仍为 v0 | 命名契约（官方 `parseSessionFormatLogFilename`）、当前写入版本 `SESSION_FORMAT_VERSION`、压缩后缀 |
| 日志版本与迁移语义 | `SESSION_FORMAT_VERSION = 4`（`dsh-session`，0.1.7；0.1.5 为 3）、`dsh-session-format-v3-to-v4`、`resolveGenerationInDirectory` / `publishStoredMigration` | 解释"为什么同一个会话会有多个日志文件" | **按需迁移**：打开哪个会话才迁移哪个（不是升级时批量转）；迁移把整段历史**重新编码**进新版本文件（内容保真、`seq` 重编号、打包行展开），旧文件保留不删；迁移期间写 `session.migration.<token>.tmp` 再改名（临时名不是规范名，天然不会被误读）。**v3→v4 的迁移不触碰计费字段**（全文无 `usage`/`inputTokens` 等 → 折叠口径不变） | 版本号常量、是否改为删除旧文件、临时命名规则 |
| 会话日志事件行格式 | fold.js 内 `switch (event.type)`：`request/context`（低频 route 游标）、`step/start`、`assistant/chunk`（**仅 v0**）、`session/title`、`assistant/message{usage:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}, message:{source:{provider,model}}, stream:[{time,chunk}]}`；行含 `type/seq/time/data` | 折叠 provider/model/四桶/首 token 时延 | 消息自带 `message.source` 为真源（曾误记 opencode-go 教训）。**v3 起 chunk 流并入 `assistant/message.data.stream`**（不再有 `assistant/chunk` 事件）→ TTFT 取 `stream[0].time`；`seq` 在 v3 内为行号。**0.1.7 新增 `assistant/attempt`**：官方只在**没有 usage** 时才写它（`live.usage === undefined ? {} : { usage }` 走 `assistant/message`，否则走 `assistant/attempt`）→ 我们只认 `assistant/message`，**不漏计也不重复计**；若将来 attempt 也带 usage 需补。**0.2 复核**：`SessionEventMap` 仍是 `'assistant/attempt': { turn; step; stream }`（**确认不带 usage** ✅），`'assistant/message': { turn; step; message; stream; usage?; interrupted? }` 未变；同接口的 `TokenUsage = { inputTokens; outputTokens; totalTokens?; cacheReadTokens?; cacheWriteTokens?; reasoningTokens? }`——**`reasoningTokens` 一直在写**（我们目前不入库，可用于区分"可见输出速度"）。**事件面单向向前**：新版新增事件若不标 `ignorable`（如 0.1.2 的 `model/selection`），旧版会整会话拒读（`resume failed … SessionFormatUnsupportedError`），会话数据不可跨版本回退 | 事件 type/字段变化、usage 口径、source 语义、stream 结构、新增事件是否带 `ignorable` |
| 插件自管配置 | `~/.dsh/storages/token-monitor/config.json`（config 路由） | 轮询/供应商 URL 等配置 | 两版通用 | storages 目录约定 |
| profile 依赖清单 | `~/.dsh/profiles/web/package.json`（upgrade 路由读取） | 判定安装通道（link/github/npm） | 通用 | 目录/字段 |
| 凭证托管文件 | `~/.dsh/.credentials.yaml`（fetch-quotas 注释） | key 来源说明（`refs:` / `records:` 结构） | 0.1.2 重写含 records 但 refs 仍被 resolve 使用（实测 key 完整） | 文件结构解析方属官方，只读 |

## H. DSH CLI

| 触点 | 定位检索词 | 用途 | 兼容面 / 备注 | 升级核对点 |
|---|---|---|---|---|
| 插件自升级（**首选：官方宿主服务**） | `installViaManager` → `ctx.get("pluginManager").installBundle(spec)`（见 F 表末行） | 设置页"升级"按钮 | **两端通用**：桌面版用它才能绕开 CLI 的 desktop-profile 闸门并用上应用内置 pnpm；web 版同样优先用它（registry 回退/文件锁/回滚/`restart-required` 判定都由官方负责，插件不必再拼 PATH 与代理环境） | 服务与 `installBundle` 是否仍在（不在则走下一行） |
| 插件自升级（**回退：CLI 子进程**；仅旧版 DSH） | `runDshPlugin`（`lib/util/market-upgrade.js`）：**异步** `spawn(node, [argv[1], "plugin", "--profile", <p>, "update", <name>@<ver>])`，Windows 上经 `cmd.exe` 包 `.cmd` | 同上，旧版无 `pluginManager` 时的通路 | 通用。**必须异步**：插件与 GUI 同进程，`spawnSync` 会把事件循环钉住（最长 5 分钟超时）；路由另有单飞锁（进行中返回 `code:'busy'`）。环境需补 PATH / `npm_config_*` 代理 / `CI=true`。**桌面端这条路走不通**：`process.argv[1]` 是 `dsh-desktop-host/lib/index.js`（不匹配 CLI 入口）→ 回退 PATH 上的独立 CLI → 被下面的独占闸门拒绝 | CLI 子命令/参数、profile 定位方式 |
| 桌面 profile 独占闸门（0.2 新增认知） | `rejectElectronProfile`（`@deepseek-ai/dsh/lib/bin.js`）：`if (profile.toLowerCase() === "desktop") program.error('error: profile "desktop" is managed exclusively by the Electron application')`，由 `runCli({ manageDesktopProfile })` 控制 | 解释"为什么桌面版不能用 `dsh plugin --profile desktop …`" | **闸门是参数化开关，不是版本差异**：独立 CLI 不传 `manageDesktopProfile` → 被拒；`dsh-desktop-host/lib/cli.js` 以 `runCli({ manageDesktopProfile: true, packageManager: … })` 调用 → 放行。rc.2 起桌面**内置 dsh 命令**即以此实现（`resources/runtime/cli/bin/dsh.cmd` → `ELECTRON_RUN_AS_NODE=1 "<应用exe>" --expose-internals "<asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" %*`，需经菜单栏 "Manage dsh command" 装到 PATH）。实测同一台机器：`dsh plugin --profile desktop list`（npm 全局 rc.1）❌ 被拒；内置 `dsh.cmd plugin --profile desktop list` ✅ 输出 `dsh-profile-desktop (PRIVATE)` | 闸门是否移除/改名、`manageDesktopProfile` 参数、内置 shim 路径 |
| pi-ai 模型目录（0.2 变更） | `@earendil-works/pi-ai/dist/providers/data/*.json`（定价兜底；`findDataDir()` 定位） | DeepSeek/Kimi 等模型的刊例价兜底 | **rc.2 升到 pi-ai 0.87.1 且有模型增删**：`deepseek.json` 3→2（移除 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`，新增 `deepseek-flash`）、`moonshotai(-cn).json` 10→4（移除 6 个 `kimi-k2*`）、`kimi-coding.json` 4 未变。**对本插件定价无影响**：DeepSeek 价来自我们自己的 `model_prices`（内置表优先于 pi-ai），被移除的模型也无法再被选用；历史行费用已固化 | 目录路径/文件名、模型键增删、是否影响 `model_prices` 兜底命中 |

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
