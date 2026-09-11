/**
 * dsh-token-monitor — 客户端。
 *
 * 手写 __ModuleLoader__ 懒 CJS 格式（与 dsh 内置客户端插件的产物一致），
 * 因此无需任何构建步骤：编辑本文件后 dsh-client-hmr 的轮询会发现内容
 * 变化并热替换这个插件。
 *
 * 行为：向会话头部右侧的 conversation.session.header.utilities 列表槽注册
 * 一个余量监控组件。徽标显示当前会话所用模型对应供应商的关键余量指标；
 * 点击弹出详情层：当前供应商卡片、本会话 token 用量（useProjection 投影）、
 * 以及“全部提供方监控”折叠区（Host 路由返回的所有供应商）。
 */
window.__ModuleLoader__.load({
	id: "dsh-token-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var OVERVIEW_URL = "/token-monitor/overview";
		var POLL_MS = 60; // 默认轮询周期（秒）

		/**
		 * DSH 路由 provider id（session.models current.provider / request/context）→
		 * 本插件 overview provider id 的别名表。实测 DeepSeek 路由名为
		 * deepseek-official（2026-08），Kimi 为 kimi-coding（与插件 id 恰好一致）。
		 */
		var PROVIDER_ALIASES = {
			"deepseek-official": "deepseek",
		};

		/** 调试开关：true = 详情弹层强制常开（调样式用），调完改回 false。 */
		var PIN_OPEN = false;

		/** apply 闭包里捕获的连接 API 句柄（connection 由 inject 保证已就绪；≤0.1.1 有 .api）。 */
		var apiRef = { current: null };
		/**
		 * DSH 0.1.2+ 的类型化 Remote 命名空间服务句柄（remote.session）。
		 * apply 时经 ctx.inject 动态探测：老版本没有该服务，注入永不回调，
		 * 保持 null 即可（不影响老版本 legacy 通道）。
		 */
		var remoteSessionRef = { current: null };
		/** DSH 主题服务句柄（dsh-client-ui-theme，ctx.get 可选获取；无则走亮度兜底）。 */
		var themeServiceRef = { current: null };

		/** 当前是否为深色外观：theme 服务优先（已解析 system 偏好），
		 *  服务缺失时读 body 计算背景的相对亮度（<0.5 判深色）。 */
		function isDark() {
			var ts = themeServiceRef.current;
			if (ts) {
				try {
					var snap = ts.getTheme();
					if (snap && snap.active && snap.active.colorScheme) return snap.active.colorScheme === "dark";
				} catch (_e) { /* 落到亮度兜底 */ }
			}
			try {
				var bg = window.getComputedStyle(document.body).backgroundColor;
				var m = bg.match(/[\d.]+/g);
				if (m && m.length >= 3) {
					return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 < 0.5;
				}
			} catch (_e2) { /* 忽略 */ }
			return false;
		}

		var inject = ["slots", "connection", "locale"];

		/* ------------------------------ 语言（方案 B） ------------------------------ */
		/**
		 * 跟随 DSH 设置的语言（zh/en）。模块级 t + LANG：apply 时用 ctx.locale 绑定
		 * 命名空间字典并监听 locale/change 刷新引用；框架在语言切换时会自动重渲染
		 * 所有 slot 出口，组件读到的是新 t/LANG。t 未绑定（兜底）时返回 key 原文。
		 */
		var NS = "token-monitor";
		var t = function (key) { return key; };
		var LANG = "zh";

		/** zh/en 字典（命名空间 token-monitor）。key 按区块组织，英文缺失回退中文。 */
		var DICT = {
			zh: {
				// —— 单位 / 格式化 ——
				"unit.trillion": " 万亿",
				"unit.hundredMillion": " 亿",
				"unit.tenThousand": " 万",
				"unit.second": " 秒",
				"countdown.refreshing": "正在刷新…",
				// —— 徽标 / 弹层 ——
				"entry.quotaMonitor": "余量监控",
				"entry.modelQuota": "{model} · 余量",
				"entry.title": "Token 余量监控",
				"entry.allProviders": "全部提供方（{n}）",
				"entry.updatedAt": "▸ 更新于 {time}",
				"entry.fetchFailed": "拉取失败",
				"entry.refreshing": "刷新中…",
				"entry.refresh": "刷新",
				"entry.syncing": "同步中…",
				"entry.sync": "同步",
				"entry.syncRetry": "重试",
				"entry.syncDone": "已同步 {n} 条",
				"entry.syncFailed": "同步失败",
				"entry.syncAutoFailed": "自动同步失败，点击重试",
				"entry.syncSkipped": " · 未知应用跳过 {n} 条",
				"entry.syncCloseIn": "{n}s 后关闭",
				"entry.syncDetected": "检测到 {name} 有 {n} 条请求记录可同步",
				"entry.currentSession": "当前会话（{title}）",
				"entry.openUsage": "在主区打开该会话的用量统计",
				"entry.usageDetail": "用量详情",
				"entry.openSite": "打开官网（充值 / 续费）",
				"entry.topUp": "充值",
				"entry.renew": "续费",
				"entry.unsupported": "插件未适配，敬请期待",
				// —— 供应商卡片 / 会话用量 ——
				"card.currentModel": "当前模型",
				"card.routeUnmonitored": "当前路由 {p}/{m} 未配置监控",
				"card.modelNotIdentified": "尚未识别当前模型",
				"card.queryFailed": "查询失败",
				"card.noApiKey": "未配置 API Key",
				"card.noSessionData": "该会话暂无用量数据",
				"card.noProviderData": "暂无供应商数据",
				"card.remaining": "{label} 余 ",
				// —— token 构成瓦片 ——
				"tile.input": "新增输入",
				"tile.output": "输出",
				"tile.cacheHit": "缓存命中",
				"tile.cacheWrite": "缓存创建",
				"tile.total": "总消耗",
				"tile.hitRate": "缓存命中率",
				// —— 用量页通用 ——
				"usage.tab": "用量",
				"usage.loading": "加载中…",
				"usage.loadFailed": "加载失败",
				"usage.retry": "重试",
				"usage.refreshing": "刷新中…",
				"usage.refresh": "刷新",
				"usage.noWindowData": "窗口内暂无数据",
				"usage.noRecords": "暂无记录",
				"usage.totalRecords": "共 {n} 条记录",
				"usage.windowToday": "当天",
				"usage.windowYesterday": "昨天",
				"usage.windowAll": "全部",
				"usage.windowDays": "{d}天",
				// —— 统计卡 ——
				"stat.totalTokens": "总消耗 Tokens",
				"stat.requests": "请求次数",
				"stat.cost": "预估费用",
				"stat.avgTtft": "平均 TTFT",
				"stat.input": "新增输入",
				"stat.cacheHit": "缓存命中",
				"stat.output": "输出",
				"stat.hitRate": "缓存命中率",
				// —— 趋势图 ——
				"trend.title": "使用趋势",
				"trend.note": "（实时增量 · 受筛选条件影响 · 缓存命中与新增输入/输出量级差过大时，后者在图中几乎不可见）",
				"trend.series.input": "新增输入",
				"trend.series.cacheRead": "缓存命中",
				"trend.series.output": "输出",
				"trend.series.cost": "预估费用",
				"trend.tooltipTotal": "总消耗",
				"bars.tooltipTotal": "累计",
				"trend.series.requests": "请求次数",
				"trend.series.ttft": "平均TTFT",
				// —— 供应商统计 ——
				"prov.title": "供应商统计",
				"prov.note": "（历史全量 · 不受筛选条件影响）",
				"prov.times": " 次",
				// —— 热力 ——
				"heat.title": "消耗热力",
				"heat.note": "（近一年 · 不受筛选条件影响 · 悬浮显示请求次数+消耗token）",
				"heat.low": "少",
				"heat.high": "多",
				"heat.day0": "周日",
				"heat.day1": "周一",
				"heat.day2": "周二",
				"heat.day3": "周三",
				"heat.day4": "周四",
				"heat.day5": "周五",
				"heat.day6": "周六",
				// —— 请求记录 ——
				"rec.title": "请求记录",
				"rec.note": "（历史全量 · 不受筛选条件影响）",
				"rec.col.time": "时间",
				"rec.col.session": "会话",
				"rec.col.model": "模型",
				"rec.col.input": "新增输入",
				"rec.col.output": "输出",
				"rec.col.cacheRead": "缓存读",
				"rec.col.cost": "预估费用",
				"rec.col.ttft": "平均TTFT",
				"rec.col.client": "客户端",
				"rec.col.provider": "提供方",
				"rec.col.source": "来源",
				"rec.sourceDsh": "DSH 日志",
				"rec.pagePlaceholder": "页码",
				"rec.perPage": "{n} 条/页",
				"rec.perPagePlaceholder": "条/页",
				"rec.go": "跳转",
				// —— 排行 ——
				"rank.title": "使用排行",
				"rank.note": "（历史全量 · 不受筛选条件影响 · 默认按照模型排行）",
				"rank.col.model": "模型",
				"rank.col.provider": "供应商",
				"rank.col.client": "客户端",
				"rank.col.input": "新增输入",
				"rank.col.output": "输出",
				"rank.col.cacheRead": "缓存读",
				"rank.col.ttft": "平均TTFT",
				"rank.cost": "预估费用",
				"rank.noData": "暂无数据",
				"rank.combo.models": "模型",
				"rank.combo.providers": "供应商",
				"rank.combo.clients": "客户端",
				"rank.totalTokens": "总消耗Tokens",
				"rank.requests": "请求次数",
				"rank.totalRows": "共 {n} 项",
				// —— 筛选 ——
				"filter.client": "客户端",
				"filter.provider": "供应商",
				"filter.model": "模型",
				"filter.all": "全部",
				// —— 数据来源 ——
				"src.title": "数据来源",
				"src.note": "（DSH 记录支持导入/导出跨设备同步；CC 记录支持自动导入与 SQL 文件导入；数据同步 5 分钟一次）",
				"src.foldWarn.title": "检测到日志格式变化：",
				"src.foldWarn.hint": "通常由 DSH 版本更新引起，插件会在后续版本适配；已记录的数据不受影响，可以继续使用。",
				"src.foldWarn.noHeader": "{n} 个会话日志读取失败（日志格式可能已变化）",
				"src.foldWarn.unreadable": "{n} 个日志文件有损坏帧或超大帧",
				"src.foldWarn.unrecognized": "{n} 个日志文件名无法识别（DSH 可能改了命名规则）",
				"src.foldWarn.emptyUsage": "{n} 个会话有事件但未产出用量（记录格式可能已变化）",
				"src.col.source": "来源",
				"src.col.desc": "简要说明",
				"src.col.dir": "目录",
				"src.col.lastUpdate": "最近更新",
				"src.lastUpdateTip": "源头数据自身最新一条的时刻",
				"src.col.lastSync": "最近同步",
				"src.syncRows": "{n} 条",
				"src.col.action": "操作",
				"src.dshLogs": "DSH 会话日志",
				"src.dshDesc": "本工具的会话日志（自动增量采集，可手动导入/导出跨设备同步）",
				"src.ccDesc": "CC 汇总的其他客户端请求记录（手动导入，已排除 DSH 数据）",
				"src.openDir": "打开目录",
				"src.export": "导出",
				"src.import": "导入",
				"src.exporting": "正在导出 DSH 用量…",
				"src.exported": "已导出 {n} 条明细 · {m} 天聚合",
				"src.exportFailed": "导出失败",
				"src.importingDsh": "正在导入 DSH 用量…",
				"src.dshImported": "已导入 {n} 条（重复跳过 {s} 条）",
				"src.importDshFailed": "导入失败",
				"src.delete": "删除",
				"src.importing": "正在导入 CC 使用记录…",
				"src.deleting": "正在删除 CC 数据…",
				"src.confirmDelete": "确认删除全部 CC 导入的数据？此操作不可撤销。",
				"src.confirm": "确认",
				"src.cancel": "取消",
				"src.imported": "已导入 {n} 条",
				"src.importSkipped": " · 未知应用跳过 {n} 条",
				"src.deleted": "已删除 {n} 条 CC 数据",
				"src.deleteFailed": "删除失败",
				"src.importFailed": "导入失败",
				// —— 聚焦横幅 ——
				"focus.current": "当前会话：{title}",
				"focus.clear": "取消聚焦",
				// —— 说明文案 ——
				"note.costFormula": "预估费用 = token 消耗 × pi-ai 刊例价（单位：USD，仅供参考，非实际账单；订阅制不产生真实扣费）· 已按汇率 1 USD ≈ {rate} CNY 换算",
				"note.unpriced": " · 另有 {n} 次调用未定价（计入 token、不计入费用）",
				// —— 供应商展示名 ——
				"vendor.unknown": "未知",
				"vendor.kimi": "Kimi",
				"vendor.zhipu": "智谱（GLM）",
				"vendor.qwen": "通义（Qwen）",
				"vendor.xiaomi": "小米（Xiaomi）",
				"vendor.antling": "蚂蚁灵积（Ling）",
				// —— 图表加载 ——
				"chart.loading": "图表加载中…",
				"chart.loadFailed": "图表库加载失败（/token-monitor/echarts.min.js 不可用）",
				// —— 设置页 ——
				"settings.title": "Token Monitor",
				"settings.defaultDays": "默认时间窗",
				"settings.defaultDays.hint": "打开「用量」页时默认显示的时间范围",
				"settings.pollMs": "余量刷新间隔",
				"settings.pollMs.hint": "余量值每隔 {sec} 秒重新获取一次",
				"settings.retentionDays": "请求记录保留时间",
				"settings.retentionDays.hint": "超过此时长的请求记录会被定期清理，不影响聚合统计与总量",
				"settings.save": "保存",
				"settings.reset": "放弃修改",
				"settings.saved": "保存成功",
				"settings.saveFailed": "保存失败",
				// —— 已适配供应商 ——
				"settings.adapters.title": "已适配供应商",
				"settings.adapters.hint": "插件已适配的提供方清单（含适配与真实响应验证状态），点击展开",
				"settings.adapters.loading": "加载中…",
				"settings.adapters.colVendor": "供应商",
				"settings.adapters.colProvider": "提供方",
				"settings.adapters.colAdapted": "是否适配",
				"settings.adapters.colVerified": "是否验证",
				"settings.adapters.yes": "是",
				"settings.adapters.verified": "已验证",
				"settings.adapters.pending": "待验证",
				"settings.adapters.note": "「是否验证」仅表示开发者是否已用真实凭证验证过该提供方。",
				// —— 模型定价 ——
				"settings.pricing.title": "模型定价",
				"settings.pricing.hint": "（元 / 百万 token，表内价格优先，pi-ai 刊例价兜底）",
				"settings.pricing.loading": "加载中…",
				"settings.pricing.noData": "暂无定价",
				"settings.pricing.colAction": "操作",
				"settings.pricing.colModel": "模型",
				"settings.pricing.colMode": "定价",
				"settings.pricing.colCurrency": "币种",
				"settings.pricing.colCacheHit": "输入·命中",
				"settings.pricing.colInput": "输入·未命中",
				"settings.pricing.colOutput": "输出",
				"settings.pricing.colSince": "开始时间",
				"settings.pricing.colPeak": "高峰时段",
				"settings.pricing.colMultiplier": "高峰倍率",
				"settings.pricing.modeFixed": "固定",
				"settings.pricing.modeTime": "峰谷",
				"settings.pricing.add": "新增",
				"settings.pricing.edit": "编辑",
				"settings.pricing.save": "保存",
				"settings.pricing.cancel": "取消",
				"settings.pricing.saved": "已保存",
				"settings.pricing.saveFailed": "保存失败",
				"settings.pricing.namePlaceholder": "模型 id（如 kimi-k3）",
				"settings.version.title": "版本更新",
				"settings.version.current": "当前版本 v{v}",
				"settings.version.found": "检测到新版本 v{v}，当前版本 v{c}",
				"settings.version.downloaded": "已下载 v{v}",
				"settings.version.latest": "已是最新版本",
				"settings.version.upgrade": "升级",
				"settings.version.upgrading": "升级中…",
				"settings.version.ok": "升级成功，重启 dsh web 后生效",
				"settings.version.failed": "升级失败",
				"settings.version.channelLink": "本地挂载",
			},
			en: {
				// —— 单位 / 格式化（en 下 fmtTokens/fmtAxisTokens 直接千分位，不压缩；单位 key 仅兜底） ——
				"unit.trillion": "T",
				"unit.hundredMillion": "e8",
				"unit.tenThousand": "K",
				"unit.second": "s",
				"countdown.refreshing": "Refreshing…",
				// —— 徽标 / 弹层 ——
				"entry.quotaMonitor": "Quota Monitor",
				"entry.modelQuota": "{model} · Quota",
				"entry.title": "Token Quota Monitor",
				"entry.allProviders": "All Providers ({n})",
				"entry.updatedAt": "▸ Updated {time}",
				"entry.fetchFailed": "Fetch failed",
				"entry.refreshing": "Refreshing…",
				"entry.refresh": "Refresh",
				"entry.syncing": "Syncing…",
				"entry.sync": "Sync",
				"entry.syncRetry": "Retry",
				"entry.syncDone": "Synced {n} records",
				"entry.syncFailed": "Sync failed",
				"entry.syncAutoFailed": "Auto sync failed, click to retry",
				"entry.syncSkipped": " · {n} unknown app(s) skipped",
				"entry.syncCloseIn": "Close in {n}s",
				"entry.syncDetected": "{name} has {n} pending request records to sync",
				"entry.currentSession": "Current Session ({title})",
				"entry.openUsage": "Open usage stats for this session in main area",
				"entry.usageDetail": "Usage Details",
				"entry.openSite": "Open provider site (top-up / renew)",
				"entry.topUp": "Top Up",
				"entry.renew": "Renew",
				"entry.unsupported": "Plugin not supported yet",
				// —— 供应商卡片 / 会话用量 ——
				"card.currentModel": "Current Model",
				"card.routeUnmonitored": "Route {p}/{m} has no monitoring configured",
				"card.modelNotIdentified": "Model not identified",
				"card.queryFailed": "Query failed",
				"card.noApiKey": "API key not configured",
				"card.noSessionData": "No usage data for this session",
				"card.noProviderData": "No provider data",
				"card.remaining": "{label} left ",
				// —— token 构成瓦片 ——
				"tile.input": "New Input",
				"tile.output": "Output",
				"tile.cacheHit": "Cache Hit",
				"tile.cacheWrite": "Cache Write",
				"tile.total": "Total",
				"tile.hitRate": "Cache Hit Rate",
				// —— 用量页通用 ——
				"usage.tab": "Usage",
				"usage.loading": "Loading…",
				"usage.loadFailed": "Failed to load",
				"usage.retry": "Retry",
				"usage.refreshing": "Refreshing…",
				"usage.refresh": "Refresh",
				"usage.noWindowData": "No data in this window",
				"usage.noRecords": "No records",
				"usage.totalRecords": "{n} records total",
				"usage.windowToday": "Today",
				"usage.windowYesterday": "Yesterday",
				"usage.windowAll": "All",
				"usage.windowDays": "{d}d",
				// —— 统计卡 ——
				"stat.totalTokens": "Total Tokens",
				"stat.requests": "Requests",
				"stat.cost": "Est. Cost",
				"stat.avgTtft": "Avg TTFT",
				"stat.input": "New Input",
				"stat.cacheHit": "Cache Hit",
				"stat.output": "Output",
				"stat.hitRate": "Cache Hit Rate",
				// —— 趋势图 ——
				"trend.title": "Usage Trend",
				"trend.note": "（live increment · affected by filters · cache-hit dwarfs input/output so the latter are nearly invisible）",
				"trend.series.input": "New Input",
				"trend.series.cacheRead": "Cache Hit",
				"trend.series.output": "Output",
				"trend.series.cost": "Est. Cost",
				"trend.tooltipTotal": "Total",
				"bars.tooltipTotal": "Total",
				"trend.series.requests": "Requests",
				"trend.series.ttft": "Avg TTFT",
				// —— 供应商统计 ——
				"prov.title": "Provider Stats",
				"prov.note": "（all-time · not affected by filters）",
				"prov.times": " req",
				// —— 热力 ——
				"heat.title": "Consumption Heatmap",
				"heat.note": "（last year · not affected by filters · hover shows requests + tokens）",
				"heat.low": "Low",
				"heat.high": "High",
				"heat.day0": "Sun",
				"heat.day1": "Mon",
				"heat.day2": "Tue",
				"heat.day3": "Wed",
				"heat.day4": "Thu",
				"heat.day5": "Fri",
				"heat.day6": "Sat",
				// —— 请求记录 ——
				"rec.title": "Request Records",
				"rec.note": "（all-time · not affected by filters）",
				"rec.col.time": "Time",
				"rec.col.session": "Session",
				"rec.col.model": "Model",
				"rec.col.input": "New Input",
				"rec.col.output": "Output",
				"rec.col.cacheRead": "Cache Read",
				"rec.col.cost": "Est. Cost",
				"rec.col.ttft": "Avg TTFT",
				"rec.col.client": "Client",
				"rec.col.provider": "Provider",
				"rec.col.source": "Source",
				"rec.sourceDsh": "DSH Logs",
				"rec.pagePlaceholder": "Page",
				"rec.perPage": "{n}/page",
				"rec.perPagePlaceholder": "/page",
				"rec.go": "Go",
				// —— 排行 ——
				"rank.title": "Usage Ranking",
				"rank.note": "（all-time · not affected by filters · ranked by model by default）",
				"rank.col.model": "Model",
				"rank.col.provider": "Provider",
				"rank.col.client": "Client",
				"rank.col.input": "New Input",
				"rank.col.output": "Output",
				"rank.col.cacheRead": "Cache Read",
				"rank.col.ttft": "Avg TTFT",
				"rank.cost": "Est. Cost",
				"rank.noData": "No data",
				"rank.combo.models": "Model",
				"rank.combo.providers": "Provider",
				"rank.combo.clients": "Client",
				"rank.totalTokens": "Total Tokens",
				"rank.requests": "Requests",
				"rank.totalRows": "{n} total",
				// —— 筛选 ——
				"filter.client": "Client",
				"filter.provider": "Provider",
				"filter.model": "Model",
				"filter.all": "All",
				// —— 数据来源 ——
				"src.title": "Data Sources",
				"src.note": "（DSH records: import/export for cross-device sync · CC records: auto import or SQL file import · data sync every 5 minutes）",
				"src.foldWarn.title": "Log format change detected: ",
				"src.foldWarn.hint": "This is usually caused by a DSH update; support will follow in a later plugin version. Data already recorded is unaffected — you can keep using it.",
				"src.foldWarn.noHeader": "{n} session log(s) could not be read (format may have changed)",
				"src.foldWarn.unreadable": "{n} log file(s) contain corrupt or oversized frames",
				"src.foldWarn.unrecognized": "{n} log file name(s) unrecognized (DSH may have renamed them)",
				"src.foldWarn.emptyUsage": "{n} session(s) produced events but no usage rows (record format may have changed)",
				"src.col.source": "Source",
				"src.col.desc": "Description",
				"src.col.dir": "Directory",
				"src.col.lastUpdate": "Latest update",
				"src.lastUpdateTip": "Timestamp of the newest record in the source itself",
				"src.col.lastSync": "Latest sync",
				"src.syncRows": "{n} rows",
				"src.col.action": "Action",
				"src.dshLogs": "DSH Session Logs",
				"src.dshDesc": "This tool's session logs (auto incremental collection; manual import/export for cross-device sync)",
				"src.ccDesc": "Other client request records aggregated by CC (manually imported, DSH data excluded)",
				"src.openDir": "Open Folder",
				"src.export": "Export",
				"src.import": "Import",
				"src.exporting": "Exporting DSH usage…",
				"src.exported": "Exported {n} records · {m} days aggregated",
				"src.exportFailed": "Export failed",
				"src.importingDsh": "Importing DSH usage…",
				"src.dshImported": "Imported {n} records ({s} duplicates skipped)",
				"src.importDshFailed": "Import failed",
				"src.delete": "Delete",
				"src.importing": "Importing CC usage records…",
				"src.deleting": "Deleting CC data…",
				"src.confirmDelete": "Delete all imported CC data? This cannot be undone.",
				"src.confirm": "Confirm",
				"src.cancel": "Cancel",
				"src.imported": "Imported {n} records",
				"src.importSkipped": " · {n} unknown app(s) skipped",
				"src.deleted": "Deleted {n} CC records",
				"src.deleteFailed": "Delete failed",
				"src.importFailed": "Import failed",
				// —— 聚焦横幅 ——
				"focus.current": "Current session: {title}",
				"focus.clear": "Clear focus",
				// —— 说明文案 ——
				"note.costFormula": "Est. cost = tokens × pi-ai list price (unit: USD, for reference only, not an actual bill; subscription incurs no real charge)",
				"note.unpriced": " · {n} unpriced calls (counted in tokens, not cost)",
				// —— 供应商展示名 ——
				"vendor.unknown": "Unknown",
				"vendor.kimi": "Moonshot AI (Kimi)",
				"vendor.zhipu": "Zhipu (GLM)",
				"vendor.qwen": "Tongyi (Qwen)",
				"vendor.xiaomi": "Xiaomi",
				"vendor.antling": "Ant Ling (Ling)",
				// —— 图表加载 ——
				"chart.loading": "Loading chart…",
				"chart.loadFailed": "Chart library failed to load (/token-monitor/echarts.min.js unavailable)",
				// —— Settings ——
				"settings.title": "Token Monitor",
				"settings.defaultDays": "Default window",
				"settings.defaultDays.hint": "Default time range when opening the Usage tab",
				"settings.pollMs": "Quota refresh interval",
				"settings.pollMs.hint": "Quota is re-fetched every {sec} seconds",
				"settings.retentionDays": "Request record retention",
				"settings.retentionDays.hint": "Request records older than this are pruned periodically, aggregates and totals are unaffected",
				"settings.save": "Save",
				"settings.reset": "Discard changes",
				"settings.saved": "Saved successfully",
				"settings.saveFailed": "Save failed",
				// —— Adapted providers ——
				"settings.adapters.title": "Adapted providers",
				"settings.adapters.hint": "Provider list adapted by the plugin (adaptation & real-response verification), click to expand",
				"settings.adapters.loading": "Loading…",
				"settings.adapters.colVendor": "Vendor",
				"settings.adapters.colProvider": "Provider",
				"settings.adapters.colAdapted": "Adapted",
				"settings.adapters.colVerified": "Verified",
				"settings.adapters.yes": "Yes",
				"settings.adapters.verified": "Verified",
				"settings.adapters.pending": "Pending",
				"settings.adapters.note": "“Verified” only means whether the developer has actually tested the provider with real credentials.",
				// —— Model pricing ——
				"settings.pricing.title": "Model Pricing",
				"settings.pricing.hint": "（per million tokens; table prices first, pi-ai catalog fallback）",
				"settings.pricing.loading": "Loading…",
				"settings.pricing.noData": "No prices yet",
				"settings.pricing.colAction": "Actions",
				"settings.pricing.colModel": "Model",
				"settings.pricing.colMode": "Pricing",
				"settings.pricing.colCurrency": "Currency",
				"settings.pricing.colCacheHit": "Input·hit",
				"settings.pricing.colInput": "Input·miss",
				"settings.pricing.colOutput": "Output",
				"settings.pricing.colSince": "Start",
				"settings.pricing.colPeak": "Peak hours",
				"settings.pricing.colMultiplier": "Peak rate",
				"settings.pricing.modeFixed": "Fixed",
				"settings.pricing.modeTime": "Peak-valley",
				"settings.pricing.add": "Add",
				"settings.pricing.edit": "Edit",
				"settings.pricing.save": "Save",
				"settings.pricing.cancel": "Cancel",
				"settings.pricing.saved": "Saved",
				"settings.pricing.saveFailed": "Failed to save",
				"settings.pricing.namePlaceholder": "model id (e.g. kimi-k3)",
				"settings.version.title": "Version",
				"settings.version.current": "Current version v{v}",
				"settings.version.found": "New version v{v}, current v{c}",
				"settings.version.downloaded": "downloaded v{v}",
				"settings.version.latest": "Already on the latest version",
				"settings.version.upgrade": "Upgrade",
				"settings.version.upgrading": "Upgrading…",
				"settings.version.ok": "Upgrade succeeded. Restart dsh web to take effect",
				"settings.version.failed": "Upgrade failed",
				"settings.version.channelLink": "Local mount",
			},
		};

		/* ------------------------------ 格式化 ------------------------------ */

		/** token 数字的大数格式：中文 万 → 亿 → 万亿 压缩；英文 K/M/B 压缩。整数部分恒 ≤4 位 + 两位小数，不挤压瓦片。 */
		function fmtTokens(n) {
			if (typeof n !== "number" || !isFinite(n)) return "—";
			if (LANG === "en") {
				if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
				if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
				if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
				return String(n);
			}
			if (n >= 1e12) return (n / 1e12).toFixed(2) + t("unit.trillion");
			if (n >= 1e8) return (n / 1e8).toFixed(2) + t("unit.hundredMillion");
			if (n >= 1e4) return (n / 1e4).toFixed(2) + t("unit.tenThousand");
			return String(n);
		}

		function fmtTime(ts) {
			if (!ts) return "—";
			var d = new Date(ts);
			var pad = function (x) { return String(x).padStart(2, "0"); };
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
		}

		/** 秒级倒计时：1h 44min 56s；天级别不带秒（太长）。归零即触发刷新，故显示"正在刷新…"。 */
		function formatLiveCountdown(ms) {
			if (!isFinite(ms) || ms <= 0) return t("countdown.refreshing");
			var s = Math.floor(ms / 1000);
			var d = Math.floor(s / 86400); s %= 86400;
			var hh = Math.floor(s / 3600); s %= 3600;
			var mm = Math.floor(s / 60);
			var ss = s % 60;
			if (d > 0) return d + "d " + hh + "h " + mm + "min";
			if (hh > 0) return hh + "h " + mm + "min " + ss + "s";
			return mm + "min " + ss + "s";
		}

		/* ------------------------------ 样式 ------------------------------ */

		var S = {
			root: { position: "relative", display: "inline-flex" },
			trigger: {
				height: "32px", color: "var(--dsw-alias-label-primary)", cursor: "pointer",
				background: "none", border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "18px", alignItems: "center", justifyContent: "center",
				gap: "6px", padding: "6px 12px", fontSize: "13px", lineHeight: "20px",
				display: "inline-flex", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
			},
			dot: function (state) {
				var color = state === "ok" ? "var(--dsw-alias-success, #34a853)"
					: state === "warn" ? "var(--dsw-alias-warning, #f9ab00)"
					: state === "err" ? "var(--dsw-alias-error, #ea4335)"
					: "var(--dsw-alias-label-quaternary, #9aa0a6)";
				return { width: "6px", height: "6px", borderRadius: "50%", background: color, flex: "none" };
			},
			menu: {
				position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
				width: "340px", maxWidth: "min(380px, 100vw - 32px)",
				// 最大高度贴浏览器窗口：视口高 − 顶部徽标偏移(~60px) − 徽标下 6px − 底部留白(~44px)；
				// 内容超出窗口高度时整体出滚动条（overflow auto）。
				maxHeight: "calc(100vh - 110px)", overflow: "auto",
				boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-specific-menu)", borderRadius: "12px",
				boxShadow: "var(--dsw-shadow-lv3)", padding: "8px", display: "flex",
				flexDirection: "column", gap: "8px", fontSize: "12px",
				color: "var(--dsw-alias-label-primary)",
			},
			section: {
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
				padding: "10px", display: "flex", flexDirection: "column", gap: "4px",
			},
			sectionTitle: {
				fontSize: "11px", color: "var(--dsw-alias-label-tertiary)",
				display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px",
			},
			row: { display: "flex", alignItems: "baseline", gap: "8px", lineHeight: "18px" },
			rowLabel: { flex: "none", color: "var(--dsw-alias-label-secondary)" },
			rowValue: { flex: 1, textAlign: "right", fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rowDetail: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", textAlign: "right" },
			btn: {
				padding: "5px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "12px",
				border: "1px solid var(--dsw-alias-border-l2)", background: "none",
				color: "var(--dsw-alias-label-primary)",
			},
			// 设置页底部胶囊按钮：与三个下拉同款高度/圆角；保存为主 primary、恢复为次级。
			// 设置页底部按钮：对齐官方插件配置卡片的 discard / save（ui-settings-plugins PluginCard）
			btnPrimary: {
				appearance: "none", fontFamily: "inherit", cursor: "pointer",
				border: "1px solid transparent", borderRadius: "8px", padding: "5px 14px",
				fontSize: "13px", lineHeight: "1.5",
				background: "var(--dsw-alias-label-primary)",
				color: "var(--dsw-alias-bg-layer-3)",
			},
			btnGhost: {
				appearance: "none", fontFamily: "inherit", cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "5px 14px",
				fontSize: "13px", lineHeight: "1.5",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
			},
			// 自定义弹层下拉（设置页）——对齐 DSH PopupSelect 视觉：胶囊按钮 + 圆角浮层菜单。
			popMenu: {
				position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 120,
				minWidth: "120px", maxWidth: "220px", maxHeight: "240px", overflow: "auto",
				padding: "4px", listStyle: "none", margin: 0,
				background: "var(--dsw-specific-menu)", border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px", boxShadow: "var(--dsw-shadow-lv3)",
				display: "flex", flexDirection: "column", gap: "1px",
			},
			popItem: {
				width: "100%", boxSizing: "border-box", textAlign: "left", border: 0, borderRadius: "6px",
				padding: "6px 8px", cursor: "pointer", background: "none",
				fontSize: "13px", lineHeight: "18px", fontFamily: "inherit",
				color: "var(--dsw-alias-label-primary)", display: "flex", alignItems: "center", gap: "6px",
			},
			popItemHover: { background: "var(--dsw-alias-interactive-bg-hover)" },
			popCheck: { flex: "none", color: "var(--dsw-alias-state-business-primary, #1a73e8)", fontSize: "12px" },
			pickerRoot: { position: "relative", display: "flex", width: "100%" },
			pickerTrigger: {
				// 与"全部提供方"toggle 样式对齐：无边框、同 padding/gap/字号；flex:1 撑满左侧，
				// 把右侧的"↗ 详情"推到最右（标题截断由 pickerTitle 负责，无需 trigger 限宽）
				fontSize: "11px", color: "var(--dsw-alias-label-tertiary)",
				background: "none", border: 0, padding: "2px 0", cursor: "pointer",
				display: "inline-flex", alignItems: "center", gap: "4px",
				textAlign: "left", flex: "1 1 auto", minWidth: "0",
			},
			pickerLabel: {
				flex: "none", lineHeight: "16px", transform: "translateY(-0.5px)",
			},
			pickerTitle: {
				// 可收缩：超出剩余空间时省略号截断（只截标题，"当前会话（"前缀保留）
				flex: "1 1 auto", minWidth: "0",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
				lineHeight: "16px", transform: "translateY(-0.5px)",
				color: "var(--dsw-alias-label-secondary)",
			},
			pickerMenu: {
				position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 110,
				// 宽度撑满 pickerRoot（= 弹层内容宽），与会话卡片同宽
				maxHeight: "240px", overflow: "auto",
				margin: 0, padding: "4px", listStyle: "none",
				background: "var(--dsw-specific-menu)", border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "6px", boxShadow: "var(--dsw-shadow-lv3)",
				display: "flex", flexDirection: "column", gap: "1px",
			},
			pickerItem: {
				width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", gap: "6px",
				padding: "5px 8px", border: 0, borderRadius: "6px", cursor: "pointer",
				background: "none", fontSize: "12px", lineHeight: "18px", textAlign: "left",
				color: "var(--dsw-alias-label-primary)",
			},
			pickerItemText: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			pickerCheck: { flex: "none", color: "var(--dsw-alias-success, #34a853)", fontSize: "11px" },
			/** 尖角箭头：旋转的方框两邻边，down=45° / up=225°，marginTop 做视觉居中补偿。 */
			pickerChevron: function (open) {
				return {
					width: "4px", height: "4px", flex: "none",
					borderRight: "1.25px solid currentColor",
					borderBottom: "1.25px solid currentColor",
					transform: open ? "rotate(225deg)" : "rotate(45deg)",
					marginTop: open ? "1px" : "-2px",
				};
			},
			/** 折叠区箭头：收起朝右（▸）、展开朝下（▾），与会话下拉的"下/上"方向不同。 */
			expandChevron: function (expanded) {
				return {
					width: "4px", height: "4px", flex: "none",
					borderRight: "1.25px solid currentColor",
					borderBottom: "1.25px solid currentColor",
					transform: expanded ? "rotate(45deg)" : "rotate(-45deg)",
					marginTop: expanded ? "1px" : "-1px",
				};
			},
			muted: { color: "var(--dsw-alias-label-tertiary)" },
			error: { color: "var(--dsw-alias-error, #ea4335)" },
			bar: { height: "6px", borderRadius: "3px", background: "rgba(128, 128, 128, 0.22)", overflow: "hidden", marginTop: "3px" },
			stateColor: function (state) {
				return state === "err" ? "var(--dsw-alias-error, #ea4335)"
					: state === "warn" ? "var(--dsw-alias-warning, #f9ab00)"
					: "var(--dsw-alias-success, #34a853)";
			},
			barFill: function (pct, state) {
				return { height: "100%", width: Math.max(0, Math.min(100, pct)) + "%", background: S.stateColor(state), borderRadius: "3px" };
			},
			toggle: {
				background: "none", border: 0, padding: "2px 0", cursor: "pointer",
				color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", textAlign: "left",
				display: "flex", alignItems: "center", gap: "4px",
			},
			providerRow: {
				display: "flex", alignItems: "center", gap: "6px", padding: "4px 6px",
				borderRadius: "6px", lineHeight: "18px",
			},
			statGrid: { display: "flex", flexWrap: "wrap", gap: "6px" },
			statTile: {
				flex: "1 1 calc(50% - 3px)", boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px",
				background: "rgba(128, 128, 128, 0.08)",
				padding: "6px 9px", display: "flex", alignItems: "center",
				justifyContent: "space-between", gap: "6px",
			},
			statTileLabel: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "16px" },			statTileValue: function (color) {
				return {
					fontSize: "13px", fontWeight: 600, lineHeight: "18px",
					fontVariantNumeric: "tabular-nums",
					color: color || "var(--dsw-alias-label-primary)",
				};
			},
			raw: {
				margin: 0, padding: "6px", borderRadius: "6px", fontSize: "10px", lineHeight: "14px",
				background: "var(--dsw-alias-fill-l2)", color: "var(--dsw-alias-label-secondary)",
				whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "140px", overflow: "auto",
				fontFamily: "var(--dsw-font-mono, monospace)",
			},
			footer: {
				display: "flex", alignItems: "center", justifyContent: "space-between",
				fontSize: "11px", color: "var(--dsw-alias-label-tertiary)",
				// 无水平 padding：左侧与"全部提供方"文字（menu 内边距 8px 起）对齐
				padding: "0",
			},
			refreshBtn: {
				background: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px",
				padding: "2px 8px", cursor: "pointer", fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
			},
				/** 提供方名称后的官网按钮（充值 / 续费）：平时浅灰背景，hover 浅蓝背景 + 主题蓝文字。 */
				externalLink: {
					flex: "none", display: "inline-flex", alignItems: "center",
					border: 0, borderRadius: "4px",
					padding: "0 4px", height: "18px",
					fontSize: "11px", lineHeight: "16px", whiteSpace: "nowrap",
					color: "var(--dsw-alias-label-secondary)",
					background: "rgba(128,128,128,0.12)",
					textDecoration: "none", cursor: "pointer",
				},
			// 数据来源表格操作列按钮：小号描边按钮（同 refreshBtn 语言，更紧凑）
			sourceBtn: {
				background: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "5px",
				padding: "1px 8px", cursor: "pointer", fontSize: "11px", lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap",
			},
			/* ---- 用量页签（conversation.view 主区数据面板） ---- */
			usageRoot: {
				boxSizing: "border-box", width: "100%", height: "100%", overflowY: "auto",
				padding: "16px 20px calc(var(--dsh-composer-height, 152px) + 24px)",
				display: "flex", flexDirection: "column", gap: "12px",
				color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px",
			},
			usageHeader: { display: "flex", alignItems: "center", gap: "10px", flex: "none" },
			usageTitle: { fontSize: "15px", fontWeight: 600, marginRight: "auto" },
			windowBtn: {
				// border 用长属性而非简写：windowBtnActive 以 borderColor 长属性覆盖，
				// 简写含 var() 时 Chrome 挂起替换，React 移除覆盖后简写随之丢失，
				// 按钮落回 UA 默认黑边框（"点过的标签出现黑框"的根因）
				background: "none", borderWidth: "1px", borderStyle: "solid",
				borderColor: "var(--dsw-alias-border-l2)", borderRadius: "6px",
				padding: "3px 10px", fontSize: "12px", cursor: "pointer",
				color: "var(--dsw-alias-label-secondary)", lineHeight: "18px",
				// 文字/图标垂直居中（含分页箭头 svg）
				display: "inline-flex", alignItems: "center", justifyContent: "center",
				// border-box：设置 height 时含 padding/border，保证按钮实际尺寸与设定一致
				// （分页箭头 svg vs 文字内容高度不同，无此设置会大小不齐）
				boxSizing: "border-box",
				// 去掉点击后的焦点黑框：主题可能用 outline 或 box-shadow 画 :focus 环，都关掉
				outline: "none",
				boxShadow: "none",
			},
			windowBtnActive: {
				// 激活态用主题业务主色（页面里 stat 大数字已在用同一色族）
				background: "var(--dsw-alias-state-business-primary-soft, rgba(26,115,232,0.10))",
				color: "var(--dsw-alias-state-business-primary, #1a73e8)",
				borderColor: "var(--dsw-alias-state-business-primary, #1a73e8)",
				fontWeight: 600,
			},
			usageCard: {
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				padding: "12px", display: "flex", flexDirection: "column", gap: "8px", flex: "none",
			},
			usageCardTitle: { fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
			usageStatGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" },
			usageStatCard: {
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				background: "rgba(128,128,128,0.06)", padding: "10px 12px",
				display: "flex", flexDirection: "column", gap: "2px",
			},
			usageStatLabel: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
			usageStatValue: { fontSize: "20px", fontWeight: 650, fontVariantNumeric: "tabular-nums", lineHeight: "24px" },
			usageNote: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", flex: "none" },
			usageTh: {
				textAlign: "left", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)",
				fontWeight: 500, padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)",
				whiteSpace: "nowrap", lineHeight: "16px",
			},
			usageTd: {
				padding: "5px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)",
				fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", lineHeight: "18px",
			},
			usageFocusBanner: {
				display: "inline-flex", alignItems: "center", gap: "6px", flex: "none",
				border: "1px solid var(--dsw-alias-state-business-primary, #1a73e8)",
				// 圆角与筛选下拉（FilterSelect）一致的 6px 直角感（非胶囊 999px）
				borderRadius: "6px", padding: "3px 10px", fontSize: "12px", lineHeight: "18px",
				color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap",
			},
			usageFocusClear: {
				background: "none", border: 0, cursor: "pointer", padding: "0 2px",
				color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px",
			},
			pickerDetail: {
				flex: "none", background: "none", border: 0, cursor: "pointer",
				color: "var(--dsw-alias-label-tertiary)", fontSize: "12px",
				padding: "0 3px", borderRadius: "4px", lineHeight: "18px",
			},
			/** 同步提示条（§11.3）：类似"有更新"的通知样式（橙黄），有未同步数据时才渲染。 */
			syncBanner: {
				display: "flex", alignItems: "center", gap: "6px",
				// 同 windowBtn：borderColor 会被状态变体覆盖，须用长属性
				borderWidth: "1px", borderStyle: "solid",
				borderColor: "var(--dsw-alias-warning, #f9ab00)",
				background: "rgba(249,171,0,0.10)", borderRadius: "8px",
				padding: "6px 8px", fontSize: "11px", lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)",
			},
			/** CC 导入/删除的操作气泡（按钮下方浮动，复用删除确认气泡的定位与外观）。
			 *  状态色统一由调用方以 Object.assign 覆盖 borderColor/background/color。 */
			ccBubble: {
				position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 60,
				background: "var(--dsw-specific-menu)", border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "8px", boxShadow: "var(--dsw-shadow-lv3)",
				padding: "6px 8px", display: "flex", alignItems: "center", gap: "6px",
				fontSize: "11px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap",
			},
			/** CC 操作气泡状态变体：进行中（橙）/ 成功（绿）/ 失败（红）——背景不透明浅色（不透出底部表格边框）、边框同色系略深。 */
			ccBubbleBusy: {
				borderColor: "rgba(249,171,0,0.45)",
				background: "#fdf3d9",
				color: "var(--dsw-alias-warning, #f9ab00)",
			},
			ccBubbleOk: {
				borderColor: "rgba(52,168,83,0.45)",
				background: "#e6f5ea",
				color: "var(--dsw-alias-success, #34a853)",
			},
			ccBubbleErr: {
				borderColor: "rgba(234,67,53,0.45)",
				background: "#fce8e7",
				color: "var(--dsw-alias-error, #ea4335)",
			},
			/* ---- 用量页签筛选下拉 ---- */
			filterMenu: {
				position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 120,
				// box-sizing: border-box：minWidth 100% 包含自身 padding+border，总宽恰好 = 控件宽，
				// 不会因 content-box 在 100% 外再叠加 10px（padding 4×2 + border 1×2）而多出一截
				boxSizing: "border-box",
				// 最小宽度 = 100%（整个控件宽，含"客户端"标题，即按钮整体）；最大 20rem（320px，
				// 比按钮文字上限 180px + 标题约 55px 大，长选项名放得下）；高度不变（240px，超了滚动）
				minWidth: "100%", maxWidth: "20rem", maxHeight: "240px", overflow: "auto",
				margin: 0, padding: "4px", listStyle: "none",
				background: "var(--dsw-specific-menu)", border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "6px", boxShadow: "var(--dsw-shadow-lv3)",
				display: "flex", flexDirection: "column", gap: "1px",
			},
			filterItem: {
				width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", gap: "6px",
				padding: "4px 8px", border: 0, borderRadius: "6px", cursor: "pointer",
				background: "none", fontSize: "12px", lineHeight: "18px", textAlign: "left",
				color: "var(--dsw-alias-label-primary)",
			},
			/** 筛选下拉前置标签（如"客户端"）：小字 tertiary，marginRight 收掉 header gap 使标签贴近下拉。 */
			filterLabel: {
				fontSize: "11px", color: "var(--dsw-alias-label-tertiary)",
				whiteSpace: "nowrap", marginRight: "-6px",
			},
			/** CSS 线性 V 形箭头（chevron）：两条细线组成的 ∨/∧，非实心三角。down=true 朝下。 */
			chevronV: function (down) {
				return {
					display: "inline-block", flex: "none",
					width: "5px", height: "5px",
					borderRight: "1px solid currentColor",
					borderBottom: "1px solid currentColor",
					transform: down ? "rotate(45deg)" : "rotate(225deg)",
					marginTop: down ? "-2px" : "1px",
				};
			},
		};

		/* ---------------------------- 子组件 ---------------------------- */

		/**
		 * 徽标额度文案。规则（先看 7 天额度用完没）：
		 *  1. 7d 剩 0（周额度耗尽）→ 显示 "7d 剩 0%"（告急优先，即使 5h 还有余量）
		 *  2. 7d 还有剩余 → 显示 "5h 剩 X%"（5 小时滚动窗口更时效；used 缺失已由 Host 推算）
		 *  3. 5h 缺失（API 未返回 limits）→ 降级 "7d 剩 X%"
		 *  4. 都没有 → null（走 headline）
		 */
		function quotaText(p, now) {
			var st = p && p.stats;
			if (!st) return null;
			var weekly = st.weekly;
			// 窗口展示名：供应商 stats.labels 提供（opencode：滚动/周/月）；缺省 Kimi 语义 5h/7d
			var lab = st.labels || {};
			var windowLabel = lab.window || "5h";
			var weeklyLabel = lab.weekly || "7d";
			var src;
			var prefix;
			if (weekly && weekly.remainingPct <= 0) {
				src = weekly; prefix = t("card.remaining", { label: weeklyLabel });
			} else if (st.window) {
				src = st.window; prefix = t("card.remaining", { label: windowLabel });
			} else if (weekly) {
				src = weekly; prefix = t("card.remaining", { label: weeklyLabel });
			} else {
				return null;
			}
			var cd = "";
			var ms = src.resetAt ? src.resetAt - now : NaN;
			if (isFinite(ms) && ms <= 5 * 60 * 1000) {
				// 剩余不足 5 分钟才启用秒级走字，其余时候用静态文案。
				cd = " · " + formatLiveCountdown(ms);
			} else if (src.countdown) {
				// 中文剥"后重置"后缀；英文经 locServer 转成 " until reset"
				var cds = String(src.countdown);
				cd = " · " + (LANG === "en" ? locServer(cds) : cds.replace(/后重置$/, ""));
			}
			return prefix + src.remainingPct + "%" + cd;
		}

		/** 状态点：与 5 小时用量进度条同刻度（≤85% 绿、≤95% 黄、>95% 红）；查询失败恒红。 */
		function dotStateOf(p) {
			if (!p || !p.ok) return "err";
			var used = p.stats && p.stats.window ? p.stats.window.pct : null;
			if (used == null) return "ok";
			return used > 95 ? "err" : used > 85 ? "warn" : "ok";
		}

		function MetricRow(props) {
			// 带 pct 的指标渲染成粗圆角进度条，百分比用状态色加粗。
			// goodHigh=true（如缓存命中率）：高为绿；默认（用量类）：高为红。
			var hasBar = typeof props.pct === "number";
			var barState = hasBar
				? (props.goodHigh
					? (props.pct >= 80 ? "ok" : props.pct >= 50 ? "warn" : "err")
					: (props.pct > 95 ? "err" : props.pct > 85 ? "warn" : "ok"))
				: null;
			var valueStyle = hasBar
				? Object.assign({}, S.rowValue, { color: S.stateColor(barState), fontWeight: 600 })
				: S.rowValue;
			var labelStyle = props.labelStyle ? Object.assign({}, S.rowLabel, props.labelStyle) : S.rowLabel;
			var children = [
				h("div", { key: "row", style: S.row },
					h("span", { style: labelStyle }, props.label),
					h("span", { style: valueStyle }, props.value)),
			];
			if (hasBar) {
				children.push(h("div", {
					key: "bar", style: S.bar,
				}, h("div", { style: S.barFill(props.pct, barState) })));
			}
			if (props.detail) {
				children.push(h("div", { key: "detail", style: S.rowDetail }, props.detail));
			}
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } }, children);
		}

		/** 提供方官网按钮（充值/续费）：按量（balance）→ 充值，订阅（quota）→ 续费；url 缺失时不渲染。 */
		function ProviderSiteLink(props) {
			var url = props.url;
			if (!url) return null;
			var _h = React.useState(false), hovered = _h[0], setHovered = _h[1];
			var text = props.kind === "balance" ? t("entry.topUp") : t("entry.renew");
			return h("a", {
				href: url, target: "_blank", rel: "noopener noreferrer",
				title: t("entry.openSite"),
				style: hovered
					? Object.assign({}, S.externalLink, { color: "var(--dsw-alias-state-business-primary, #1a73e8)", background: "rgba(26,115,232,0.10)" })
					: S.externalLink,
				onMouseEnter: function () { setHovered(true); },
				onMouseLeave: function () { setHovered(false); },
			}, text);
		}

		/** 提供方错误提示：未配置凭证（configured:false，服务端标志）→ "未配置 API Key"（用户可自助解决）；
		 *  其余一律 → "查询失败"（不把服务端错误原文暴露给用户）。 */
		function providerErrText(p) {
			return p && p.configured === false ? t("card.noApiKey") : t("card.queryFailed");
		}

		function ProviderCard(props) {
			var p = props.provider;
			if (!p) {
				return h("div", { style: S.section },
					h("div", { style: S.sectionTitle }, t("card.currentModel")),
					h("div", { style: S.muted }, props.model
						? t("card.routeUnmonitored", { p: props.model.provider, m: props.model.model })
						: t("card.modelNotIdentified")));
			}
			// 已配置但未适配的当前提供方：占位提示
			if (p.unsupported) {
				return h("div", { style: S.section },
					h("div", { style: S.sectionTitle },
						h("span", { style: S.dot("idle") }),
						h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
							h("span", null, p.label),
							h(ProviderSiteLink, { url: providerUrl(p.id, p.kind), kind: p.kind })),
						h("span", { style: { flex: 1 } }),
						h("span", { style: S.muted }, props.model && props.model.model)),
					h("div", { style: S.muted }, t("entry.unsupported")));
			}
			var metrics = p.metrics || [];
			return h("div", { style: S.section },
				h("div", { style: S.sectionTitle },
					h("span", { style: S.dot(p.ok ? "ok" : "err") }),
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
						h("span", null, p.label),
						h(ProviderSiteLink, { url: providerUrl(p.id, p.kind), kind: p.kind })),
					h("span", { style: { flex: 1 } }),
					h("span", { style: S.muted }, [p.badge, props.model && props.model.model].filter(Boolean).join(" · "))),
				p.ok
					? metrics.map(function (m, i) { return h(MetricRow, { key: i, label: locServer(m.label), value: locServer(m.value), detail: locServer(m.detail), pct: m.pct }); })
					: h("div", { style: Object.assign({}, S.error, { textAlign: "right" }) }, providerErrText(p)));
		}

		/** 指标瓦片：左标签、右数值；wide=true 通栏。 */
		function StatTile(props) {
			var style = props.wide ? Object.assign({}, S.statTile, { flex: "1 1 100%" }) : S.statTile;
			return h("div", { style: style },
				h("span", { style: S.statTileLabel }, props.label),
				h("span", { style: S.statTileValue(props.color) }, props.value));
		}

		/** 比率瓦片：通栏，数值带状态色，进度条内嵌瓦片底缘（方案 2）。 */
		function RateTile(props) {
			var state = props.pct >= 80 ? "ok" : props.pct >= 50 ? "warn" : "err";
			var style = Object.assign({}, S.statTile, {
				flex: "1 1 100%", flexDirection: "column", alignItems: "stretch",
				justifyContent: undefined, gap: "4px",
			});
			return h("div", { style: style },
				h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
					h("span", { style: S.statTileLabel }, props.label),
					h("span", { style: S.statTileValue(S.stateColor(state)) }, props.value)),
				h("div", { style: S.bar }, h("div", { style: S.barFill(props.pct, state) })));
		}

		/** 当前会话标识行（只读）：▸ 符号 + 当前会话标题 + 右侧"用量详情"按钮。
		 *  弹层只支持查看当前会话，已取消会话切换下拉；布局与原先保持一致。 */
		function CurrentSessionRow(props) {
			var title = props.title || props.sessionId || "";
			return h("div", { style: S.pickerRoot },
				h("div", { style: Object.assign({}, S.pickerTrigger, { cursor: "default" }) },
					h("span", { style: { flex: "none", color: "var(--dsw-alias-label-tertiary)" } }, "▸"),
					h("span", { style: S.pickerTitle }, t("entry.currentSession", { title: title }))),
				h("button", {
					type: "button", style: S.refreshBtn,
					title: t("entry.openUsage"),
					onClick: function () {
						if (props.onDetail && props.sessionId) props.onDetail({ id: props.sessionId, title: title });
					},
				}, t("entry.usageDetail")));
		}

		function UsageSection(props) {
			// 弹层只展示当前会话的累计用量：数据来自框架 tokenUsage 投影（props.usage，
			// 会话条目 kit 的 useProjection 读取，0.1.1 / 0.1.2 均可用）。已无会话切换。
			var usage = props.usage;
			var body = null;
			if (!usage) {
				body = h("div", { style: S.muted }, t("card.noSessionData"));
			} else {
				var input = usage.uncachedInputTokens;
				var output = usage.outputTokens;
				var cacheRead = usage.cacheReadTokens;
				var cacheWrite = usage.cacheWriteTokens;
				// 命中率 = 命中 ÷（命中 + 新增输入），分母为 0（还没跑过请求）时不显示。
				var hitDenom = cacheRead + input;
				var hitPct = hitDenom > 0 ? Math.round((cacheRead / hitDenom) * 10000) / 100 : null;
				// 总输入（未缓存 + 命中 + 创建），只用于"总消耗"瓦片
				var totalInput = input + cacheRead + cacheWrite;
				var defs = [
					// 输入 = 未缓存（新增）部分；总消耗 = 全四桶合计
					{ key: "in", label: t("tile.input"), value: fmtTokens(input) },
					{ key: "out", label: t("tile.output"), value: fmtTokens(output) },
					{ key: "hit", label: t("tile.cacheHit"), value: fmtTokens(cacheRead) },
				];
				// 缓存创建恒 0 不占位，出现非 0（如接 Anthropic）时自动补一块瓦片
				if (cacheWrite > 0) defs.push({ key: "cw", label: t("tile.cacheWrite"), value: fmtTokens(cacheWrite) });
				// 第四块：总消耗（总输入 + 输出），与其他三块同为 token 维度
				defs.push({ key: "total", label: t("tile.total"), value: fmtTokens(totalInput + output) });
				// 奇数块时最后一块通栏，网格不留半空位
				var tiles = defs.map(function (d, i) {
					return h(StatTile, {
						key: d.key, label: d.label, value: d.value,
						wide: i === defs.length - 1 && defs.length % 2 === 1,
					});
				});
				body = h("div", { style: S.statGrid },
					hitPct !== null
						? tiles.concat([h(RateTile, { key: "rate", label: t("tile.hitRate"), value: hitPct + "%", pct: hitPct })])
						: tiles);
			}
			// 标题行（当前会话）在卡片外；卡片只包统计瓦片
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
				h(CurrentSessionRow, {
					sessionId: props.sessionId, title: props.title, onDetail: props.onDetail,
				}),
				h("div", { style: S.section }, body));
		}

		function AllProviders(props) {
			var providers = props.providers || [];
			if (!providers.length) return h("div", { style: S.muted }, t("card.noProviderData"));
			return providers.map(function (p) {
				// 已配置但未适配的提供方：占位提示（文案与正常行的 value 同列右侧对齐）
				if (p.unsupported) {
					return h("div", { key: p.id, style: S.providerRow },
						h("span", { style: S.dot("idle") }),
						h("span", { style: S.rowLabel }, p.label),
						h("span", { style: Object.assign({}, S.rowValue, S.muted) }, t("entry.unsupported")));
				}
				// 订阅类供应商（有 stats）：value 列显示余量组合——已用百分比对用户没有直觉
				// 意义，改显各窗口余量 + 重置倒计时；余额类（无 stats）保持 headline。
				// 窗口标签：供应商 stats.labels 提供（opencode：滚动/周/月）；缺省 Kimi 语义 5h/7d。
				var st = p.stats;
				var quota = null;
				if (p.ok && st) {
					var lab = st.labels || {};
					var windowLabel = lab.window || "5h";
					var weeklyLabel = lab.weekly || "7d";
					var monthly = st.monthly;
					var monthlyLabel = lab.monthly || "30d";
					var parts = [];
					var weekly = st.weekly;
					if (weekly && weekly.remainingPct <= 0) {
						// 周额度耗尽：只显示周 0%（告急优先，不显示滚动窗口）
						parts.push(weeklyLabel + " " + weekly.remainingPct + "%");
					} else {
						if (st.window) parts.push(windowLabel + " " + st.window.remainingPct + "%");
						if (weekly) parts.push(weeklyLabel + " " + weekly.remainingPct + "%");
					}
					// opencode 等带月窗口的供应商追加 30d 余量（Kimi 无 monthly 不显示）
					if (monthly && monthly.remainingPct >= 0) parts.push(locServer(monthlyLabel) + " " + monthly.remainingPct + "%");
					if (parts.length) quota = parts.join(" · ");
				}
				return h("div", { key: p.id, style: S.providerRow },
					h("span", { style: S.dot(p.ok ? "ok" : "err") }),
					h("span", { style: S.rowLabel }, p.label),
					h("span", { style: p.ok ? S.rowValue : Object.assign({}, S.rowValue, S.error) },
						p.ok ? (quota || locServer(p.headline) || "—") : providerErrText(p)));
			});
		}

		/* ---------------------------- 主组件 ---------------------------- */

		/**
		 * 解析“当前会话所用模型”：{ provider, model } 或 null（回调式）。
		 * 取值以新版（0.1.2+）优先，不支持时再回退旧版：
		 *  - 0.1.2+：remote.session.control() 流首帧 baseline 里
		 *      projections[sessionId].values.modelSelection.next（投影视图 = pending ?? lastUsed，
		 *      与官方 model-selection UI 同口径）；该会话尚无选择时退回
		 *      remote.session.modelCatalog().default（部署默认模型）。
		 *  - 新版不可用/无结果（未升级 ≤0.1.1）：ctx.connection.api.sessions.models({sessionId})
		 *      → result.value.current。
		 * 新版失败（异常/流结束/无选择且 default 不可得）时**立即**回退旧版，不做长等待；
		 * 两代都没有结果时回传 null，由调用方走“未识别”兜底文案。
		 */
		function resolveCurrentModel(sessionId, cb) {
			var called = false;
			var done = function (v) {
				if (called) return;
				called = true;
				try { cb(v); } catch (_e) { /* 忽略 */ }
			};

			// 旧版查询（≤0.1.1）：仅作新版不可用时的回退；0.1.2 下不存在则直接空。
			var legacyApi = apiRef.current;
			var legacy = function () {
				if (!legacyApi || !legacyApi.sessions || typeof legacyApi.sessions.models !== "function") { done(null); return; }
				legacyApi.sessions.models({ sessionId: sessionId }).then(function (res) {
					var r = res && res.result;
					done(r && r.ok && r.value && r.value.current ? r.value.current : null);
				}).catch(function () { done(null); });
			};

			// 新版（0.1.2+）优先：remote.session（control 流首帧 baseline 即含全部会话投影）
			var rs = remoteSessionRef.current;
			if (!rs || typeof rs.control !== "function") { legacy(); return; }
			var ctl = new AbortController();
			var finished = false;
			var settle = function (v) {
				if (finished) return;
				finished = true;
				try { ctl.abort(); } catch (_e) { /* 忽略 */ }
				done(v);
			};
			var iterator;
			try {
				iterator = rs.control(ctl.signal);
			} catch (_e2) { legacy(); return; }

			var fallbackDefault = function () {
				if (typeof rs.modelCatalog !== "function") { legacy(); return; }
				Promise.resolve().then(function () { return rs.modelCatalog(); }).then(function (res) {
					var def = res && res.ok && res.value && res.value.default;
					if (def && def.provider && def.model) settle(def);
					else legacy();
				}).catch(function () { legacy(); });
			};

			var read = function () {
				Promise.resolve().then(function () { return iterator.next(); }).then(function (step) {
					if (step.done) { legacy(); return; }
					var frame = step.value;
					if (frame && frame.type === "baseline" && frame.value && frame.value.projections) {
						var block = frame.value.projections[sessionId];
						var ms = block && block.values && block.values.modelSelection;
						if (ms && ms.next && ms.next.provider && ms.next.model) { settle(ms.next); return; }
						fallbackDefault();
						return;
					}
					read();
				}).catch(function () { legacy(); });
			};
			read();
		}

		function TokenMonitorEntry(props) {
			var sessionId = props.sessionId;
			var useProjection = props.useProjection;
			var usage = useProjection ? useProjection("tokenUsage") : undefined;
			// 当前会话标题（只读展示）：信息取自会话投影，取值优先级以新版（0.1.2
			// 会话条目 kit 的 useProjection → title 投影）为准；新版不可用（未升级 /
			// 无该投影）时再按旧版查询（0.1.1 useSessions 会话列表标题），最后回退会话 id。
			var titleProj = useProjection ? useProjection("title") : undefined;
			var sessionOptions = props.useSessions
				? props.useSessions(function (s) {
					return s.ids.map(function (id) { return { id: id, title: (s.byId[id] && s.byId[id].displayTitle) || id }; });
				})
				: [];
			var sessionTitle = (typeof titleProj === "string" && titleProj) ? titleProj : (sessionId || "");
			if (sessionId && (!sessionTitle || sessionTitle === sessionId)) {
				for (var ti = 0; ti < sessionOptions.length; ti++) {
					if (sessionOptions[ti].id === sessionId) { sessionTitle = sessionOptions[ti].title; break; }
				}
			}

			var _a = React.useState(null), overview = _a[0], setOverview = _a[1];
			var _b = React.useState(null), fetchError = _b[0], setFetchError = _b[1];
			var _c = React.useState(null), current = _c[0], setCurrent = _c[1];
			var _d = React.useState(false), openState = _d[0], setOpen = _d[1];
			var open = PIN_OPEN ? true : openState;
			var _e = React.useState(false), showAll = _e[0], setShowAll = _e[1];
			// 当前提供方快速数据（/overview/current 单家抓取）：徽标优先用它，不等全量
			var _cd = React.useState(null), currentData = _cd[0], setCurrentData = _cd[1];
			var _g = React.useState(false), hovered = _g[0], setHovered = _g[1];
			var _h = React.useState(false), refreshing = _h[0], setRefreshing = _h[1];
			var _i = React.useState(function () { return Date.now(); }), now = _i[0], setNow = _i[1];
			var _j = React.useState(null), syncPending = _j[0], setSyncPending = _j[1];
			var _k = React.useState(false), syncing = _k[0], setSyncing = _k[1];
			var _l = React.useState(null), syncDone = _l[0], setSyncDone = _l[1];
			var _m = React.useState(null), syncAutoErr = _m[0], setSyncAutoErr = _m[1]; // 5 分钟自动同步失败（仅失败显示）
			// 同步成功摘要的自动关闭定时器（组件卸载时清理，防卸载后 setState）
			var syncTimerRef = React.useRef(null);
			var rootRef = React.useRef(null);

			// CC-switch 未同步探测（DESIGN §11.3）：弹层打开时拉一次；同步完成后再拉。
			var refreshPending = React.useCallback(function () {
				fetch("/token-monitor/sync/pending", { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
					.then(function (d) {
						setSyncPending(d && d.ok ? (d.pending || []) : null);
						// 5 分钟自动同步失败时给失败条；成功/未失败为 null
						setSyncAutoErr(d && d.ok && d.auto ? { error: d.auto.error, at: d.auto.at } : null);
					})
					.catch(function () { setSyncPending(null); });
			}, []);

			// CC-switch 历史导入（DESIGN.md §6）：幂等，重复点击无副作用。
			// 完成后显示结果摘要，3 秒后淡出并重新探测 pending。
			var runSync = React.useCallback(function () {
				setSyncing(true);
				setSyncDone(null);
				if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
				fetch("/token-monitor/import/cc-switch", {
					method: "POST", headers: { accept: "application/json" },
				}).then(function (r) { return r.json(); })
					.then(function (d) {
						if (!d || !d.ok) {
							setSyncDone({ error: (d && d.error) || t("src.importFailed") });
						} else {
							setSyncAutoErr(null); // 手动同步成功：最近自动失败随之清除
							// 结果摘要带过期时间：右侧显示 N 秒倒计时后自动关闭并重新探测（§11.3）
							setSyncDone({
								imported: d.imported, skippedUnknownApp: d.skippedUnknownApp || 0,
								expiresAt: Date.now() + 3000,
							});
							// 通知已挂载的用量页全局刷新（与用量页"导入"成功后的效果一致：
							// 静默全量重载含历史图 + 请求记录独立重拉）
							window.dispatchEvent(new CustomEvent("token-monitor:usage-refresh"));
							syncTimerRef.current = setTimeout(function () {
								syncTimerRef.current = null;
								setSyncDone(null);
								refreshPending();
							}, 3000);
						}
					})
					.catch(function (e) { setSyncDone({ error: String((e && e.message) || e) }); })
					.then(function () { setSyncing(false); });
			}, [refreshPending]);

			// 弹层打开时探测一次未同步数据（§11.3）
			React.useEffect(function () {
				if (open) refreshPending();
			}, [open, refreshPending]);

			// 组件卸载清理：同步摘要自动关闭定时器
			React.useEffect(function () {
				return function () {
					if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
				};
			}, []);

			// silent=true 用于后台轮询：不打扰刷新按钮的 loading 态；
			// 打开弹层和手动点击（silent=false）才显示"刷新中…"。
			var refresh = React.useCallback(function (silent) {
				if (!silent) setRefreshing(true);
				fetch(OVERVIEW_URL, { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
					.then(function (d) {
						setOverview(d);
						overviewCache = d; // 共享缓存：设置页/用量页复用，避免各自再拉导致的闪帧
						setFetchError(null);
					})
					.catch(function (e) { setFetchError(String((e && e.message) || e)); })
					.then(function () { if (!silent) setRefreshing(false); });
			}, []);

			// 当前提供方快速刷新：只抓当前会话所用提供方（徽标优先，不等全量）。
			// 返回 { provider, pluginSettings, usdCnyRate }；provider 为单个 payload。
			var refreshCurrent = React.useCallback(function (pid, silent) {
				if (!pid) return;
				if (!silent) setRefreshing(true);
				fetch("/token-monitor/overview/current?provider=" + encodeURIComponent(pid), { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
					.then(function (d) {
						if (d && d.ok) {
							setCurrentData(d);
							setFetchError(null);
						}
					})
					.catch(function (e) { setFetchError(String((e && e.message) || e)); })
					.then(function () { if (!silent) setRefreshing(false); });
			}, []);

			// 轮询周期跟随插件设置（overview/current 的 pluginSettings.pollMs，单位秒，默认 60）；配置变化时重建定时器。
			// pollMs 存的是秒，setInterval 需要毫秒，这里单独 ×1000。
			var pollMsSec = (overview && overview.pluginSettings && overview.pluginSettings.pollMs)
				|| (currentData && currentData.pluginSettings && currentData.pluginSettings.pollMs)
				|| POLL_MS;
			var pollMs = pollMsSec * 1000;
			var currentPidRef = React.useRef(null);
			// 记录当前 provider pid（current 变化时更新）
			React.useEffect(function () {
				currentPidRef.current = current ? (PROVIDER_ALIASES[current.provider] || current.provider) : null;
			}, [current]);
			// 轮询：有当前 provider 拉 current（快速单家），否则退回全量 overview
			React.useEffect(function () {
				var pid = currentPidRef.current;
				if (pid) refreshCurrent(pid, false); else refresh(false);
				var timer = setInterval(function () {
					var p2 = currentPidRef.current;
					if (p2) refreshCurrent(p2, true); else refresh(true);
				}, pollMs);
				return function () { clearInterval(timer); };
			}, [refresh, refreshCurrent, pollMs]);
			// 当前 provider 变化（切换会话/模型）：立即刷新徽标
			React.useEffect(function () {
				if (current && current.provider) {
					refreshCurrent(PROVIDER_ALIASES[current.provider] || current.provider, true);
				}
			}, [current, refreshCurrent]);
			// 弹层打开：拉全量 overview（"全部提供方"需要完整列表）
			React.useEffect(function () {
				if (open) refresh(false);
			}, [open, refresh]);

			// 设置保存广播：立即刷新当前（拿新 pollMs，无需等下一轮询）
			React.useEffect(function () {
				function onSaved() {
					var pid = currentPidRef.current;
					if (pid) refreshCurrent(pid, true); else refresh(true);
				}
				window.addEventListener("token-monitor:settings-saved", onSaved);
				return function () { window.removeEventListener("token-monitor:settings-saved", onSaved); };
			}, [refresh, refreshCurrent]);

			// 徽标秒级倒计时的走时心跳；有 resetAt 时才有可见效果，开销可忽略。
			React.useEffect(function () {
				var timer = setInterval(function () { setNow(Date.now()); }, 1000);
				return function () { clearInterval(timer); };
			}, []);

			// 当前会话的模型选择；弹层每次打开时重读一次。
			// 0.1.2 起 api.sessions.models 已移除，改走 remote.session（control 流投影/modelCatalog）。
			React.useEffect(function () {
				if (!sessionId) return undefined;
				var disposed = false;
				resolveCurrentModel(sessionId, function (model) {
					if (!disposed) setCurrent(model);
				});
				return function () { disposed = true; };
			}, [sessionId, open]);

			// 点击外部 / Esc 关闭弹层。
			React.useEffect(function () {
				if (!open) return undefined;
				var onPointerDown = function (event) {
					if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
				};
				var onKeyDown = function (event) {
					if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			var providers = (overview && overview.providers) || [];
			// 当前提供方：优先用快速通道（/overview/current 单家实时），未就绪时退回全量列表里找
			var currentPid = current ? (PROVIDER_ALIASES[current.provider] || current.provider) : null;
			var currentProvider = current
				? ((currentData && currentData.provider && currentData.provider.id === currentPid) ? currentData.provider
					: (providers.find(function (p) { return p.id === currentPid; }) || null))
				: null;

			// 倒计时归零时静默刷新一次（拿新窗口的 resetAt）。
			// 标志位防连发；拿到未来时刻的 resetAt 后自动复位。
			var zeroFiredRef = React.useRef(false);
			React.useEffect(function () {
				var resetAt = currentProvider && currentProvider.ok
					&& currentProvider.stats && currentProvider.stats.window
					? currentProvider.stats.window.resetAt : null;
				if (!resetAt || resetAt - now > 0) { zeroFiredRef.current = false; return; }
				if (!zeroFiredRef.current) {
					zeroFiredRef.current = true;
					refresh(true);
				}
			}, [now, currentProvider, refresh]);

			var label;
			var dotState = "idle";
			if (fetchError && !overview) {
				label = t("entry.quotaMonitor");
				dotState = "err";
			} else if (currentProvider) {
				label = (current ? current.model : currentProvider.label) + " · "
					+ (currentProvider.ok ? (quotaText(currentProvider, now) || locServer(currentProvider.headline) || "—") : providerErrText(currentProvider));
				dotState = dotStateOf(currentProvider);
			} else if (current) {
				label = t("entry.modelQuota", { model: current.model });
			} else {
				label = t("entry.quotaMonitor");
			}

			// "↗ 详情"：交棒聚焦会话 → 关弹层 → 切到"用量"页签。
			// 活跃 view 存在 conversation 插件闭包私有的 chatStore 里，外部插件没有公共
			// setView API；页签按钮的 onClick 走框架自己的 actions.setView 路径，模拟点击即可。
			// 但用量 tab 已激活时模拟点击会被忽略（无渲染）——再补发一个 window 自定义事件，
			// 已挂载的 UsageView 用 useEffect 监听消费（事件驱动，不依赖渲染周期）。
			function openUsageDetail(s) {
				usageFocusRequest = { sessionId: s.id, title: s.title }; // 首挂载/切回 tab 时的渲染期兜底
				window.dispatchEvent(new CustomEvent("token-monitor:focus-session", {
					detail: { sessionId: s.id, title: s.title },
				}));
				setOpen(false);
				var tabs = document.querySelectorAll('button[role="tab"]');
				var tabLabel = t("usage.tab");
				for (var i = 0; i < tabs.length; i++) {
					if (tabs[i].textContent.replace(/\s+/g, " ").trim() === tabLabel) {
						tabs[i].click();
						return;
					}
				}
			}

			// 同步成功倒计时（秒）：右侧显示"N s 后关闭"，由 1s 心跳驱动递减。
			var syncLeft = syncDone && !syncDone.error && syncDone.expiresAt
				? Math.ceil((syncDone.expiresAt - now) / 1000)
				: 0;

			return h("div", { ref: rootRef, style: S.root },
				h("button", {
					type: "button",
					style: hovered ? Object.assign({}, S.trigger, { background: "var(--dsw-alias-interactive-bg-hover)" }) : S.trigger,
					"aria-expanded": open,
					title: (overview && overview.version)
						? t("entry.title") + " · v" + overview.version
						: t("entry.title"),
					onClick: function () { setOpen(function (v) { return !v; }); if (!open) refresh(); },
					onMouseEnter: function () { setHovered(true); },
					onMouseLeave: function () { setHovered(false); },
				},
					h("span", { style: S.dot(dotState) }),
					h("span", null, label)),
				open
					? h("div", { style: S.menu, role: "dialog", "aria-label": t("entry.title") },
						h(ProviderCard, { provider: currentProvider, model: current }),
						h(UsageSection, {
							usage: usage, sessionId: sessionId, title: sessionTitle,
							onDetail: openUsageDetail,
						}),
						// 收紧只作用于"全部提供方"按钮与下方邻居（折叠时 8px→4px）；
						// footer 永不动，上下间距恒 8px 对称（提示条存在时也不破坏）
						h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", marginBottom: showAll ? 0 : "-4px" } },
							h("button", {
								type: "button", style: S.toggle,
								"aria-expanded": showAll,
								onClick: function () { setShowAll(function (v) { return !v; }); },
							}, (showAll ? "▾ " : "▸ ") + t("entry.allProviders", { n: providers.length })),
							showAll ? h("div", { style: S.section }, h(AllProviders, { providers: providers })) : null),
						h("div", { style: S.footer },
							h("span", null, fetchError
								? h("span", { style: S.error }, t("entry.fetchFailed"))
								: t("entry.updatedAt", { time: fmtTime(overview && overview.fetchedAt) })),
							h("div", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } },
								h("button", {
									type: "button",
									style: refreshing ? Object.assign({}, S.refreshBtn, { opacity: 0.55, cursor: "default" }) : S.refreshBtn,
									disabled: refreshing,
									onClick: function () { refresh(false); },
								}, refreshing ? t("entry.refreshing") : t("entry.refresh")))),
						// 同步提示条（DESIGN §11.3）：弹层最底部；有未同步数据才显示，
						// 同步成功在右侧（原按钮位置）显示倒计时，几秒后自动关闭。
						syncDone
							? h("div", {
								style: syncDone.error
									? Object.assign({}, S.syncBanner, { borderColor: "var(--dsw-alias-error, #ea4335)", background: "rgba(234,67,53,0.08)" })
									: Object.assign({}, S.syncBanner, { borderColor: "var(--dsw-alias-success, #34a853)", background: "rgba(52,168,83,0.08)" }),
							},
								h("span", { style: { flex: "none" } }, syncDone.error ? "ⓧ" : "✓"),
								h("span", { style: { flex: 1 } },
									syncDone.error
										? t("entry.syncFailed")
										: t("entry.syncDone", { n: syncDone.imported })
											+ (syncDone.skippedUnknownApp ? t("entry.syncSkipped", { n: syncDone.skippedUnknownApp }) : "")),
								syncDone.error
									? h("button", { type: "button", style: S.refreshBtn, onClick: runSync }, t("entry.syncRetry"))
									: h("span", {
										style: { flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums",
											color: "var(--dsw-alias-label-tertiary)" },
									}, syncLeft > 0 ? t("entry.syncCloseIn", { n: syncLeft }) : ""))
							: (syncAutoErr
								? h("div", {
									style: Object.assign({}, S.syncBanner, { borderColor: "var(--dsw-alias-error, #ea4335)", background: "rgba(234,67,53,0.08)" }),
								},
									h("span", { style: { flex: "none" } }, "ⓧ"),
									h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: String(syncAutoErr.error || "") },
										t("entry.syncAutoFailed")),
									h("button", {
										type: "button",
										style: syncing ? Object.assign({}, S.refreshBtn, { opacity: 0.55, cursor: "default" }) : S.refreshBtn,
										disabled: syncing,
										onClick: runSync,
									}, syncing ? t("entry.syncing") : t("entry.syncRetry")))
								: (syncPending && syncPending.length
									? syncPending.map(function (p) {
										return h("div", { key: p.source, style: S.syncBanner },
											h("span", { style: { flex: "none" } }, "ⓘ"),
											h("span", { style: { flex: 1 } },
												p.error
													? p.label + "：" + t("entry.syncFailed")
													: t("entry.syncDetected", { name: p.label, n: p.pending })),
											p.error
												? null
												: h("button", {
													type: "button",
													style: syncing ? Object.assign({}, S.refreshBtn, { opacity: 0.55, cursor: "default" }) : S.refreshBtn,
													disabled: syncing,
													onClick: runSync,
												}, syncing ? t("entry.syncing") : t("entry.sync")));
									})
									: null)))
					: null);
		}

		/* ---------------------------- 用量页签（conversation.view） ---------------------------- */

		/** Host 用量统计路由（与弹层共用同一套 Host 查询，无口径分叉）。 */
		var USAGE_URLS = {
			daily: "/token-monitor/usage/daily",
			byModel: "/token-monitor/usage/by-model",
			hourly: "/token-monitor/usage/hourly",
			distribution: "/token-monitor/usage/distribution",
			calendar: "/token-monitor/usage/calendar",
			rank: "/token-monitor/usage/rank",
		};

		/** 毫秒时间戳 → 本地时区 'YYYY-MM-DD'（与服务端 dayOf 同口径）。 */
		function localDay(ms) {
			var d = new Date(ms);
			var p = function (x) { return String(x).padStart(2, "0"); };
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
		}
		/** 数据来源卡"最近更新"：yyyy-MM-dd HH:mm:ss；无记录显示 —。 */
		function fmtLastUpd(ts) {
			if (!ts) return "—";
			var d = new Date(ts);
			var p = function (x) { return String(x).padStart(2, "0"); };
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
				+ " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		/**
		 * 折叠健康告警文案（数据来源卡）。
		 * 折叠器读不出 header / 兜不住帧 / 认不出日志名 / 有事件却产不出用量行时，
		 * 必须在这里变成用户可见的提示——"页面上显示 0"和"日志根本读不出来"是两回事，
		 * 静默显示 0 正是一次真实故障（DSH 日志换版本命名）没被及时发现的原因。
		 */
		function foldHealthWarning(h) {
			if (!h) return null;
			var parts = [];
			if (h.noHeader && h.noHeader.length) parts.push(t("src.foldWarn.noHeader", { n: h.noHeader.length }));
			if (h.unreadable && h.unreadable.length) parts.push(t("src.foldWarn.unreadable", { n: h.unreadable.length }));
			if (h.unrecognizedLogs && h.unrecognizedLogs.length) parts.push(t("src.foldWarn.unrecognized", { n: h.unrecognizedLogs.length }));
			if (h.emptyUsage && h.emptyUsage.length) parts.push(t("src.foldWarn.emptyUsage", { n: h.emptyUsage.length }));
			if (!parts.length) return null;
			return t("src.foldWarn.title") + parts.join("；");
		}
		/**
		 * 时间窗选项（用量页切换按钮组 + 设置页下拉共用同一份，保证页签标签与下拉数据一致）：
		 * v = 天数；0 = "全部"（无时间上限）。label 为函数，渲染时按当前语言解析。
		 */
		var WINDOW_OPTIONS = [
			{ v: 1, label: function () { return t("usage.windowToday"); } },
			{ v: -1, label: function () { return t("usage.windowYesterday"); } },
			{ v: 7, label: function () { return t("usage.windowDays", { d: 7 }); } },
			{ v: 30, label: function () { return t("usage.windowDays", { d: 30 }); } },
			{ v: 90, label: function () { return t("usage.windowDays", { d: 90 }); } },
			{ v: 0, label: function () { return t("usage.windowAll"); } },
		];

		/**
		 * 客户端展示名映射（数据层保持小写 id：过滤/分组/白名单用 id，展示层呈现友好名）。
		 * dsh = DSH 自采；其余为 cc-switch 的 app_type。
		 */
		var CLIENT_LABELS = {
			dsh: "DSH",
			claude: "Claude",
			codex: "Codex",
			gemini: "Gemini",
			opencode: "OpenCode",
			grokbuild: "Grok Build",
			pi: "Pi",
			"claude-desktop": "Claude Desktop",
		};
		/** 客户端 id → 展示名；未映射时原样返回。 */
		function clientLabel(id) {
			return CLIENT_LABELS[id] || id;
		}

		/** 供应商展示名映射（数据层保持 id：kimi-coding / deepseek）。 */
		var PROVIDER_LABELS = {
			"kimi-coding": "Kimi For Coding",
			deepseek: "DeepSeek",
			"deepseek-official": "DeepSeek",
			"opencode-go": "OpenCode",
			"cc-switch": "cc-switch",
		};
		/** 供应商（vendor）展示名映射：服务端聚合返回的 vendor id → 供应商名。 */
		var VENDOR_LABELS = {
			deepseek: "DeepSeek",
			minimax: "MiniMax",
			anthropic: "Anthropic",
			openai: "OpenAI",
			google: "Google",
			xai: "xAI",
			mistral: "Mistral",
			opencode: "OpenCode",
			commandcode: "Command Code",
			openrouter: "OpenRouter",
			"vercel-ai-gateway": "Vercel AI Gateway",
			cloudflare: "Cloudflare",
			"github-copilot": "GitHub Copilot",
			"azure-openai": "Azure OpenAI",
			"amazon-bedrock": "Amazon Bedrock",
			huggingface: "Hugging Face",
			groq: "Groq",
			cerebras: "Cerebras",
			nvidia: "NVIDIA",
			together: "Together AI",
			fireworks: "Fireworks AI",
			"cc-switch": "cc-switch",
		};
		/** 供应商名中随语言变化的（中文名/未知）：运行时经 t() 取当前语言文案。 */
		var VENDOR_I18N_KEYS = {
			kimi: "vendor.kimi",
			zhipu: "vendor.zhipu",
			qwen: "vendor.qwen",
			xiaomi: "vendor.xiaomi",
			"ant-ling": "vendor.antling",
			unknown: "vendor.unknown",
		};
		/** 供应商 id → 展示名：先查语言化名（t），再查 vendor 名（服务端聚合已归并），再查 provider 名（原始提供方），未映射原样返回。 */
		function providerLabel(id) {
			var i18nKey = VENDOR_I18N_KEYS[id];
			if (i18nKey) return t(i18nKey);
			return VENDOR_LABELS[id] || PROVIDER_LABELS[id] || id;
		}
		/** 提供方 id → 官网链接（充值 / 续费 / 用量页），仅收录已验证的链接；未收录的提供方不显示按钮。
		 *  值可为字符串（kind 无关）或 { balance, quota }（按量/订阅分别指向不同页面）。
		 *  想改指向直接改这里。 */
		var PROVIDER_URLS = {
			deepseek: "https://platform.deepseek.com/top_up",
			"kimi-coding": { quota: "https://www.kimi.com/code/console?from=kfc_overview_topbar", balance: "https://platform.kimi.com/console/pay" },
			"moonshotai-cn": { quota: "https://www.kimi.com/code/console?from=kfc_overview_topbar", balance: "https://platform.kimi.com/console/pay" },
			moonshotai: { quota: "https://www.kimi.com/code/console?from=kfc_overview_topbar", balance: "https://platform.kimi.com/console/pay" },
			zhipu: "https://bigmodel.cn/coding-plan/personal/overview",
			"zai-coding-cn": "https://bigmodel.cn/coding-plan/personal/overview",
			// zai（按量付费）：充值走智谱支付中心
			zai: "https://bigmodel.cn/finance-center/finance/pay",
			qwen: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview",
			"qwen-token-plan-cn": "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview",
			"qwen-token-plan": "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview",
			minimax: "https://platform.minimaxi.com/subscribe/token-plan",
			xiaomi: { balance: "https://platform.xiaomimimo.com/console/balance", quota: "https://platform.xiaomimimo.com/console/plan-manage" },
			"xiaomi-token-plan-cn": { balance: "https://platform.xiaomimimo.com/console/balance", quota: "https://platform.xiaomimimo.com/console/plan-manage" },
			"xiaomi-token-plan-ams": { balance: "https://platform.xiaomimimo.com/console/balance", quota: "https://platform.xiaomimimo.com/console/plan-manage" },
			"xiaomi-token-plan-sgp": { balance: "https://platform.xiaomimimo.com/console/balance", quota: "https://platform.xiaomimimo.com/console/plan-manage" },
			"opencode-go": "https://opencode.ai/zh/go",
			commandcode: "https://commandcode.ai/billing",
			openrouter: "https://openrouter.ai/settings/credits",
		};
		/** 取提供方官网链接：按 kind 区分（balance=充值页 / quota=续费页）；字符串表项通用；未配置返回空串。 */
		function providerUrl(id, kind) {
			var entry = PROVIDER_URLS[id];
			if (!entry) return "";
			if (typeof entry === "string") return entry;
			return entry[kind] || entry.quota || entry.balance || "";
		}
		/** 提供方 id → 供应商 id（筛选选项按供应商归并；与服务端 provider_mappings 一致）。 */
		var VENDOR_OF = {
			"kimi-coding": "kimi", "moonshotai-cn": "kimi", moonshotai: "kimi",
			deepseek: "deepseek",
			"zai-coding-cn": "zhipu", zai: "zhipu",
			"qwen-token-plan-cn": "qwen", "qwen-token-plan": "qwen",
			"minimax-cn": "minimax", minimax: "minimax",
			"xiaomi-token-plan-cn": "xiaomi", "xiaomi-token-plan-ams": "xiaomi", "xiaomi-token-plan-sgp": "xiaomi", xiaomi: "xiaomi",
			"ant-ling": "ant-ling",
			anthropic: "anthropic",
			openai: "openai", "openai-codex": "openai",
			google: "google", "google-vertex": "google",
			xai: "xai",
			mistral: "mistral",
			"opencode-go": "opencode", opencode: "opencode",
			commandcode: "commandcode",
			openrouter: "openrouter",
			"vercel-ai-gateway": "vercel-ai-gateway",
			"cloudflare-ai-gateway": "cloudflare", "cloudflare-workers-ai": "cloudflare",
			"github-copilot": "github-copilot",
			"azure-openai-responses": "azure-openai",
			"amazon-bedrock": "amazon-bedrock",
			huggingface: "huggingface",
			groq: "groq",
			cerebras: "cerebras",
			nvidia: "nvidia",
			together: "together",
			fireworks: "fireworks",
			"cc-switch": "cc-switch",
			unknown: "unknown",
		};
		/** 提供方 id → 供应商 id；未映射原样返回。 */
		function vendorOf(id) {
			return VENDOR_OF[id] || id;
		}

		/** 服务端 provider_mappings 动态合并（REVIEW #2）：/token-monitor/provider-mappings
		 *  下发全表，合并进 PROVIDER_LABELS / VENDOR_LABELS / VENDOR_OF；失败静默，
		 *  硬编码表（常用 3~4 项）作离线兜底。 */
		function mergeProviderMappings(data) {
			if (!data || !data.mappings) return;
			var mappings = data.mappings;
			for (var pid in mappings) {
				var m = mappings[pid];
				if (m.provider_name) PROVIDER_LABELS[pid] = m.provider_name;
				if (m.vendor) VENDOR_OF[pid] = m.vendor;
			}
			if (data.vendorLabels) {
				for (var v in data.vendorLabels) VENDOR_LABELS[v] = data.vendorLabels[v];
			}
		}
		/** 拉取并合并一次（挂载时调用；静默失败）。 */
		function fetchProviderMappings() {
			fetch("/token-monitor/provider-mappings", { headers: { accept: "application/json" } })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (d) { if (d && d.ok) mergeProviderMappings(d); })
				.catch(function () {});
		}

		/** 模型 id → 友好展示名（硬编码兜底，已查证）。 */

		/** 弹层"↗ 详情"交棒给用量页签的聚焦会话（同模块变量跨组件传递，消费一次即清）。 */
		var usageFocusRequest = null;

		/** USD→CNY 汇率（服务端 sources/overview 接口下发；默认 7.2 兜底）。 */
		var USDUCNY_RATE = 7.2;
		var RATE_FETCHED_AT = 0;

		/** 美元金额展示：中文 × 汇率显示人民币（¥）；英文直接显示美元（$，不做换算）。 */
		function fmtCny(usd) {
			if (typeof usd !== "number" || !isFinite(usd)) return "—";
			if (LANG === "en") {
				if (usd === 0) return "$0";
				if (usd >= 1000) return "$" + Math.round(usd).toLocaleString();
				if (usd >= 1) return "$" + usd.toFixed(2);
				return "$" + usd.toFixed(4);
			}
			var n = usd * USDUCNY_RATE;
			if (n === 0) return "¥0";
			if (n >= 1000) return "¥" + Math.round(n).toLocaleString();
			if (n >= 1) return "¥" + n.toFixed(2);
			return "¥" + n.toFixed(4);
		}

		/* ---- 服务端中文文案 → 英文（展示层适配） ----
		 * 服务端返回的 metrics/headline/error 是中文模板（如 "5小时 82%"、"周用 45%"、
		 * "充值 x · 赠送 y"、"1d 3h 后重置"）。中文界面原样；英文界面按规则表替换。
		 * 规则按"先长后短"排列避免误伤；未命中的原文保留（不空白）。 */
		var SERVER_EN_RULES = [
			[/（(.+?)后重置）/, function (m, p1) { return " (" + String(p1).trim() + " until reset)"; }],
			[/后重置$/, " until reset"],
			[/5小时 /, "5h "],
			[/周用 /, "weekly "],
			[/7天用量/, "7d usage"],
			[/(\d+)分钟用量/, "$1min usage"],
			[/(\d+)小时用量/, "$1h usage"],
			[/频限明细/, "limits"],
			[/人民币账户/, "CNY account"],
			[/([A-Z]{3}) 账户/, "$1 account"],
			[/充值 (.+?) · 赠送 (.+)/, "topped up $1 · granted $2"],
			[/剩余 (.+?) \/ (.+)/, "remaining $1 / $2"],
			[/重置时间/, "reset time"],
			[/状态/, "status"],
			[/端点可用，额度字段未识别（见原始响应）/, "endpoint OK, quota fields unrecognized (see raw response)"],
			[/已连接/, "connected"],
			[/无可用端点/, "no endpoint"],
			[/可用余额/, "available balance"],
			[/可用/, "available"],
			[/^是$/, "yes"],
			[/^否$/, "no"],
			[/未配置 ([A-Z_]+)/, "missing $1"],
			[/额度/, "quota"],
			// —— 余额/套餐类（moonshot / openrouter / minimax / zai）——
			[/账户余额/, "account balance"],
			[/本月消费/, "month spend"],
			[/总消费/, "total spend"],
			[/现金 (.+?) · 代金券 (.+)/, "cash $1 · voucher $2"],
			[/代金券/, "voucher"],
			[/现金/, "cash"],
			[/剩余 /, "remaining "],
			[/重置 /, "reset "],
			[/套餐用量/, "plan usage"],
			// —— Command Code（commandcode 适配新增文案）——
			[/本月用量/, "month usage"],
			[/本月 /, "month "],
			[/^本月$/, "month"],
			[/额外额度（结转）/, "extra credits (carryover)"],
			[/已购 (.+?) · 赠送 (.+)/, "purchased $1 · granted $2"],
			[/^已用 /, "used "],
			[/已用 (.+?) \/ (.+)/, "used $1 / $2"],
		];
		/** 英文模式下把服务端返回的中文展示文案替换为英文；中文/非字符串原样返回。 */
		function locServer(text) {
			if (LANG !== "en" || typeof text !== "string") return text;
			for (var i = 0; i < SERVER_EN_RULES.length; i++) {
				var rule = SERVER_EN_RULES[i];
				text = text.replace(rule[0], rule[1]);
			}
			return text;
		}

		function fmtLatency(ms) {
			if (typeof ms !== "number" || !isFinite(ms)) return "—";
			if (ms >= 60000) return (ms / 60000).toFixed(1) + "min";
			if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
			return Math.round(ms) + "ms";
		}

		/** 平均 TTFT 卡片专用：统一秒，两位小数（null/无效显示 —）。 */
		function fmtLatency3(ms) {
			if (typeof ms !== "number" || !isFinite(ms)) return "—";
			return (ms / 1000).toFixed(2) + "s";
		}

		/** 大数字卡：左标签右数值；color 给出语义色时数值着色 + 同色浅底背景。 */
		function UsageStatCard(props) {
			var cardStyle = S.usageStatCard;
			var valueStyle = Object.assign({}, S.usageStatValue, props.valueStyle || {});
			if (props.color) {
				cardStyle = Object.assign({}, S.usageStatCard, {
					background: props.color.bg,
					borderColor: props.color.border,
				});
				valueStyle.color = props.color.fg;
			}
			return h("div", { style: cardStyle },
				h("span", { style: S.usageStatLabel }, props.label),
				h("span", { style: valueStyle }, props.value));
		}

		/** 语义色调色板：与趋势图序列同色（卡片和图表说同一种颜色语言）。 */
		var STAT_COLORS = {
			neutral: null,
			input:  { fg: "#1a73e8", bg: "rgba(26,115,232,0.08)", border: "rgba(26,115,232,0.25)" },
			cache:  { fg: "#8e4ec6", bg: "rgba(142,78,198,0.08)", border: "rgba(142,78,198,0.25)" },
			output: { fg: "#34a853", bg: "rgba(52,168,83,0.08)", border: "rgba(52,168,83,0.25)" },
			// 费用 = 红（全局费用色），请求次数 = 青蓝（与 TTFT 琥珀区分）
			cost:   { fg: "#e5484d", bg: "rgba(229,72,77,0.08)", border: "rgba(229,72,77,0.25)" },
			requests: { fg: "#20a5ba", bg: "rgba(32,165,186,0.08)", border: "rgba(32,165,186,0.25)" },
			latency:{ fg: "#e8910c", bg: "rgba(232,145,12,0.08)", border: "rgba(232,145,12,0.25)" },
			rate:   { fg: "#0d9488", bg: "rgba(13,148,136,0.08)", border: "rgba(13,148,136,0.25)" },
		};

		/** 时间窗切换按钮组（与设置页下拉共用 WINDOW_OPTIONS）。 */
		function WindowSwitcher(props) {
			return h("div", { style: { display: "inline-flex", gap: "4px" } },
				WINDOW_OPTIONS.map(function (o) {
					var active = o.v === props.value;
					return h("button", {
						key: o.v, type: "button",
						style: active ? Object.assign({}, S.windowBtn, S.windowBtnActive) : S.windowBtn,
						// 阻止鼠标点击聚焦，避免主题 :focus 黑框（键盘 Tab 聚焦不受影响）
						onMouseDown: function (e) { e.preventDefault(); },
						onClick: function () { props.onChange(o.v); },
					}, o.label());
				}));
		}

		/* ---- 使用趋势折线图（echarts） ----
		 * 左轴 token 三序列：总输入 / 缓存命中（浅色面积）/ 输出；右轴费用（红色虚线）。
		 * 时间轴连续铺满窗口（无数据日期补零，由 trend memo 保证）。
		 */

		/** 趋势图序列：左轴 token（新增输入/缓存命中/输出，独立渐变面积），右轴按 metric 切换（费用/请求次数/平均TTFT）。 */
		function trendSeries(metric) {
			return [
				{ key: "input", label: t("trend.series.input"), color: "#1a73e8", axis: "token", stack: true },
				{ key: "cacheRead", label: t("trend.series.cacheRead"), color: "#8e4ec6", axis: "token", stack: true },
				{ key: "output", label: t("trend.series.output"), color: "#34a853", axis: "token", stack: true },
			].concat(metric === "cost"
				? [{ key: "cost", label: t("trend.series.cost"), color: "#e5484d", axis: "cost", dashed: true }]
				: metric === "requests"
					? [{ key: "requests", label: t("trend.series.requests"), color: "#20a5ba", axis: "cost" }]
					: [{ key: "ttft", label: t("trend.series.ttft"), color: "#e8910c", axis: "cost" }]);
		}

		/** hex 颜色加透明度 → rgba()（渐变填充用）。 */
		function alpha(hex, a) {
			var n = parseInt(hex.slice(1), 16);
			return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
		}

		/** 垂直渐变填充描述（ECharts 对象字面量形式，无需 echarts 全局）：上饱和 → 下透明。 */
		function gradientArea(color, top, bottom) {
			return {
				type: "linear", x: 0, y: 0, x2: 0, y2: 1,
				colorStops: [
					{ offset: 0, color: alpha(color, top === undefined ? 0.65 : top) },
					{ offset: 1, color: alpha(color, bottom === undefined ? 0.06 : bottom) },
				],
			};
		}

		/** 轴刻度紧凑 token 格式：中文 万/亿（最多 1 位小数）；英文 K/M/B。 */
		function fmtAxisTokens(n) {
			if (typeof n !== "number" || !isFinite(n) || n <= 0) return "0";
			var trim = function (v) { return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10); };
			if (LANG === "en") {
				if (n >= 1e9) return trim(n / 1e9) + "B";
				if (n >= 1e6) return trim(n / 1e6) + "M";
				if (n >= 1e3) return trim(n / 1e3) + "K";
				return String(Math.round(n));
			}
			if (n >= 1e8) return trim(n / 1e8) + t("unit.hundredMillion").trim();
			if (n >= 1e4) return trim(n / 1e4) + t("unit.tenThousand").trim();
			return String(Math.round(n));
		}

		/** 右轴成本刻度：中文 ¥ + 自适应精度（× 汇率）；英文 $ + 自适应精度（不换算）。 */
		function fmtAxisUsd(n) {
			if (typeof n !== "number" || !isFinite(n) || n <= 0) return LANG === "en" ? "$0" : "¥0";
			if (LANG === "en") return "$" + (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100));
			var c = n * USDUCNY_RATE;
			return "¥" + (c >= 100 ? String(Math.round(c)) : String(Math.round(c * 100) / 100));
		}

		/** 右轴 TTFT 刻度：统一秒，保留三位小数。 */
		function fmtAxisLatency(n) {
			if (typeof n !== "number" || !isFinite(n) || n <= 0) return "0";
			return (n / 1000).toFixed(3) + "s";
		}

		/* ---- 使用趋势折线图（echarts） ----
		 * echarts 随插件分发（lib/util/echarts.min.js），经 Host 路由 /token-monitor/echarts.min.js
		 * 懒加载（只在用量页签挂载时拉一次，localhost 秒载）；平滑折线、双 Y 轴、
		 * axis 十字 tooltip、图例点击显隐均为库内置能力。
		 */

		var echartsPromise = null;
		/** 懒加载 echarts 全局（只注入一次 <script>；失败清空缓存允许下次重试）。 */
		function loadEcharts() {
			if (window.echarts) return Promise.resolve(window.echarts);
			if (echartsPromise) return echartsPromise;
			echartsPromise = new Promise(function (resolve, reject) {
				var s = document.createElement("script");
				s.src = "/token-monitor/echarts.min.js";
				s.onload = function () {
					if (window.echarts) resolve(window.echarts);
					else { echartsPromise = null; reject(new Error("echarts 全局缺失")); }
				};
				s.onerror = function () { echartsPromise = null; reject(new Error("echarts 脚本加载失败")); };
				document.head.appendChild(s);
			});
			return echartsPromise;
		}

		/** 解析 CSS 变量为具体色值（echarts 配置不接受 var()，主题切换后重挂载即刷新）。 */
		function cssVar(name, fallback) {
			var v = "";
			try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (_e) { }
			return v || fallback;
		}

		/** 图表 tooltip 主题基底：深浅外观自适应（菜单背景 + 边框 + 主文字色全走主题变量），
		 *  confine 防溢出卡片；圆角阴影与系统菜单同风格。各图 Object.assign 覆盖 trigger/formatter。 */
		function baseTooltip() {
			return {
				confine: true,
				backgroundColor: cssVar("--dsw-specific-menu", isDark() ? "#2d333b" : "#ffffff"),
				borderColor: cssVar("--dsw-alias-border-l2", "rgba(128,128,128,0.25)"),
				textStyle: { color: cssVar("--dsw-alias-label-primary", isDark() ? "#e6e6e6" : "#1a1a1a"), fontSize: 11 },
				extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.18);padding:6px 10px;line-height:18px;",
			};
		}
		/** tooltip 头部（日期/区间/供应商名）：灰白（深色）/ 中灰（浅色）+ 加粗。 */
		function tooltipHead(text) {
			var c = isDark() ? "#c9ced4" : cssVar("--dsw-alias-label-secondary", "#5a626c");
			return '<div style="color:' + c + ';font-size:11px;font-weight:600;margin-bottom:2px">' + text + '</div>';
		}
		/** tooltip 色块：统一圆角小方块（趋势/柱图同款，替代 ECharts 默认圆点）。 */
		function tooltipSwatch(color) {
			return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + color + ';margin-right:4px"></span>';
		}

		/** 从元素向上找第一个非透明的计算背景色（任何主题/皮肤下的"真背景"）。
		 *  用于热力图格子缝隙色：缝隙 = 背景 → 像素级融入，不猜变量名/层级。 */
		function computedBg(el) {
			var node = el;
			while (node && node !== document.documentElement) {
				try {
					var bg = getComputedStyle(node).backgroundColor;
					if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
				} catch (_e) { /* 忽略 */ }
				node = node.parentElement;
			}
			return isDark() ? "#1a1a1a" : "#ffffff";
		}

		/**
		 * 桶区间标签：桶标签是"结束时刻"（如 15:30），给定间隔 step 分钟反推起始
		 * （15:00~15:30）。支持 "HH:MM" 与跨天 "MM-DD HH:MM" 两种格式；
		 * 起始跨天回绕时自动换日期前缀，保持可读。
		 */
		function trendRangeLabel(label, stepMin) {
			if (!stepMin) return String(label);
			var m = /^(?:(\d{2})-(\d{2})\s+)?(\d{2}):(\d{2})$/.exec(String(label));
			if (!m) return String(label);
			var pad = function (x) { return String(x).padStart(2, "0"); };
			var fmt = function (d) {
				var hhmm = pad(d.getHours()) + ":" + pad(d.getMinutes());
				var today = new Date();
				if (d.getDate() !== today.getDate() || d.getMonth() !== today.getMonth()) {
					return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hhmm;
				}
				return hhmm;
			};
			// 结束时刻：有日期前缀用它，否则按今天解析
			var end = m[1]
				? new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4])
				: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), +m[3], +m[4]);
			var start = new Date(end.getTime() - stepMin * 60000);
			return fmt(start) + "~" + fmt(end);
		}

		/** 趋势图 option：token 序列走左轴，右轴按 metric 切换（费用/请求次数/平均TTFT）。 */
		function buildTrendOption(data, metric) {
			var axisColor = cssVar("--dsw-alias-label-tertiary", "#9aa0a6");
			var gridColor = cssVar("--dsw-alias-border-l1", "rgba(128,128,128,0.18)");
			var showSymbol = false; // 隐藏数据圆点，只留线条与渐变面积
			var rightFmt = metric === "cost" ? fmtAxisUsd : (metric === "requests" ? fmtAxisTokens : fmtAxisLatency);
			// seriesName → 序列 key（语言无关判断：seriesName 随语言变化，key 稳定）
			var seriesKeyOf = {};
			var seriesList = trendSeries(metric);
			for (var si = 0; si < seriesList.length; si++) seriesKeyOf[seriesList[si].label] = seriesList[si].key;
			// 桶间隔（分钟）：UsageView 在当天窗口把服务端 step 附在数组上；tooltip 头部显示区间
			var stepMin = data.step || 0;
			return {
				animationDuration: 300,
				// containLabel: 轴标签宽度计入 grid，窗口窄时标签也不会被裁掉
				grid: { left: 12, right: 12, top: 16, bottom: 34, containLabel: true },
				legend: {
					icon: "diamond", itemWidth: 10, itemHeight: 10, itemGap: 16,
					bottom: 0,
					textStyle: { fontSize: 11, color: axisColor },
				},
				tooltip: Object.assign(baseTooltip(), {
					trigger: "axis",
					formatter: function (params) {
						if (!params || !params.length) return "";
						// 头部：有 step 显示桶区间（15:00~15:30），否则原样显示刻度
						var lines = [tooltipHead(trendRangeLabel(params[0].axisValue, stepMin))];
						var total = 0;
						for (var i = 0; i < params.length; i++) {
							var p = params[i];
							var key = seriesKeyOf[p.seriesName] || p.seriesName;
							var v = key === "cost" ? fmtCny(p.value)
								: key === "ttft" ? fmtAxisLatency(p.value)
									: fmtTokens(p.value);
							// 色块统一自绘圆角块（替代 ECharts 默认圆点 marker）
							lines.push("<div>" + tooltipSwatch(p.color) + " " + p.seriesName + "：" + v + "</div>");
							// 合计只累加左轴 token 序列（右轴 metric 不计）
							var def = seriesList[p.seriesIndex];
							if (def && def.axis === "token") total += p.value || 0;
						}
						lines.push('<div style="border-top:1px solid ' + cssVar("--dsw-alias-border-l2", "rgba(128,128,128,0.25)") + ';margin-top:4px;padding-top:4px">'
							+ t("trend.tooltipTotal") + "：" + fmtTokens(total) + "</div>");
						return lines.join("");
					},
				}),
				xAxis: {
					type: "category", boundaryGap: false,
					data: data.map(function (d) { return d.day; }),
					// 小时序号（"1h"~"24h"）原样显示；日期桶截掉年份
					axisLabel: { fontSize: 10, color: axisColor, formatter: function (v) { var s = String(v); return /^\d{4}-/.test(s) ? s.slice(5) : s; } },
					axisLine: { lineStyle: { color: gridColor, type: "solid" } },
					axisTick: { show: false },
				},
				yAxis: [
					{
						type: "value",
						axisLabel: { fontSize: 10, color: axisColor, formatter: fmtAxisTokens },
						axisLine: { show: true, lineStyle: { color: gridColor, type: "solid" } },
						axisTick: { show: true, lineStyle: { color: gridColor } },
						splitLine: { lineStyle: { color: gridColor, type: "dashed" } },
					},
					{
						type: "value", position: "right",
						axisLabel: { fontSize: 10, color: axisColor, formatter: rightFmt },
						axisLine: { show: true, lineStyle: { color: gridColor } },
						axisTick: { show: true, lineStyle: { color: gridColor } },
						splitLine: { show: false },
					},
				],
				series: trendSeries(metric).map(function (s) {
					var item = {
						name: s.label, type: "line", smooth: true,
						showSymbol: showSymbol, symbolSize: 5,
						lineStyle: { width: 1, color: s.color, type: s.dashed ? "dashed" : "solid" },
						itemStyle: { color: s.color },
						emphasis: { focus: "series" },
						yAxisIndex: s.axis === "cost" ? 1 : 0,
						data: data.map(function (d) { return d[s.key] || 0; }),
					};
					// token 序列：独立渐变面积（不堆叠——缓存命中占 99% 时堆叠会把小构成压成细线；
					// 各从 0 起、半透明叠加，三层都可见）；右轴 metric 也带浅渐变面积
					if (s.stack) {
						item.areaStyle = { color: gradientArea(s.color) };
					} else {
						item.areaStyle = { color: gradientArea(s.color, 0.4, 0.04) };
					}
					return item;
				}),
			};
		}

		/** 通用 echarts 容器：懒加载、init 一次、option 变化 setOption、容器缩放 resize、卸载 dispose。
		 *  props: option（echarts option 对象）、serialized（数据序列化串，作为刷新依赖）、height。 */
		function EChart(props) {
			var boxRef = React.useRef(null);
			var chartRef = React.useRef(null);
			var _st = React.useState("loading"), st = _st[0], setSt = _st[1];

			React.useEffect(function () {
				if (!props.option) return;
				var disposed = false;
				var ro = null;
				loadEcharts().then(function (echarts) {
					if (disposed || !boxRef.current) return;
					var chart = chartRef.current;
					if (!chart) {
						chart = echarts.init(boxRef.current, null, { renderer: "svg" });
						chartRef.current = chart;
					}
					// notMerge：全量替换，避免图例点击隐藏等交互状态跨刷新残留
					chart.setOption(props.option, { notMerge: true });
					// 事件透传（旭日图节点点击下钻等）；每次 option 刷新重绑，避免重复监听
					if (props.onClick) {
						chart.off("click");
						chart.on("click", props.onClick);
					}
					setSt("ready");
					if (typeof ResizeObserver !== "undefined") {
						ro = new ResizeObserver(function () { chart.resize(); });
						ro.observe(boxRef.current);
					}
				}).catch(function () { if (!disposed) setSt("error"); });
				return function () { disposed = true; if (ro) ro.disconnect(); };
			}, [props.serialized]);

			// 组件卸载时销毁 echarts 实例（与数据 effect 分离，避免数据刷新误销毁）
			React.useEffect(function () {
				return function () {
					if (chartRef.current) { chartRef.current.dispose(); chartRef.current = null; }
				};
			}, []);

			return h("div", null,
				h("div", { ref: boxRef, style: { width: "100%", height: (props.height || 300) + "px" } }),
				st === "loading" ? h("div", { style: S.muted }, t("chart.loading")) : null,
				st === "error" ? h("div", { style: S.muted }, t("chart.loadFailed")) : null);
		}

		/** 使用趋势：折线图（费用 / 总输入 / 缓存命中 / 输出）。 */
		function DailyTrend(props) {
			var _m = React.useState("requests"), metric = _m[0], setMetric = _m[1];
			// 外观切换时重算 option（tooltip 配色/轴色随主题）
			var _themeRev = React.useState(0), themeRev = _themeRev[0], setThemeRev = _themeRev[1];
			React.useEffect(function () {
				function onTheme() { setThemeRev(function (v) { return v + 1; }); }
				window.addEventListener("token-monitor:theme-change", onTheme);
				return function () { window.removeEventListener("token-monitor:theme-change", onTheme); };
			}, []);
			var data = props.data || [];
			// serialized 含 LANG：语言切换时重建 option（图例/标签随语言刷新）；
			// step（桶间隔）单独取——数组附加属性 JSON 序列化时会丢，须显式纳入依赖
			var stepMin = data.step || 0;
			// dark 编入 serialized：外观切换时 themeRev 触发渲染 → isDark() 变 → serialized 变
			// → EChart 依赖 serialized 重建（tooltip 配色/轴色即时跟随主题）
			var serialized = JSON.stringify({ d: data, m: metric, l: LANG, s: stepMin, dark: isDark() });
			var option = React.useMemo(function () {
				return data.length ? buildTrendOption(data, metric) : null;
			}, [serialized, themeRev]);
			if (!data.length) return h("div", { style: S.muted }, t("usage.noWindowData"));
			var TABS = [["requests", t("trend.series.requests")], ["cost", t("trend.series.cost")], ["ttft", t("trend.series.ttft")]];
			return h("div", null,
				// 标题行：仿柱状图——标题 + 说明 + 右侧右轴切换按钮
				h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
					h("div", { style: S.usageCardTitle }, t("trend.title")),
					h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
						t("trend.note")),
					h("span", { style: { flex: 1 } }),
					h("div", { style: { display: "inline-flex", gap: "4px" } },
						TABS.map(function (t) {
							var active = t[0] === metric;
							return h("button", {
								key: t[0], type: "button",
								style: active ? Object.assign({}, S.windowBtn, S.windowBtnActive) : S.windowBtn,
								onMouseDown: function (e) { e.preventDefault(); },
								onClick: function () { setMetric(t[0]); },
							}, t[1]);
						}))),
				h(EChart, { option: option, serialized: serialized, height: 300 }));
		}

		/* ---- 消耗分布柱状图：X=供应商、按模型分柱；左轴 token 消耗，右轴费用/次数可切 ---- */

		/** 颜色变浅：与白色按比例混合（ratio 0.5 = 浅一半）。 */
		function lighten(hex, ratio) {
			var n = parseInt(hex.slice(1), 16);
			var r = n >> 16, g = (n >> 8) & 255, b = n & 255;
			var mix = function (c) { return Math.round(c + (255 - c) * ratio); };
			var to2 = function (c) { return c.toString(16).padStart(2, "0"); };
			return "#" + to2(mix(r)) + to2(mix(g)) + to2(mix(b));
		}

		/** 供应商色系表：每个 vendor 一个基础色（色相），该供应商下模型按 token 消耗降序从深到浅。
		 *  DeepSeek 蓝为主色（#3964fe，不可动）；色系覆盖 红/橙/绿/青/蓝/紫/品红/灰，
		 *  每色系最多 2 个 vendor、用明度区分（如 kimi 紫 vs ant-ling 深紫）。
		 *  模型色只用于左柱（token 堆叠），右柱功能色（请求次数青/费用红）左右分离不冲突。 */
		var VENDOR_COLORS = {
			deepseek: "#3964fe",          // 蓝（主色，固定）
			google: "#1d4ed8",            // 深蓝（与 deepseek 区分：更暗）
			kimi: "#9333ea",              // 紫
			"ant-ling": "#6d28d9",        // 深紫（与 kimi 区分：更暗）
			zhipu: "#92400e",             // 深琥珀
			xiaomi: "#f97316",            // 橙（与 zhipu 区分：更亮）
			anthropic: "#b91c1c",         // 深红
			mistral: "#be123c",           // 玫红
			qwen: "#059669",              // 翠绿
			openai: "#16a34a",            // 绿
			minimax: "#0f766e",           // 深青绿
			opencode: "#0e7490",          // 深青蓝（与 minimax 区分）
			openrouter: "#c026d3",        // 紫红
			"github-copilot": "#a21caf",  // 深品红（与 openrouter 区分）
			xai: "#52525b",               // 灰
			unknown: "#9ca3af",           // 灰
		};
		var MODEL_BAR_PALETTE = ["#1a73e8", "#8e4ec6", "#34a853", "#e8910c", "#0d9488", "#6f42c1", "#20a5ba", "#5c7cfa"];

		/** vendor → 基础色：色系表优先；未配置的从调色板哈希取（同名永远同色）。 */
		function vendorColor(vendor) {
			if (VENDOR_COLORS[vendor]) return VENDOR_COLORS[vendor];
			var hash = 0;
			var s = String(vendor || "unknown");
			for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
			return MODEL_BAR_PALETTE[Math.abs(hash) % MODEL_BAR_PALETTE.length];
		}

		/**
		 * 模型取色：vendor 基础色 + shade 变浅（0=最深，1=最白）。
		 * shade 由调用方按 token 消耗降序排名提供（token 最多 = 0 最深，最少 = 最大浅）。
		 */
		function modelBarColor(vendor, shade) {
			return lighten(vendorColor(vendor), typeof shade === "number" ? Math.min(0.85, Math.max(0, shade)) : 0.3);
		}

		/** 堆叠柱状图 option：每供应商两根柱——左柱按模型堆叠 token（左轴），右柱合计指标（右轴）。 */
		function buildModelBarsOption(data, metric) {
			var axisColor = cssVar("--dsw-alias-label-tertiary", "#9aa0a6");
			var gridColor = cssVar("--dsw-alias-border-l1", "rgba(128,128,128,0.18)");
			var rightFmt = metric === "cost" ? fmtAxisUsd : fmtAxisTokens;
			// 右柱名称随语言（t），判断用 metric（语言无关）；tooltip 里 seriesName 可能随语言变化
			var rightLabel = metric === "cost" ? t("trend.series.cost") : t("trend.series.requests");
			var rightKey = metric === "cost" ? "cost" : "requests";
			var series = [];
			// 左柱按段着色：每个堆叠段用它【所在柱】的 vendor 色系 + 该模型在该 vendor 内的
			// token 降序排名分深浅——柱内永远同族，跨供应商调用的模型在各柱各归各色，
			// 颜色与用量多少无关（修复"模型 vendor 后写覆盖导致 DeepSeek 柱串青蓝色"）。
			// 排名直接由 token 矩阵构建（不依赖 modelVendor 映射）
			var vendorRank = {}; // vendor -> { arr: [model 按 token 降序], model: rank }
			for (var vk in data.tokens) {
				var arr = Object.keys(data.tokens[vk]).sort(function (a, b) {
					return (data.tokens[vk][b] || 0) - (data.tokens[vk][a] || 0);
				});
				vendorRank[vk] = { arr: arr };
				for (var vi2 = 0; vi2 < arr.length; vi2++) vendorRank[vk][arr[vi2]] = vi2;
			}
			/** (vendor, model) → 段色：vendor 基础色 + 该 vendor 内排名变浅。 */
			function segmentColor(vendor, m) {
				var info = vendorRank[vendor];
				var rank = info && info[m] !== undefined ? info[m] : 0;
				var total = info ? info.arr.length : 1;
				var shade = total > 1 ? (rank / (total - 1)) * 0.7 : 0;
				return modelBarColor(vendor, shade);
			}
			/** 图例色：模型首个出现的供应商的段色（图例一行一模型，仅作标识）。 */
			function legendColor(m) {
				for (var pi = 0; pi < data.providers.length; pi++) {
					var p = data.providers[pi];
					if (data.tokens[p] && data.tokens[p][m]) return segmentColor(p, m);
				}
				return modelBarColor("unknown", 0.3);
			}
			for (var i = 0; i < data.models.length; i++) {
				(function (mi) {
					var m = data.models[mi];
					series.push({
						name: m, type: "bar", stack: "tokens", yAxisIndex: 0, barMaxWidth: 36,
						// 逐段求值：params.name = 该段所在柱的 vendor id
						itemStyle: { color: function (params) { return segmentColor(params.name, m); } },
						data: data.providers.map(function (p) { return (data.tokens[p] && data.tokens[p][m]) || 0; }),
					});
				})(i);
			}
			// 右柱：供应商合计指标（stack=metric）；费用用红色（与趋势图费用虚线同色），次数用琥珀（与趋势图请求次数同色）
			series.push({
				name: rightLabel, type: "bar", stack: "metric", yAxisIndex: 1, barMaxWidth: 36,
				itemStyle: { color: metric === "cost" ? "#e5484d" : "#20a5ba" },
				data: data.providers.map(function (p) { return data.metricTotals[p] || 0; }),
			});
			return {
				animationDuration: 300,
				grid: { left: 12, right: 12, top: 16, bottom: 34, containLabel: true },
				legend: {
					icon: "roundRect", itemWidth: 12, itemHeight: 12, itemGap: 14,
					bottom: 0, type: "scroll",
					textStyle: { fontSize: 11, color: axisColor },
					// 逐段着色后系列色是函数，图例色块需显式给（模型取首个出现柱的段色；右柱指标用系列色）
					data: data.models.map(function (m) {
						return { name: m, itemStyle: { color: legendColor(m) } };
					}).concat([{ name: rightLabel }]),
				},
				tooltip: Object.assign(baseTooltip(), {
					trigger: "axis",
					axisPointer: { type: "shadow" },
					formatter: function (params) {
						if (!params || !params.length) return "";
						// params[0].name = 该柱的 vendor id（xAxis data 用原始 id，标签层映射展示名）
						var vendorId = params[0].name;
						var lines = [tooltipHead(providerLabel(vendorId))];
						// 完整模型构成（含被 Top8 归入"其他"的模型）：vendorModels[vendor] = [{model, tokens}]
						var vms = data.vendorModels && data.vendorModels[vendorId];
						var sumTokens = 0;
						if (vms && vms.length) {
							for (var vi = 0; vi < vms.length; vi++) {
								// 色块与柱内段一致：本柱 vendor 色系 + 该模型在本 vendor 内排名（vi 即排名）
								var shade2 = vms.length > 1 ? (vi / (vms.length - 1)) * 0.7 : 0;
								lines.push("<div>" + tooltipSwatch(modelBarColor(vendorId, shade2))
									+ vms[vi].model + "：" + fmtTokens(vms[vi].tokens) + "</div>");
								sumTokens += vms[vi].tokens || 0;
							}
						}
						// 右侧合计指标（费用/请求次数）
						for (var i = 0; i < params.length; i++) {
							var p = params[i];
							if (p.seriesName === rightLabel) {
								lines.push("<div>" + tooltipSwatch(p.color) + " " + p.seriesName + "："
									+ (rightKey === "cost" ? fmtCny(p.value) : p.value + t("prov.times")) + "</div>");
								break;
							}
						}
						// 累计行放最底（与趋势图同序）：该供应商柱内全部模型 token 之和
						if (vms && vms.length) {
							lines.push('<div style="border-top:1px solid ' + cssVar("--dsw-alias-border-l2", "rgba(128,128,128,0.25)") + ';margin-top:4px;padding-top:4px">'
								+ t("bars.tooltipTotal") + "：" + fmtTokens(sumTokens) + "</div>");
						}
						return lines.join("");
					},
				}),
				xAxis: {
					// 数据层是供应商 vendor id（tooltip 据此查 vendorModels），标签层映射展示名
					type: "category", data: data.providers,
					axisLabel: { fontSize: 11, color: axisColor, formatter: providerLabel },
					axisLine: { lineStyle: { color: gridColor } },
					axisTick: { show: false },
				},
				yAxis: [
					{
						type: "value",
						axisLabel: { fontSize: 10, color: axisColor, formatter: fmtAxisTokens },
						axisLine: { show: true, lineStyle: { color: gridColor } },
						axisTick: { show: true, lineStyle: { color: gridColor } },
						splitLine: { lineStyle: { color: gridColor, type: "dashed" } },
					},
					{
						type: "value", position: "right",
						axisLabel: { fontSize: 10, color: axisColor, formatter: rightFmt },
						axisLine: { show: true, lineStyle: { color: gridColor } },
						axisTick: { show: true, lineStyle: { color: gridColor } },
						splitLine: { show: false },
					},
				],
				series: series,
			};
		}

		/** 消耗分布卡：X=供应商、按模型分组柱；左轴 token，右轴 费用/请求次数 切换。
		 *  聚合（供应商排序/模型 Top8/矩阵）已由服务端完成，这里只按 metric 选右轴合计。 */
		function ModelBarsView(props) {
			var _m = React.useState("requests"), metric = _m[0], setMetric = _m[1];
			// 外观切换时重算 option（tooltip 配色/轴色随主题）
			var _themeRev = React.useState(0), themeRev = _themeRev[0], setThemeRev = _themeRev[1];
			React.useEffect(function () {
				function onTheme() { setThemeRev(function (v) { return v + 1; }); }
				window.addEventListener("token-monitor:theme-change", onTheme);
				return function () { window.removeEventListener("token-monitor:theme-change", onTheme); };
			}, []);

			var src = props.data || {};
			var data = React.useMemo(function () {
				if (!src.providers || !src.providers.length) return null;
				var metricTotals = {};
				var pick = metric === "cost" ? src.costs : src.requests;
				for (var i = 0; i < src.providers.length; i++) {
					var p = src.providers[i];
					metricTotals[p] = pick[p] || 0;
				}
				return { providers: src.providers, models: src.models, tokens: src.tokens || {}, metricTotals: metricTotals, vendorModels: src.vendorModels, modelVendor: src.modelVendor };
			}, [src, metric]);

			var serialized = JSON.stringify({ d: data, m: metric, l: LANG, dark: isDark() });
			var option = React.useMemo(function () {
				return data && data.providers.length ? buildModelBarsOption(data, metric) : null;
			}, [serialized, themeRev]);

			if (!data || !data.providers.length) return h("div", { style: S.muted }, t("usage.noWindowData"));

			var TABS = [["requests", t("trend.series.requests")], ["cost", t("trend.series.cost")]];
			return h("div", null,
				h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
					h("div", { style: S.usageCardTitle }, t("prov.title")),
					h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
						t("prov.note")),
					h("span", { style: { flex: 1 } }),
					h("div", { style: { display: "inline-flex", gap: "4px" } },
						TABS.map(function (t) {
							var active = t[0] === metric;
							return h("button", {
								key: t[0], type: "button",
								style: active ? Object.assign({}, S.windowBtn, S.windowBtnActive) : S.windowBtn,
								onMouseDown: function (e) { e.preventDefault(); },
								onClick: function () { setMetric(t[0]); },
							}, t[1]);
						}))),
				h(EChart, { option: option, serialized: serialized, height: 320 }));
		}

		/* ---- 消耗热力（GitHub 日历风：每格一天，色深=当天 Token 消耗） ---- */

		/** 两色线性插值（t 0→1），供色阶生成。 */
		function mixHex(c1, c2, t) {
			var a = parseInt(c1.slice(1), 16), b = parseInt(c2.slice(1), 16);
			var ch = function (shift) {
				return Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t);
			};
			var to2 = function (c) { return c.toString(16).padStart(2, "0"); };
			return "#" + to2(ch(16)) + to2(ch(8)) + to2(ch(0));
		}

		/** 热力图色板（零值 + 非零 5 档）：浅色"多=更深"，深色"多=更亮"（GitHub 深色同款）。
		 *  分位数分桶不变，仅按外观切换色板。 */
		var HEAT_COLORS_LIGHT = (function () {
			var arr = ["#ebedf0"]; // 零值浅灰
			for (var i = 0; i < 5; i++) arr.push(mixHex("#c9d6fe", "#3964fe", i / 4));
			return arr;
		})();
		var HEAT_COLORS_DARK = [
			"#2d333b",
			// 低端哑蓝不发光 → 高端深饱和蓝；最高档与次高档之间留明显跳差
			"#9fb0ea", "#8aa1f2", "#7493fa", "#5e85fc", "#2547e0",
		];
		function heatColors() { return isDark() ? HEAT_COLORS_DARK : HEAT_COLORS_LIGHT; }

		/** 日历热力图 option：calendar 坐标 + heatmap 系列，piecewise 六级（0 + 5）。
		 *  分桶走 GitHub 式分位数：非零天按 token 排序，阈值取 20/40/60/80% 位置值，
		 *  每档约 20% 活跃天——峰值只是普通成员，全年节奏恒定可见。
		 *  bgColor：格子缝隙色（= 容器真背景，由调用方实测传入）。 */
		function buildCalendarOption(agg, bgColor) {
			var dayList = agg.dayList, byDay = agg.byDay;
			var axisColor = cssVar("--dsw-alias-label-tertiary", "#9aa0a6");
			// 分位数阈值：非零值升序，20/40/60/80% 位置
			var vals = [];
			for (var day in byDay) {
				var t0 = byDay[day].tokens || 0;
				if (t0 > 0) vals.push(t0);
			}
			vals.sort(function (a, b) { return a - b; });
			var qOf = function (p) {
				return vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 1;
			};
			var t1 = qOf(0.2), t2 = qOf(0.4), t3 = qOf(0.6), t4 = qOf(0.8);
			var HC = heatColors();
			return {
				animationDuration: 0,
				tooltip: Object.assign(baseTooltip(), {
					formatter: function (p) {
						var d = p.data[2] || {};
						return p.data[0] + " · " + (d.requests || 0) + t("prov.times") + " · " + fmtTokens(p.data[1]);
					},
				}),
				visualMap: {
					show: false, type: "piecewise", dimension: 1,
					pieces: [
						{ value: 0, color: HC[0] },
						{ gt: 0, lte: t1, color: HC[1] },
						{ gt: t1, lte: t2, color: HC[2] },
						{ gt: t2, lte: t3, color: HC[3] },
						{ gt: t3, lte: t4, color: HC[4] },
						{ gt: t4, color: HC[5] },
					],
				},
				calendar: {
					top: 26, left: 44, right: 12, bottom: 4,
					cellSize: [12, 12],
					range: [agg.rangeStart, agg.rangeEnd],
					orient: "horizontal",
					splitLine: { show: false },
					itemStyle: {
						// 底层日格子的填充与描边都 = 容器真背景（实测）：
						// 线条真身是默认浅色填充从系列 rect 边缘透出，不是边框——两层都盖成背景色才融入
						color: bgColor || cssVar("--dsw-alias-bg-base", isDark() ? "#1a1a1a" : "#ffffff"),
						borderColor: bgColor || cssVar("--dsw-alias-bg-base", isDark() ? "#1a1a1a" : "#ffffff"),
						borderWidth: 2,
					},
					dayLabel: { nameMap: [t("heat.day0"), t("heat.day1"), t("heat.day2"), t("heat.day3"), t("heat.day4"), t("heat.day5"), t("heat.day6")], fontSize: 10, color: axisColor, firstDay: 1 },
					monthLabel: {
						fontSize: 10, color: axisColor,
						// 补周末跨月的那个月份标签隐藏（如尾部跨进 2026-09 时不显示它）
						formatter: function (info) {
							var mm = String((info && (info.MM !== undefined ? info.MM : info.M)) || "").padStart(2, "0");
							var ym = info && info.yyyy !== undefined ? info.yyyy + "-" + mm : mm;
							// 头部补齐跨进的上月、尾部补齐跨进的下月：标签都隐藏
							return (ym === agg.overflowYM || ym === agg.leadingYM) ? "" : ym;
						},
					},
					yearLabel: { show: false },
				},
				series: [{
					type: "heatmap", coordinateSystem: "calendar",
					// 圆角要加在系列上：格子由 heatmap 系列绘制，calendar 的 itemStyle 只管底层背景
					itemStyle: { borderRadius: 2 },
					data: dayList.map(function (day) {
						var d = byDay[day];
						return [day, d ? d.tokens : 0, { requests: d ? d.requests : 0 }];
					}),
				}],
			};
		}

		/** 消耗热力卡：近 365 天，不受筛选条件影响。
		 *  按天聚合与日期序列已由服务端完成（/usage/calendar），这里只消费渲染。 */
		function CalendarHeatmap(props) {
			// 服务端返回 { byDay, dayList, maxTok, rangeStart, rangeEnd, overflowYM, leadingYM }
			var agg = props.rows || { byDay: {}, dayList: [], maxTok: 0, rangeStart: "", rangeEnd: "", overflowYM: "", leadingYM: "" };

			// 外观切换（theme/change）时重算色板：浅色/深色两套热力色
			var _themeRev = React.useState(0), themeRev = _themeRev[0], setThemeRev = _themeRev[1];
			React.useEffect(function () {
				function onTheme() { setThemeRev(function (v) { return v + 1; }); }
				window.addEventListener("token-monitor:theme-change", onTheme);
				return function () { window.removeEventListener("token-monitor:theme-change", onTheme); };
			}, []);

			// 格子缝隙色：实测容器真背景（挂载 + 外观切换时重新测量）
			var boxRef = React.useRef(null);
			var _bg = React.useState(""), bg = _bg[0], setBg = _bg[1];
			React.useEffect(function () {
				if (boxRef.current) setBg(computedBg(boxRef.current));
			}, [themeRev]);

			var serialized = JSON.stringify({ b: agg.byDay, l: LANG, d: isDark(), g: bg });
			var option = React.useMemo(function () {
				return buildCalendarOption(agg, bg);
			}, [serialized, themeRev]);

			var legendColors = heatColors();

			return h("div", null,
				h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
					h("div", { style: S.usageCardTitle }, t("heat.title")),
					h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
						t("heat.note")),
					h("span", { style: { flex: 1 } }),
					// GitHub 风 少→多 图例
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary)" } },
						t("heat.low"),
						legendColors.map(function (c, i) {
							return h("span", { key: i, style: { width: "10px", height: "10px", borderRadius: "2px", background: c } });
						}),
						t("heat.high"))),
				h("div", { ref: boxRef },
					h(EChart, { option: option, serialized: serialized, height: 168 })));
		}

		/** 时间列格式：完整 yyyy-MM-dd HH:mm:ss。 */
		function fmtRecordTime(ms) {
			var d = new Date(ms);
			var pad = function (x) { return String(x).padStart(2, "0"); };
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
				+ " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
		}

		/** 通用分页条（请求记录 / 使用排行共用）：左总条数 + 页码序列（缺口 …）+
		 *  上/下页箭头 + 跳页输入 + 每页条数下拉 + 跳转按钮；样式与请求记录原分页一致。 */
		function Pager(props) {
			var page = props.page;
			var totalPages = props.totalPages;
			var pageSize = props.pageSize;
			var _goto = React.useState(""), gotoVal = _goto[0], setGoto = _goto[1];
			var _gotoErr = React.useState(false), gotoErr = _gotoErr[0], setGotoErr = _gotoErr[1];

			// 页码序列：首页 1-3、当前页附近、末页 3 个，缺口用 …（1 2 3 … 169 170 171 风格）。
			// 首三位也以 totalPages 为上界——总页数不足时绝不显示不存在的页码
			// （曾硬编码 {1,2,3}，1~2 页数据也会多出假页码）。
			function pageItems() {
				var set = {};
				for (var i = 1; i <= 3 && i <= totalPages; i++) set[i] = 1;
				for (var d = -1; d <= 1; d++) {
					var p = page + d;
					if (p >= 1 && p <= totalPages) set[p] = 1;
				}
				for (var t = totalPages - 2; t <= totalPages; t++) if (t >= 1) set[t] = 1;
				var nums = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
				var items = [];
				var prev = 0;
				for (var i = 0; i < nums.length; i++) {
					if (prev && nums[i] - prev > 1) items.push("…");
					items.push(nums[i]);
					prev = nums[i];
				}
				return items;
			}

			// 校验：只允许输入数字；跳转时页码必须存在于 1..totalPages，否则红框提示不跳转
			function jump() {
				var n = parseInt(gotoVal, 10);
				if (gotoVal !== "" && isFinite(n) && n >= 1 && n <= totalPages) {
					props.onPage(n);
					setGoto("");
					setGotoErr(false);
				} else {
					setGotoErr(true);
				}
			}

			return h("div", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", marginTop: "12px" } },
				props.totalText ? h("span", null, props.totalText) : null,
				h("span", { style: { flex: 1 } }),
				h("button", {
					type: "button",
					// inline-flex 下高度由内容撑：文字按钮 26px（行高18+padding6+border2），
					// svg 只有 10px，必须显式给 26px 才能与页码按钮等高；
					// box-sizing 固定 border-box，整排（箭头/页码/输入/下拉/跳转）统一 26px
					style: Object.assign({}, S.windowBtn, { minWidth: "26px", height: "26px", padding: "3px 6px", boxSizing: "border-box" }),
					disabled: page <= 1,
					onMouseDown: function (e) { e.preventDefault(); },
					onClick: function () { props.onPage(Math.max(1, page - 1)); },
				}, h("svg", {
					width: "6", height: "10", viewBox: "0 0 6 10",
					fill: "none", stroke: "currentColor", strokeWidth: "1.5",
					strokeLinecap: "round", strokeLinejoin: "round",
				}, h("path", { d: "M5 1L1 5l4 4" }))),
				pageItems().map(function (item, i) {
					if (item === "…") return h("span", { key: "e" + i }, "…");
					var active = item === page;
					return h("button", {
						key: item, type: "button",
						// 页码按钮也固定 minWidth + 26px（border-box），与箭头/输入/下拉/跳转整排等高
						style: active
							? Object.assign({}, S.windowBtn, { minWidth: "26px", height: "26px", padding: "3px 6px", boxSizing: "border-box" }, S.windowBtnActive)
							: Object.assign({}, S.windowBtn, { minWidth: "26px", height: "26px", padding: "3px 6px", boxSizing: "border-box" }),
						onMouseDown: function (e) { e.preventDefault(); },
						onClick: function () { props.onPage(item); },
					}, String(item));
				}),
				h("button", {
					type: "button",
					style: Object.assign({}, S.windowBtn, { minWidth: "26px", height: "26px", padding: "3px 6px", boxSizing: "border-box" }),
					disabled: page >= totalPages,
					onMouseDown: function (e) { e.preventDefault(); },
					onClick: function () { props.onPage(Math.min(totalPages, page + 1)); },
				}, h("svg", {
					width: "6", height: "10", viewBox: "0 0 6 10",
					fill: "none", stroke: "currentColor", strokeWidth: "1.5",
					strokeLinecap: "round", strokeLinejoin: "round",
				}, h("path", { d: "M1 1l4 4-4 4" }))),
				h("input", {
					// windowBtn 默认左右 padding 10px，44px 定宽下内容区仅剩 ~22px，
					// "页码"两个 12px 汉字放不下被裁——收窄为 6px（内容区 ~30px），占位与数字完整显示
					style: Object.assign({}, S.windowBtn, { width: "44px", padding: "3px 6px", textAlign: "center", outline: "none" },
						gotoErr ? { borderColor: "var(--dsw-alias-error, #ea4335)", color: "var(--dsw-alias-error, #ea4335)" } : {}),
					placeholder: t("rec.pagePlaceholder"),
					value: gotoVal,
					onChange: function (e) {
						setGoto(e.target.value.replace(/\D/g, ""));
						setGotoErr(false);
					},
					onKeyDown: function (e) { if (e.key === "Enter") jump(); },
				}),
				h(FilterSelect, {
					options: [
						{ id: "10", label: "10" },
						{ id: "20", label: "20" },
						{ id: "50", label: "50" },
						{ id: "100", label: "100" },
					],
					value: pageSize,
					buttonText: t("rec.perPage", { n: pageSize }),
					placeholder: t("rec.perPagePlaceholder"),
					minWidth: "76px",
					onChange: function (v) { props.onPageSize(v || "10"); },
				}),
				h("button", {
					type: "button", style: S.windowBtn,
					onMouseDown: function (e) { e.preventDefault(); },
					onClick: jump,
				}, t("rec.go")));
		}

		/** 请求记录卡：分页明细表（每页 10 条，时间倒序）。 */
		function RequestRecords(props) {
			var _page = React.useState(1), page = _page[0], setPage = _page[1];
			var _size = React.useState("10"), pageSize = _size[0], setPageSize = _size[1];
			var _data = React.useState(null), data = _data[0], setData = _data[1];
			var _err = React.useState(null), err = _err[0], setErr = _err[1];

			// refreshKey：父组件（UsageView）在删除/导入 CC 数据后自增，触发本组件重拉
			React.useEffect(function () {
				var disposed = false;
				fetch("/token-monitor/usage/requests?page=" + page + "&size=" + pageSize, { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
					.then(function (j) { if (!disposed && j && j.ok) setData(j.data); })
					.catch(function (e) { if (!disposed) setErr(String((e && e.message) || e)); });
				return function () { disposed = true; };
			}, [page, pageSize, props.refreshKey]);

			var sizeNum = Number(pageSize) || 10;
			var totalPages = data ? Math.max(1, Math.ceil(data.total / sizeNum)) : 1;

			var columns = [
				{ key: "created_at", label: t("rec.col.time"), width: "11%", render: function (r) { return fmtRecordTime(r.created_at); } },
				{ key: "title", label: t("rec.col.session"), width: "16%", align: "left", render: function (r) { return r.title || "—"; } },
				{ key: "model", label: t("rec.col.model"), width: "11%", align: "left" },
				{ key: "input_tokens", label: t("rec.col.input"), width: "7.5%", render: function (r) { return fmtTokens(r.input_tokens); } },
				{ key: "output_tokens", label: t("rec.col.output"), width: "7.5%", render: function (r) { return fmtTokens(r.output_tokens); } },
				{ key: "cache_read_tokens", label: t("rec.col.cacheRead"), width: "7.5%", render: function (r) { return fmtTokens(r.cache_read_tokens); } },
				{ key: "cost_usd", label: t("rec.col.cost"), width: "7.5%", render: function (r) { return r.cost_usd == null ? "—" : fmtCny(r.cost_usd); } },
				{ key: "ttft_ms", label: t("rec.col.ttft"), width: "7.5%", render: function (r) { return fmtLatency(r.ttft_ms); } },
				{ key: "client", label: t("rec.col.client"), width: "7.5%", render: function (r) { return clientLabel(r.client); } },
				{ key: "provider", label: t("rec.col.provider"), width: "10%", render: function (r) { return providerLabel(r.provider); } },
				{ key: "source", label: t("rec.col.source"), width: "7%", render: function (r) { return r.source === "dsh-logs" ? t("rec.sourceDsh") : r.source; } },
			];

			return h("div", null,
				h("div", { style: { display: "flex", alignItems: "center", gap: "2px", marginBottom: "8px" } },
					h("div", { style: S.usageCardTitle }, t("rec.title")),
					data
						? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
							t("rec.note"))
						: null),
				err ? h("div", { style: S.error }, t("usage.loadFailed")) : null,
				!data && !err ? h("div", { style: S.muted }, t("usage.loading")) : null,
				data && data.rows.length
					? h(UsageTable, { columns: columns, rows: data.rows })
					: (data ? h("div", { style: S.muted }, t("usage.noRecords")) : null),
				data
					? h(Pager, {
						totalText: t("usage.totalRecords", { n: data.total }),
						page: page,
						totalPages: totalPages,
						pageSize: pageSize,
						onPage: setPage,
						onPageSize: function (v) { setPageSize(v || "10"); setPage(1); },
					})
					: null);
		}
		/** 使用排行表：按 模型/供应商/客户端 三维度聚合（服务端已算好，props.data 一次含三维度），
		 *  切维度零请求；首维占首列，其余两维在尾部，位置随模式互换。 */
		function RankTable(props) {
			var dim = props.dim;
			// 服务端返回 { model: [...], provider: [...], client: [...] }，每行含 name + 用量 + models/providers/clients 集合
			var rows = (props.data && props.data[dim]) || [];

			// 排行自身分页（同请求记录的分页条）：维度切换时回到第 1 页。
			var _pg = React.useState(1), page = _pg[0], setPage = _pg[1];
			var _ps = React.useState("10"), pageSize = _ps[0], setPageSize = _ps[1];
			React.useEffect(function () { setPage(1); }, [dim]);
			var sizeNum = Number(pageSize) || 10;
			var totalPages = Math.max(1, Math.ceil(rows.length / sizeNum));
			var cur = page > totalPages ? totalPages : page;
			var pageRows = rows.slice((cur - 1) * sizeNum, cur * sizeNum);

			var METRIC_COLS = [
				{ key: "tokens", label: t("rank.totalTokens"), width: "8.9%", render: function (r) { return fmtTokens((r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0)); } },
				{ key: "requests", label: t("rank.requests"), width: "8.9%", render: function (r) { return fmtTokens(r.requests); } },
				{ key: "cost_usd", label: t("rank.cost"), width: "8.9%", render: function (r) { return fmtCny(r.cost_usd); } },
				{ key: "input_tokens", label: t("rank.col.input"), width: "8.9%", render: function (r) { return fmtTokens(r.input_tokens); } },
				{ key: "output_tokens", label: t("rank.col.output"), width: "8.9%", render: function (r) { return fmtTokens(r.output_tokens); } },
				{ key: "cache_read_tokens", label: t("rank.col.cacheRead"), width: "8.9%", render: function (r) { return fmtTokens(r.cache_read_tokens); } },
				{ key: "ttft_avg_ms", label: t("rank.col.ttft"), width: "8.9%", render: function (r) { return fmtLatency(r.ttft_avg_ms); } },
			];
			var DIM_LABEL = { model: t("rank.col.model"), provider: t("rank.col.provider"), client: t("rank.col.client") };
			/** 维度名 → 展示名（数据层是 id，展示映射友好名）。 */
			var dimName = function (d, id) {
				return d === "provider" ? providerLabel(id) : d === "client" ? clientLabel(id) : id;
			};
			/** 名称列截断：超 20 字符才截，显示 17 + "..." = 20 字符；≤20 原样。 */
			var trunc20 = function (s) {
				s = String(s);
				return s.length > 20 ? s.slice(0, 17) + "..." : s;
			};
			/** 名称列统一配置：截断显示 + title 全值。 */
			var nameCol = function (key, label, width) {
				return {
					key: key, label: label, width: width,
					render: function (r) { return trunc20(dimName(key, r.name)); },
					title: function (r) { return dimName(key, r.name); },
				};
			};
			/** 组合列：该组的模型/供应商/客户端 id 集合 → 展示名按"DSH 永远在前、其余首字母"排序拼接。
			 *  preMap（可选）：先对 id 集合做归并映射（如 providers → vendorOf 供应商归并）并去重，
			 *  供应商组合列用它把"提供方集合"显示为"供应商集合"（语义对齐列头）。 */
			var rank2 = function (x) { return x === "DSH" ? "0" : "1" + x; };
			var comboCol = function (key, label, width, labelFn, preMap) {
				var idsOf = function (r) {
					var ids = (r[key] || []).slice();
					if (!preMap) return ids;
					var seen = {};
					var out = [];
					for (var i = 0; i < ids.length; i++) {
						var v = preMap(ids[i]);
						if (!seen[v]) { seen[v] = true; out.push(v); }
					}
					return out;
				};
				var join = function (r) {
					return idsOf(r).sort(function (a, b) {
						return rank2(labelFn(a)).localeCompare(rank2(labelFn(b)));
					}).map(labelFn).join(" | ");
				};
				return {
					key: key, label: label, width: width,
					render: function (r) { return trunc20(join(r)); },
					title: function (r) { return join(r); },
				};
			};
			var cols = [nameCol(dim, DIM_LABEL[dim], "11%")].concat(METRIC_COLS);
			if (dim === "model") {
				cols.push(comboCol("providers", t("rank.combo.providers"), "13.3%", providerLabel, vendorOf), comboCol("clients", t("rank.combo.clients"), "13.3%", clientLabel));
			} else if (dim === "provider") {
				cols.push(comboCol("models", t("rank.combo.models"), "13.3%", function (id) { return id; }), comboCol("clients", t("rank.combo.clients"), "13.3%", clientLabel));
			} else {
				cols.push(comboCol("providers", t("rank.combo.providers"), "13.3%", providerLabel, vendorOf), comboCol("models", t("rank.combo.models"), "13.3%", function (id) { return id; }));
			}

			return rows.length
				? h("div", { style: { display: "flex", flexDirection: "column" } },
					h(UsageTable, { columns: cols, rows: pageRows }),
					h(Pager, {
						totalText: t("rank.totalRows", { n: rows.length }),
						page: cur,
						totalPages: totalPages,
						pageSize: pageSize,
						onPage: setPage,
						onPageSize: function (v) { setPageSize(v || "10"); setPage(1); },
					}))
				: h("div", { style: S.muted }, t("rank.noData"));
		}

		/** 通用数据表：列定义 { key, label, render? }，右对齐数值列。 */
		function UsageTable(props) {
			var cols = props.columns || [];
			var rows = props.rows || [];
			// 原生自绘悬浮提示（仿图表 tooltip）：useEffect 创建 DOM 浮层 + 文档级 mousemove，
			// 直接用 textContent/style（不经过 React 渲染，避免渲染期问题）；离开目标立即隐藏。
			React.useEffect(function () {
				var tip = document.createElement("div");
				tip.setAttribute("data-tm-tip", "1");
				var st = tip.style;
				st.position = "fixed";
				st.maxWidth = "320px";
				st.boxSizing = "border-box";
				st.padding = "6px 10px";
				st.borderRadius = "6px";
				st.fontSize = "11px";
				st.lineHeight = "16px";
				st.whiteSpace = "pre-wrap";
				st.wordBreak = "break-all";
				st.background = "var(--dsw-specific-menu)";
				st.border = "1px solid var(--dsw-alias-border-l2)";
				st.boxShadow = "var(--dsw-shadow-lv3)";
				st.color = "var(--dsw-alias-label-primary)";
				st.pointerEvents = "none";
				st.zIndex = "1000";
				st.display = "none";
				document.body.appendChild(tip);
				var onMove = function (e) {
					var t = e.target;
					var cell = t && t.closest ? t.closest("td[data-tip-text]") : null;
					if (cell) {
						var text = cell.getAttribute("data-tip-text");
						if (!text) { tip.style.display = "none"; return; }
						// 先隐藏态写出内容并用 offsetWidth/Height 实测尺寸（内容短时远小于 maxWidth，
						// 用固定 320 反向会留下大空隙）；再用实测尺寸计算位置，最后显示（同一帧不闪）。
						tip.textContent = text;
						tip.style.visibility = "hidden";
						tip.style.display = "block";
						var tw = tip.offsetWidth;
						var th = tip.offsetHeight;
						// 位置：右下偏移 +16；超出右/下边缘按实测宽度反向偏移（各留 16px 边距）
						var left = e.clientX + 16;
						if (left + tw > window.innerWidth - 16) left = Math.max(0, e.clientX - 16 - tw);
						var top = e.clientY + 16;
						if (top + th > window.innerHeight - 16) top = Math.max(0, e.clientY - 16 - th);
						tip.style.left = left + "px";
						tip.style.top = top + "px";
						tip.style.visibility = "visible";
					} else {
						tip.style.display = "none";
					}
				};
				document.addEventListener("mousemove", onMove);
				return function () {
					document.removeEventListener("mousemove", onMove);
					if (tip.parentNode) tip.parentNode.removeChild(tip);
				};
			}, []);
			return h("div", { style: { overflowX: "auto" } },
				// tableLayout fixed：列宽由列定义（width）与均分剩余空间决定，翻页不跳动
				h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px", tableLayout: "fixed" } },
					h("thead", null, h("tr", null, cols.map(function (c, i) {
						return h("th", {
							key: c.key || i,
							// 默认：首列左对齐，其余右对齐（数值列）；c.align 可按列覆盖（如会话/模型要左对齐）
							style: Object.assign({}, S.usageTh, c.align ? { textAlign: c.align } : (i > 0 ? { textAlign: "right" } : {}), c.width ? { width: c.width } : {}),
						}, c.label);
					}))),
					h("tbody", null, rows.map(function (row, ri) {
						return h("tr", {
							key: row.key || ri,
							style: row.highlight ? { background: "rgba(128,128,128,0.14)" } : undefined,
						}, cols.map(function (c, ci) {
							var rendered = c.render ? c.render(row) : String(row[c.key] ?? "");
							// c.title 提供全值（名称/组合列，长内容）→ data-tip-text 走自绘浮层；
							// 其余列（短数值）保留原生 title。用 Object.assign 合并，不用展开语法。
							var cellProps = c.title
								? { "data-tip-text": c.title(row) }
								: { title: typeof rendered === "string" ? rendered : undefined };
							return h("td", Object.assign({
								key: c.key || ci,
								style: Object.assign({}, S.usageTd, c.align ? { textAlign: c.align } : (ci > 0 ? { textAlign: "right" } : {}),
									{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
							}, cellProps), rendered);
						}));
					}))));
		}

		/** 轻量下拉选择（用量页签筛选用）。options: [{id, label}]；value 空串 = "全部"。 */
		function FilterSelect(props) {
			var _o = React.useState(false), open = _o[0], setOpen = _o[1];
			var rootRef = React.useRef(null);

			React.useEffect(function () {
				if (!open) return undefined;
				var onPointerDown = function (e) {
					if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
				};
				var onKeyDown = function (e) {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						setOpen(false);
					}
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			var opts = props.options || [];
			var current = null;
			for (var i = 0; i < opts.length; i++) {
				if (opts[i].id === props.value) { current = opts[i]; break; }
			}
			var label = props.buttonText || (current ? current.label : (props.placeholder || t("filter.all")));
			var hasLabel = !!props.label;

			// 有 label 时：标题 + 下拉按钮共用一个边框（整体复合控件，按钮融入去自身边框）；
			// 无 label 时：按钮保持 windowBtn 原样
			var rootStyle = Object.assign({ position: "relative", display: "inline-flex", alignItems: "center" }, props.rootStyle || {});
			var btnStyle = Object.assign({}, props.style || S.windowBtn, {
				display: "inline-flex",
				minWidth: props.minWidth || "88px",
				justifyContent: "space-between",
				alignItems: "center",
			});
			if (hasLabel) {
				rootStyle.border = "1px solid var(--dsw-alias-border-l2)";
				rootStyle.borderRadius = "6px";
				// 注意：不能用 overflow:hidden——会裁掉弹出的下拉菜单（菜单在控件边界外）
				btnStyle.border = 0;
				btnStyle.borderRadius = 0;
				btnStyle.background = "none";
			}

			return h("div", { ref: rootRef, style: rootStyle },
				hasLabel
					? h("span", {
						style: {
							fontSize: "12px", lineHeight: "18px", whiteSpace: "nowrap",
							color: "var(--dsw-alias-label-secondary)",
							paddingLeft: "10px", paddingRight: "8px",
							// 标题与下拉之间竖分隔线，标签感
							borderRight: "1px solid var(--dsw-alias-border-l2)",
						},
					}, props.label)
					: null,
				h("button", {
					type: "button",
					style: btnStyle,
					"aria-expanded": open,
					title: props.placeholder,
					// 阻止鼠标点击聚焦，避免主题 :focus 边框变色（键盘 Tab 聚焦不受影响）
					onMouseDown: function (e) { e.preventDefault(); },
					onClick: function () { setOpen(function (v) { return !v; }); },
				},
					// 按钮文字上限：120px + 60px（长选项名多显示一点）；超出省略号截断
					h("span", { style: { maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label),
					// SVG 细线 chevron：收起朝下 ∨、打开朝上 ∧；stroke 跟随 currentColor
					h("svg", {
						width: "10", height: "6", viewBox: "0 0 10 6",
						fill: "none", stroke: "currentColor", strokeWidth: "1.5",
						strokeLinecap: "round", strokeLinejoin: "round",
						style: { flex: "none", marginLeft: "8px" },
					}, h("path", { d: open ? "M1 5l4-4 4 4" : "M1 1l4 4 4-4" }))),
				open
					? h("ul", {
						// left: 0 对齐控件左缘；minWidth: 100% = 整个控件宽（含"客户端"标题，即按钮整体）；
						// 不加 right:0，长选项名可撑宽到 maxWidth 20rem
						style: S.filterMenu,
						role: "listbox",
					},
						opts.map(function (o) {
							var active = o.id === props.value;
							return h("li", { key: o.id, role: "option", "aria-selected": active },
								h("button", {
									type: "button",
									style: active ? Object.assign({}, S.filterItem, { background: "rgba(128,128,128,0.12)" }) : S.filterItem,
									onClick: function () { props.onChange(o.id); setOpen(false); },
								},
									h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, o.label),
									active ? h("span", { style: { flex: "none", color: "var(--dsw-alias-success, #34a853)" } }, "✓") : null));
						}))
					: null);
		}

		/** 主区"用量"数据面板（DESIGN.md §8 终态：时间窗 + 大数字卡 + 趋势 + 排行 + 会话明细 + 费用）。 */
		function UsageView() {
			var _days = React.useState(1), days = _days[0], setDays = _days[1];
			// 外观切换时重渲染（头部刷新按钮等按 isDark() 取色的元素）
			var _themeRev = React.useState(0), themeRev = _themeRev[0], setThemeRev = _themeRev[1];
			React.useEffect(function () {
				function onTheme() { setThemeRev(function (v) { return v + 1; }); }
				window.addEventListener("token-monitor:theme-change", onTheme);
				return function () { window.removeEventListener("token-monitor:theme-change", onTheme); };
			}, []);
			// 用户是否手动切过时间窗：手动切过则不再用插件设置覆盖
			var daysTouchedRef = React.useRef(false);
			// 初始时间窗跟随插件设置（overview.pluginSettings.defaultDays，默认当天=1）：
			// 挂载时拉一次 overview，用户未手动切换时用配置值初始化
			React.useEffect(function () {
				var disposed = false;
				fetch("/token-monitor/overview", { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) {
						if (!disposed && d && d.pluginSettings && d.pluginSettings.defaultDays !== undefined
							&& !daysTouchedRef.current) {
							setDays(d.pluginSettings.defaultDays);
						}
					})
					.catch(function () {});
				return function () { disposed = true; };
			}, []);
			// 设置保存广播：用户未手动切过时间窗时，用量页立即采用新默认时间窗（实时感知）
			React.useEffect(function () {
				function onSaved() {
					var ps = overviewCache && overviewCache.pluginSettings;
					if (!daysTouchedRef.current && ps && ps.defaultDays !== undefined) {
						setDays(ps.defaultDays);
					}
				}
				window.addEventListener("token-monitor:settings-saved", onSaved);
				return function () { window.removeEventListener("token-monitor:settings-saved", onSaved); };
			}, []);
			var _daily = React.useState(null), daily = _daily[0], setDaily = _daily[1];
			var _byModel = React.useState(null), byModel = _byModel[0], setByModel = _byModel[1];
			// 全量 byModel（仅时间窗，无筛选）：级联下拉选项的数据源
			var _byModelAll = React.useState(null), byModelAll = _byModelAll[0], setByModelAll = _byModelAll[1];
			// 历史全量图表数据（不受筛选条件影响，独立拉取，只挂一次 + 点刷新时重拉）：
			// rank=使用排行（服务端三维度聚合）、dist=消耗分布柱状图、calRows=年度热力图
			var _rank = React.useState(null), rank = _rank[0], setRank = _rank[1];
			var _dist = React.useState(null), dist = _dist[0], setDist = _dist[1];
			var _calRows = React.useState(null), calRows = _calRows[0], setCalRows = _calRows[1];
			// "当天"窗口的渲染就绪趋势数据（服务端封装，仅 days===1 时拉取）
			var _hourly = React.useState(null), hourly = _hourly[0], setHourly = _hourly[1];
			var _error = React.useState(null), error = _error[0], setError = _error[1];
			var _loading = React.useState(true), loading = _loading[0], setLoading = _loading[1];
			// 手动刷新中（静默加载，不闪页面）
			var _refreshing = React.useState(false), refreshing = _refreshing[0], setRefreshing = _refreshing[1];
			var _focus = React.useState(null), focus = _focus[0], setFocus = _focus[1];
			// 级联筛选：客户端（默认全部）→ 供应商 → 模型
			var _client = React.useState(""), client = _client[0], setClient = _client[1];
			var _provider = React.useState(""), provider = _provider[0], setProvider = _provider[1];
			var _model = React.useState(""), model = _model[0], setModel = _model[1];
			// 进入会话聚焦前的筛选快照（client/provider/model/days，关闭会话时全部还原）；
			// latestFiltersRef 供事件回调读"最新"筛选值（避免 useEffect([]) 闭包过期）
			var focusSnapshotRef = React.useRef(null);
			var latestFiltersRef = React.useRef({ client: "", provider: "", model: "", days: 1 });
			latestFiltersRef.current = { client: client, provider: provider, model: model, days: days };
			// 使用排行维度：模型（默认）/ 供应商 / 客户端
			var _rankDim = React.useState("model"), rankDim = _rankDim[0], setRankDim = _rankDim[1];
			// 数据来源路径（页面底部"数据说明"展示用，服务端返回完整路径）
			var _sources = React.useState(null), sources = _sources[0], setSources = _sources[1];
			// 请求记录刷新信号：删除/导入 CC 数据后自增，驱动 RequestRecords 重拉
			var _recordsKey = React.useState(0), recordsKey = _recordsKey[0], setRecordsKey = _recordsKey[1];
			// CC 数据操作状态：'importing' | 'deleting' | null（按钮禁用 + 文案反馈）
			var _ccBusy = React.useState(null), ccBusy = _ccBusy[0], setCcBusy = _ccBusy[1];
			// 操作结果提示：{ from: 'import'|'delete', ok, text, expiresAt }（成功/失败，4 秒自动消失）；null 不显示
			var _ccResult = React.useState(null), ccResult = _ccResult[0], setCcResult = _ccResult[1];
			// 倒计时剩余秒（显示"N s 后关闭"）；1s 心跳递减，0 时自动清除气泡
			var _ccResultLeft = React.useState(0), ccResultLeft = _ccResultLeft[0], setCcResultLeft = _ccResultLeft[1];
			var ccResultTimer = React.useRef(null);
			var ccResultTick = React.useRef(null);
			function showCcResult(from, ok, text) {
				setCcResult({ from: from, ok: ok, text: text, expiresAt: Date.now() + 4000 });
				setCcResultLeft(4);
				if (ccResultTimer.current) { clearTimeout(ccResultTimer.current); }
				if (ccResultTick.current) { clearInterval(ccResultTick.current); }
				ccResultTimer.current = setTimeout(function () {
					ccResultTimer.current = null;
					if (ccResultTick.current) { clearInterval(ccResultTick.current); ccResultTick.current = null; }
					setCcResult(null);
					setCcResultLeft(0);
				}, 4000);
				// 秒级心跳：剩余 = ceil((expiresAt - now)/1000)，到 0 停止
				ccResultTick.current = setInterval(function () {
					setCcResultLeft(function (v) {
						var left = Math.max(0, v - 1);
						if (left <= 0 && ccResultTick.current) {
							clearInterval(ccResultTick.current);
							ccResultTick.current = null;
						}
						return left;
					});
				}, 1000);
			}
			React.useEffect(function () {
				return function () {
					if (ccResultTimer.current) { clearTimeout(ccResultTimer.current); ccResultTimer.current = null; }
					if (ccResultTick.current) { clearInterval(ccResultTick.current); ccResultTick.current = null; }
				};
			}, []);

			// 弹层"↗ 详情"交棒：聚焦指定会话 + 客户端=dsh（弹层是 DSH 会话）+
			// 供应商/模型=全部（会话可能切换过模型）+ 时间窗=全部（弹层投影=会话历史累计）。
			// 渲染期条件消费（React 官方模式）——覆盖"页签未激活→模拟点击切换→首挂载"；
			// 消费一次即清。
			if (usageFocusRequest) {
				// 快照聚焦前的原始筛选条件（关闭会话时还原）；聚焦中切换会话不覆盖快照
				if (!focusSnapshotRef.current) {
					focusSnapshotRef.current = {
						client: client, provider: provider, model: model, days: days,
						daysTouched: daysTouchedRef.current,
					};
				}
				setFocus(usageFocusRequest);
				setClient("dsh");
				setProvider("");
				setModel("");
				// 时间窗=全部。同时把"用户已主动选过时间窗"置位——否则挂载时那次
				// /overview 拉取（或设置保存广播）会在几十毫秒后按 defaultDays 把它覆盖回
				// "当天"，表现为"从弹层进来时间标签仍是当天"（时序竞态）。
				daysTouchedRef.current = true;
				setDays(0);
				usageFocusRequest = null;
			}

			// 弹层跳转事件监听：用量 tab 已激活时模拟点击不触发渲染，改由事件驱动消费
			// （组件挂载期间一直有效；与渲染期消费互补，两者消费同一请求但互不干扰）
			React.useEffect(function () {
				function onFocusSession(e) {
					var d = e && e.detail;
					if (!d || !d.sessionId) return;
					// 快照聚焦前的原始筛选条件（关闭会话时还原）；聚焦中切换会话不覆盖快照。
					// 事件回调闭包过期，用 latestFiltersRef 读最新值
					if (!focusSnapshotRef.current) {
						focusSnapshotRef.current = { ...latestFiltersRef.current, daysTouched: daysTouchedRef.current };
					}
					setFocus({ sessionId: d.sessionId, title: d.title || d.sessionId });
					setClient("dsh");
					setProvider("");
					setModel("");
					// 同上：聚焦视作"用户已主动选过时间窗"，避免被 defaultDays 覆盖
					daysTouchedRef.current = true;
					setDays(0);
				}
				window.addEventListener("token-monitor:focus-session", onFocusSession);
				return function () { window.removeEventListener("token-monitor:focus-session", onFocusSession); };
			}, []);

			// 弹层 CC 同步成功事件监听：与用量页"导入"成功后的效果一致——
			// 静默全量重载（含历史全量图，forceAllTime）+ 请求记录独立重拉
			React.useEffect(function () {
				function onUsageRefresh() {
					load(days, client, provider, model, focus, true, true);
					setRecordsKey(function (k) { return k + 1; });
				}
				window.addEventListener("token-monitor:usage-refresh", onUsageRefresh);
				return function () { window.removeEventListener("token-monitor:usage-refresh", onUsageRefresh); };
			}, [load, days, client, provider, model, focus]);

			var load = React.useCallback(function (d, cl, pv, md, fs, silent, forceAllTime) {
				// silent=true：条件切换的静默更新（保留旧数据渲染，新数据到达直接替换，不闪加载态）
				// forceAllTime=true：删除/导入等数据变更时强制重拉历史全量图（rank/distribution/calendar），
				//   否则 silent 会跳过它们导致"使用排行"等显示旧数据
				if (!silent) setLoading(true);
				if (!silent) setError(null);
				// 展示数据：带筛选参数（会话聚焦、客户端、供应商、模型）
				// 注意 d===0（"全部"）不能落到 (d || 30)——0 是合法的"无时间上限"，必须原样传
				var daysParam = d === 0 ? 0 : (d || 30);
				var params = ["days=" + daysParam];
				if (fs && fs.sessionId) params.push("session=" + encodeURIComponent(fs.sessionId));
				if (cl) params.push("client=" + encodeURIComponent(cl));
				if (pv) params.push("provider=" + encodeURIComponent(pv));
				if (md) params.push("model=" + encodeURIComponent(md));
				var q = "?" + params.join("&");
				// 选项数据：非聚焦时全量 byModel（仅时间窗，保证级联选项完整）；
				// 聚焦会话时带 session 参数——选项只显示该会话实际用过的模型/供应商/客户端
				// （否则会看到别的会话/CC 的选项，选了数据为 0）
				var qAll = "?days=" + daysParam
					+ (fs && fs.sessionId ? "&session=" + encodeURIComponent(fs.sessionId) : "");
				var ok = function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); };
				var jobs = [
					fetch(USAGE_URLS.daily + q, { headers: { accept: "application/json" } }).then(ok),
					fetch(USAGE_URLS.byModel + q, { headers: { accept: "application/json" } }).then(ok),
					fetch(USAGE_URLS.byModel + qAll, { headers: { accept: "application/json" } }).then(ok),
				];
				// 历史全量图表：非静默加载（首次挂载/手动刷新）或数据变更强制刷新时拉取；
				// 条件切换的静默加载不动它——免得"不受条件影响"的图跟着条件闪
				var includeAllTime = !silent || forceAllTime;
				if (includeAllTime) {
					jobs.push(fetch(USAGE_URLS.rank + "?days=3650", { headers: { accept: "application/json" } }).then(ok));
					jobs.push(fetch(USAGE_URLS.distribution + "?days=3650", { headers: { accept: "application/json" } }).then(ok));
					jobs.push(fetch(USAGE_URLS.calendar, { headers: { accept: "application/json" } }).then(ok));
				}
				// "当天"/"昨天"拉渲染就绪的趋势数据（服务端已完成区间/颗粒度/分桶封装；带筛选参数）
				if (d === 1 || d === -1) {
					var targetDay = d === 1 ? Date.now() : Date.now() - 86400000;
					var hq = "?day=" + localDay(targetDay) + (params.length > 1 ? "&" + params.slice(1).join("&") : "");
					jobs.push(fetch(USAGE_URLS.hourly + hq, { headers: { accept: "application/json" } }).then(ok));
				}
				Promise.all(jobs).then(function (results) {
					setDaily(results[0].data || []);
					setByModel(results[1].data || []);
					setByModelAll(results[2].data || []);
					var idx = 3;
					if (includeAllTime) {
						setRank(results[idx++].data || null);
						setDist(results[idx++].data || null);
						setCalRows(results[idx++].data || null);
					}
					setHourly(function () {
						// 非当天/昨天窗口强制清空（趋势走按天数据）；当天/昨天用服务端分桶结果
						return (d === 1 || d === -1) && results[idx] ? (results[idx].data || null) : null;
					});
				}).catch(function (e) {
					if (!silent) setError(String((e && e.message) || e));
				}).then(function () {
					if (!silent) setLoading(false);
					setRefreshing(false); // 手动刷新结束（静默时也清）
				});
			}, []);

			// 首次挂载显示加载态；后续条件切换静默更新（不闪）
			var firstRun = React.useRef(true);
			React.useEffect(function () {
				load(days, client, provider, model, focus, !firstRun.current);
				firstRun.current = false;
			}, [days, client, provider, model, focus, load]);

			// 页面打开后后台触发一轮日志折叠：读日志 → 更新数据库 → 静默重载渲染。
			// 查询本身纯读数据库（秒开），折叠只在这里、定时器和手动刷新时发生。
			React.useEffect(function () {
				var disposed = false;
				fetch("/token-monitor/fold", { method: "POST" })
					.then(function () { if (!disposed) load(days, client, provider, model, focus, true); })
					.catch(function () {});
				return function () { disposed = true; };
			}, []);

			// 数据来源路径 + 汇率（页面底部"数据说明"用）：只拉一次，路径/汇率都是低频变化
			React.useEffect(function () {
				var disposed = false;
				fetch("/token-monitor/usage/sources", { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) {
						if (!disposed && d && d.ok) {
							setSources(d);
							// 汇率随 sources 下发：更新模块级变量，费用显示自动换算
							if (typeof d.usdCnyRate === "number" && d.usdCnyRate > 0) {
								USDUCNY_RATE = d.usdCnyRate;
								RATE_FETCHED_AT = d.rateFetchedAt || 0;
							}
						}
					})
					.catch(function () {});
				return function () { disposed = true; };
			}, []);

			// 提供方映射动态合并（服务端 provider_mappings 下发，REVIEW #2）：
			// 供应商/提供方显示名与 vendor 归并以服务端为唯一权威源，硬编码表兜底
			React.useEffect(function () {
				fetchProviderMappings();
			}, []);

			// 打开目录：浏览器无法直接打开本地目录，POST 到服务端由 Host 进程代开（explorer/open/xdg-open）
			function openSourceDir(source) {
				fetch("/token-monitor/usage/sources", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ source: source }),
				}).catch(function () {});
			}

			// 导入 CC 历史：点击"导入"弹出文件选择（cc-switch-export-*.sql），
			// 读取文件内容 POST 到服务端解析导入（§2.2 跨设备手动入口）；成功/失败均有结果提示
			var importFileRef = React.useRef(null);
			function importCc() {
				if (ccBusy) return;
				if (importFileRef.current) importFileRef.current.click();
			}
			function onImportFileChange(e) {
				var file = e.target.files && e.target.files[0];
				e.target.value = ""; // 允许连续选同一个文件
				if (!file) return;
				setCcBusy("importing");
				var reader = new FileReader();
				reader.onload = function () {
					fetch("/token-monitor/import/cc-switch/sql", {
						method: "POST",
						headers: { "content-type": "text/plain; charset=utf-8" },
						body: reader.result,
					})
						.then(function (r) { return r.json(); })
						.then(function (d) {
							if (d && d.ok) {
								showCcResult("import", true, t("src.imported", { n: d.imported || 0 })
									+ (d.skippedUnknownApp ? t("src.importSkipped", { n: d.skippedUnknownApp }) : ""));
								// silent + forceAllTime：静默全量重载（含使用排行等历史图）
								load(days, client, provider, model, focus, true, true);
								setRecordsKey(function (k) { return k + 1; }); // 请求记录表独立重拉
							} else {
								showCcResult("import", false, t("src.importFailed"));
							}
						})
						.catch(function () { showCcResult("import", false, t("src.importFailed")); })
						.then(function () { setCcBusy(null); });
				};
				reader.readAsText(file, "utf-8");
			}

			// 删除 CC 来源数据：按钮旁弹出内联气泡二次确认（提示文字 + 确认/取消），不打断页面
			var _ccDelOpen = React.useState(false), ccDelOpen = _ccDelOpen[0], setCcDelOpen = _ccDelOpen[1];
			// 气泡打开时点击其他区域自动关闭
			React.useEffect(function () {
				if (!ccDelOpen) return undefined;
				function onDown(e) {
					if (!(e.target && e.target.closest && e.target.closest("[data-cc-del]"))) setCcDelOpen(false);
				}
				document.addEventListener("pointerdown", onDown);
				return function () { document.removeEventListener("pointerdown", onDown); };
			}, [ccDelOpen]);
			function deleteCc() {
				if (ccBusy) return;
				setCcDelOpen(true);
			}
			function confirmDeleteCc() {
				setCcDelOpen(false);
				setCcBusy("deleting");
				fetch("/token-monitor/import/cc-switch", { method: "DELETE" })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) {
						if (d && d.ok) {
							showCcResult("delete", true, t("src.deleted", { n: d.deleted || 0 }));
							// silent + forceAllTime：静默全量重载（含使用排行等历史图，CC 数据影响它们）
							load(days, client, provider, model, focus, true, true);
							setRecordsKey(function (k) { return k + 1; }); // 请求记录表独立重拉
						} else {
							showCcResult("delete", false, t("src.deleteFailed"));
						}
					})
					.catch(function () { showCcResult("delete", false, t("src.deleteFailed")); })
					.then(function () { setCcBusy(null); });
			}

			/* ---- DSH 用量导出/导入（跨设备手动同步）：状态机与 CC 导入同构 ----
			 * 导出：GET /token-monitor/export/dsh → Blob 下载 JSON 快照；
			 * 导入：选文件 → 读文本 POST /token-monitor/import/dsh → 幂等合并；
			 * 成功后静默全量重载（明细/聚合都变，排行与请求记录一并刷新）。 */
			var _dshBusy = React.useState(null), dshBusy = _dshBusy[0], setDshBusy = _dshBusy[1];
			var _dshResult = React.useState(null), dshResult = _dshResult[0], setDshResult = _dshResult[1];
			var _dshResultLeft = React.useState(0), dshResultLeft = _dshResultLeft[0], setDshResultLeft = _dshResultLeft[1];
			var dshResultTimer = React.useRef(null);
			var dshResultTick = React.useRef(null);
			// from: 'export' | 'import'——导出/导入两个气泡共用结果态，按 from 区分显示位置
			function showDshResult(from, ok, text) {
				setDshResult({ from: from, ok: ok, text: text, expiresAt: Date.now() + 4000 });
				setDshResultLeft(4);
				if (dshResultTimer.current) { clearTimeout(dshResultTimer.current); dshResultTimer.current = null; }
				if (dshResultTick.current) { clearInterval(dshResultTick.current); dshResultTick.current = null; }
				dshResultTimer.current = setTimeout(function () {
					dshResultTimer.current = null;
					if (dshResultTick.current) { clearInterval(dshResultTick.current); dshResultTick.current = null; }
					setDshResult(null);
					setDshResultLeft(0);
				}, 4000);
				dshResultTick.current = setInterval(function () {
					setDshResultLeft(function (v) {
						var left = Math.max(0, v - 1);
						if (left <= 0 && dshResultTick.current) {
							clearInterval(dshResultTick.current);
							dshResultTick.current = null;
						}
						return left;
					});
				}, 1000);
			}
			React.useEffect(function () {
				return function () {
					if (dshResultTimer.current) { clearTimeout(dshResultTimer.current); dshResultTimer.current = null; }
					if (dshResultTick.current) { clearInterval(dshResultTick.current); dshResultTick.current = null; }
				};
			}, []);

			var dshImportFileRef = React.useRef(null);
			function exportDsh() {
				if (dshBusy) return;
				setDshBusy("exporting");
				fetch("/token-monitor/export/dsh", { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r : null; })
					.then(function (resp) {
						if (!resp) { showDshResult("export", false, t("src.exportFailed")); return null; }
						// 从 content-disposition 取文件名（服务端带本地时间戳），取不到用默认名
						var name = "token-monitor-dsh-export.json";
						var cd = resp.headers.get("content-disposition") || "";
						var m = /filename="?([^";]+)"?/.exec(cd);
						if (m && m[1]) name = m[1];
						return resp.blob().then(function (blob) { return { blob: blob, name: name }; });
					})
					.then(function (file) {
						if (!file) return;
						// 触发浏览器下载
						var url = URL.createObjectURL(file.blob);
						var a = document.createElement("a");
						a.href = url;
						a.download = file.name;
						document.body.appendChild(a);
						a.click();
						document.body.removeChild(a);
						setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
						// 提示导出条数：从 Blob 内容解析（导出文件带 detail/rollups 计数）
						file.blob.text().then(function (text) {
							var d = null;
							try { d = JSON.parse(text); } catch (e) { d = null; }
							showDshResult("export", true, d && Array.isArray(d.detail) && Array.isArray(d.rollups)
								? t("src.exported", { n: d.detail.length, m: d.rollups.length })
								: t("src.exported", { n: "?", m: "?" }));
						}).catch(function () { showDshResult("export", true, t("src.exported", { n: "?", m: "?" })); });
					})
					.catch(function () { showDshResult("export", false, t("src.exportFailed")); })
					.then(function () { setDshBusy(null); });
			}
			function importDsh() {
				if (dshBusy) return;
				if (dshImportFileRef.current) dshImportFileRef.current.click();
			}
			function onDshImportFileChange(e) {
				var file = e.target.files && e.target.files[0];
				e.target.value = ""; // 允许连续选同一个文件
				if (!file) return;
				setDshBusy("importing");
				var reader = new FileReader();
				reader.onload = function () {
					fetch("/token-monitor/import/dsh", {
						method: "POST",
						headers: { "content-type": "application/json; charset=utf-8" },
						body: reader.result,
					})
						.then(function (r) { return r.json(); })
						.then(function (d) {
							if (d && d.ok) {
								showDshResult("import", true, t("src.dshImported", { n: d.imported || 0, s: d.skipped || 0 }));
								// silent + forceAllTime：静默全量重载（导入影响明细与历史聚合）
								load(days, client, provider, model, focus, true, true);
								setRecordsKey(function (k) { return k + 1; }); // 请求记录表独立重拉
							} else {
								showDshResult("import", false, t("src.importDshFailed"));
							}
						})
						.catch(function () { showDshResult("import", false, t("src.importDshFailed")); })
						.then(function () { setDshBusy(null); });
				};
				reader.readAsText(file, "utf-8");
			}

			// 大数字卡汇总：总消耗 / 请求次数 / 费用 / TTFT + 第二排 token 构成（新增输入/缓存命中/输出）
			var totals = React.useMemo(function () {
				var t = { requests: 0, tokens: 0, cost: 0, unpriced: 0, ttftSum: 0, ttftCount: 0, ttft: null,
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				var rows = daily || [];
				for (var i = 0; i < rows.length; i++) {
					var r = rows[i];
					t.requests += r.requests || 0;
					t.input += r.input_tokens || 0;
					t.output += r.output_tokens || 0;
					t.cacheRead += r.cache_read_tokens || 0;
					t.cacheWrite += r.cache_write_tokens || 0;
					t.cost += r.cost_usd || 0;
					t.unpriced += r.unpriced_requests || 0;
					if (r.ttft_avg_ms != null) {
						t.ttftSum += (r.ttft_avg_ms || 0) * (r.requests || 0);
						t.ttftCount += r.requests || 0;
					}
				}
				t.tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
				t.ttft = t.ttftCount > 0 ? t.ttftSum / t.ttftCount : null;
				return t;
			}, [daily]);

			// 缓存命中率 = 命中 ÷（命中 + 新增输入），分母为 0（没有请求）时不显示
			var hitDenom = totals.cacheRead + totals.input;
			var hitPct = hitDenom > 0 ? Math.round((totals.cacheRead / hitDenom) * 10000) / 100 : null;

			// 按天聚合（daily 是 天×模型 粒度 → 按天合并）：折线图序列字段；
			// 无数据的日期补零，时间轴连续铺满整个窗口（参考官方控制台趋势图）。
			// "当天"窗口：直接消费服务端封装好的渲染就绪 buckets（区间/颗粒度/分桶已由服务端完成）。
			var trend = React.useMemo(function () {
				// 当天/昨天：hourly 已就绪才用（避免切换瞬间 hourly 未到 → 闪空）；
				// 未就绪回退 daily 聚合（单天单点），hourly 到达后替换为分钟级曲线
				if ((days === 1 || days === -1) && hourly && hourly.buckets && hourly.buckets.length) {
					// 复制数组并附上桶间隔 step（分钟）：tooltip 据此显示区间（如 15:00~15:30）
					var arr = hourly.buckets.slice();
					arr.step = hourly.step;
					return arr;
				}
				var map = {};
				var rows = daily || [];
				for (var i = 0; i < rows.length; i++) {
					var r = rows[i];
					var d = map[r.day];
					if (!d) d = map[r.day] = { day: r.day, cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
					d.cost += r.cost_usd || 0;
					d.requests += r.requests || 0;
					d.input += r.input_tokens || 0;
					d.output += r.output_tokens || 0;
					d.cacheRead += r.cache_read_tokens || 0;
					d.cacheWrite += r.cache_write_tokens || 0;
				}
				// "全部"时间窗：直接按天排序输出（不补零——跨度可能很大，没有"连续时间轴"概念）
				if (days === 0) {
					return Object.keys(map).sort().map(function (k) { return map[k]; });
				}
				// 补零窗口：昨天（-1）按 1 天窗口处理，且从昨天起算（不包含今天）
				var windowDays = days === -1 ? 1 : days;
				var windowOffset = days === -1 ? 1 : 0;
				var p = function (x) { return String(x).padStart(2, "0"); };
				var out = [];
				for (var i2 = windowDays - 1; i2 >= 0; i2--) {
					var dt = new Date(Date.now() - (i2 + windowOffset) * 86400000);
					var key = dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
					out.push(map[key] || { day: key, cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
				}
				// 头部全零裁剪：窗口前段无数据的日期割掉（从第一个有数据日起笔，中间空档保留），
				// 与"当天"窗口服务端的裁剪逻辑同口径，避免 7/30/90 天前段大片空线
				var firstNonZero = 0;
				while (firstNonZero < out.length) {
					var z = out[firstNonZero];
					if (z.requests || z.cost || z.input || z.output || z.cacheRead || z.cacheWrite) break;
					firstNonZero++;
				}
				return firstNonZero < out.length ? out.slice(firstNonZero) : out;
			}, [daily, hourly, days]);

			// 级联选项：客户端 →（该客户端下）供应商 →（该客户端+供应商下）模型。
			// 数据源 = 全量 byModel（仅时间窗，不随筛选收窄，保证选项完整）
			var filterOptions = React.useMemo(function () {
				var rows = byModelAll || [];
				var clientIds = [];
				var seenClient = {};
				for (var i = 0; i < rows.length; i++) {
					var c = rows[i].client;
					if (!seenClient[c]) { seenClient[c] = true; clientIds.push(c); }
				}
				// 供应商选项按 vendor 归并（kimi-coding + moonshotai-cn → 月之暗面）
				var vendorIds = [];
				var seenVendor = {};
				for (var j = 0; j < rows.length; j++) {
					var r = rows[j];
					if (client && r.client !== client) continue;
					var v = vendorOf(r.provider);
					if (!seenVendor[v]) { seenVendor[v] = true; vendorIds.push(v); }
				}
				var modelIds = [];
				var seenModel = {};
				for (var k = 0; k < rows.length; k++) {
					var r2 = rows[k];
					if (client && r2.client !== client) continue;
					if (provider && vendorOf(r2.provider) !== provider) continue;
					if (!seenModel[r2.model]) { seenModel[r2.model] = true; modelIds.push(r2.model); }
				}
				return {
					clients: clientIds.sort().map(function (id) { return { id: id, label: clientLabel(id) }; }),
					providers: vendorIds.sort().map(function (id) { return { id: id, label: providerLabel(id) }; }),
					models: modelIds.sort().map(function (id) { return { id: id, label: id }; }),
				};
			}, [byModelAll, client, provider]);

			// 级联重置：切客户端清空供应商/模型；切供应商清空模型
			function onClientChange(id) { setClient(id); setProvider(""); setModel(""); }
			function onProviderChange(id) { setProvider(id); setModel(""); }
			function onModelChange(id) { setModel(id); }

			var ALL_OPTION = [{ id: "", label: t("filter.all") }];

			var body = null;
			if (loading) {
				body = h("div", { style: S.muted }, t("usage.loading"));
			} else if (error) {
				body = h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
					h("span", { style: S.error }, t("usage.loadFailed")),
					h("button", { type: "button", style: S.refreshBtn, onClick: function () { load(days, client, provider, model, focus); } }, t("usage.retry")));
			} else {
				// 数据来源卡底部的日志格式提示（无异常 = null，整块不渲染）。
				// 判定来自服务端 /usage/sources 的 foldHealth（上一轮折叠的健康统计）：
				// 读不出 header / 损坏或超大帧 / 命名认不出 / 有事件却 0 用量行，任一命中才显示。
				var foldWarn = foldHealthWarning(sources && sources.foldHealth);
				body = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
					h("div", { style: S.usageStatGrid },
						h(UsageStatCard, { label: t("stat.totalTokens"), value: fmtTokens(totals.tokens) }),
						h(UsageStatCard, { label: t("stat.requests"), value: fmtTokens(totals.requests), color: STAT_COLORS.requests }),
						h(UsageStatCard, { label: t("stat.cost"), value: fmtCny(totals.cost), color: STAT_COLORS.cost }),
						h(UsageStatCard, { label: t("stat.avgTtft"), value: fmtLatency3(totals.ttft), color: STAT_COLORS.latency })),
					// 第二排：token 构成 + 缓存命中率，配色与趋势图序列同语言
					h("div", { style: S.usageStatGrid },
						h(UsageStatCard, { label: t("stat.input"), value: fmtTokens(totals.input), color: STAT_COLORS.input }),
						h(UsageStatCard, { label: t("stat.cacheHit"), value: fmtTokens(totals.cacheRead), color: STAT_COLORS.cache }),
						h(UsageStatCard, { label: t("stat.output"), value: fmtTokens(totals.output), color: STAT_COLORS.output }),
						// 无数据（分母为 0）时命中率无定义，显示 — 保留卡片占位
						h(UsageStatCard, { label: t("stat.hitRate"), value: hitPct !== null ? hitPct + "%" : "—", color: STAT_COLORS.rate })),
					h("div", { style: S.usageNote },
						t("note.costFormula", { rate: USDUCNY_RATE.toFixed(4) })
							+ (totals.unpriced > 0 ? t("note.unpriced", { n: totals.unpriced }) : "")),
					h("div", { style: S.usageCard },
						h(DailyTrend, { data: trend })),
					h("div", { style: S.usageCard },
						h(CalendarHeatmap, { rows: calRows })),
					h("div", { style: S.usageCard },
						h(ModelBarsView, { data: dist })),
					h("div", { style: S.usageCard },
						h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
							h("div", { style: S.usageCardTitle }, t("rank.title")),
							h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
								t("rank.note")),
							h("span", { style: { flex: 1 } }),
							h("div", { style: { display: "inline-flex", gap: "4px" } },
								[["model", t("rank.col.model")], ["provider", t("rank.col.provider")], ["client", t("rank.col.client")]].map(function (d) {
									var active = rankDim === d[0];
									return h("button", {
										key: d[0], type: "button",
										style: active ? Object.assign({}, S.windowBtn, S.windowBtnActive) : S.windowBtn,
										onMouseDown: function (e) { e.preventDefault(); },
										onClick: function () { setRankDim(d[0]); },
									}, d[1]);
								}))),
						h(RankTable, { data: rank, dim: rankDim })),
					h("div", { style: S.usageCard },
						h(RequestRecords, { refreshKey: recordsKey })),
					h("div", { style: S.usageCard },
						h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
							h("div", { style: S.usageCardTitle }, t("src.title")),
							h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
								t("src.note"))),
												h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px", tableLayout: "fixed" } },
							h("thead", null,
								h("tr", null,
									h("th", { style: Object.assign({}, S.usageTh, { width: "9%" }) }, t("src.col.source")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "35%" }) }, t("src.col.desc")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "22%" }) }, t("src.col.dir")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "12%" }) }, t("src.col.lastUpdate")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "8%" }) }, t("src.col.lastSync")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "14%" }) }, t("src.col.action")))),
							h("tbody", null,
								h("tr", null,
									h("td", { style: S.usageTd }, t("src.dshLogs")),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }), title: t("src.dshDesc") }, t("src.dshDesc")),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis" }), title: sources ? sources.dshSessions : "~/.dsh/sessions" },
										sources ? sources.dshSessions : "~/.dsh/sessions"),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }), title: t("src.lastUpdateTip") },
										fmtLastUpd(sources && sources.lastUpdated ? sources.lastUpdated["dsh-logs"] : null)),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) },
										fmtSyncRows(sources && sources.lastSync ? sources.lastSync["dsh-logs"] : null)),
									h("td", { style: S.usageTd },
										h("button", {
											type: "button", style: S.sourceBtn,
											onClick: function () { openSourceDir("dsh"); },
										}, t("src.openDir")),
										" ",
										h("span", { style: { position: "relative", display: "inline-block" } },
											h("button", {
												type: "button",
												style: dshBusy ? Object.assign({}, S.sourceBtn, { opacity: 0.55, cursor: "default" }) : S.sourceBtn,
												disabled: !!dshBusy,
												onClick: function () { importDsh(); },
											}, t("src.import")),
											// 导入操作气泡：同一位置按状态切换（进行中 → 结果），不另起气泡
											dshBusy === "importing" || (dshResult && dshResult.from === "import")
												? h("span", {
													style: dshBusy === "importing"
														? Object.assign({}, S.ccBubble, S.ccBubbleBusy)
														: Object.assign({}, S.ccBubble, dshResult.ok ? S.ccBubbleOk : S.ccBubbleErr),
												},
													dshBusy === "importing"
														? [
															h("span", { key: "i", style: { flex: "none" } }, "⏳"),
															h("span", { key: "t", style: { flex: 1 } }, t("src.importingDsh")),
														]
														: [
															h("span", { key: "i", style: { flex: "none" } }, dshResult.ok ? "✓" : "ⓧ"),
															h("span", { key: "t", style: { flex: 1 } }, dshResult.text),
															h("span", { key: "c", style: { flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums", opacity: 0.7 } },
																dshResultLeft > 0 ? t("entry.syncCloseIn", { n: dshResultLeft }) : ""),
														])
												: null),
										// 隐藏文件选择：选 token-monitor-dsh-export-*.json 后读取上传
										h("input", {
											type: "file",
											ref: dshImportFileRef,
											accept: ".json,application/json",
											style: { display: "none" },
											onChange: onDshImportFileChange,
										}),
										" ",
										h("span", { style: { position: "relative", display: "inline-block" } },
											h("button", {
												type: "button",
												style: dshBusy ? Object.assign({}, S.sourceBtn, { opacity: 0.55, cursor: "default" }) : S.sourceBtn,
												disabled: !!dshBusy,
												onClick: function () { exportDsh(); },
											}, t("src.export")),
											// 导出操作气泡：同一位置按状态切换（进行中 → 结果），不另起气泡
											dshBusy === "exporting" || (dshResult && dshResult.from === "export")
												? h("span", {
													style: dshBusy === "exporting"
														? Object.assign({}, S.ccBubble, S.ccBubbleBusy)
														: Object.assign({}, S.ccBubble, dshResult.ok ? S.ccBubbleOk : S.ccBubbleErr),
												},
													dshBusy === "exporting"
														? [
															h("span", { key: "i", style: { flex: "none" } }, "⏳"),
															h("span", { key: "t", style: { flex: 1 } }, t("src.exporting")),
														]
														: [
															h("span", { key: "i", style: { flex: "none" } }, dshResult.ok ? "✓" : "ⓧ"),
															h("span", { key: "t", style: { flex: 1 } }, dshResult.text),
															h("span", { key: "c", style: { flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums", opacity: 0.7 } },
																dshResultLeft > 0 ? t("entry.syncCloseIn", { n: dshResultLeft }) : ""),
														])
												: null))),
								h("tr", null,
									h("td", { style: S.usageTd }, "CC Switch"),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }), title: t("src.ccDesc") }, t("src.ccDesc")),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis" }), title: sources ? sources.ccSwitchDb : "~/.cc-switch/cc-switch.db" },
										sources ? sources.ccSwitchDb : "~/.cc-switch/cc-switch.db"),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }), title: t("src.lastUpdateTip") },
										fmtLastUpd(sources && sources.lastUpdated ? sources.lastUpdated["cc-switch"] : null)),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) },
										fmtSyncRows(sources && sources.lastSync ? sources.lastSync["cc-switch"] : null)),
									h("td", { style: S.usageTd },
										h("button", {
											type: "button", style: S.sourceBtn,
											onClick: function () { openSourceDir("cc"); },
										}, t("src.openDir")),
										" ",
										h("span", { style: { position: "relative", display: "inline-block" } },
											h("button", {
												type: "button",
												style: ccBusy ? Object.assign({}, S.sourceBtn, { opacity: 0.55, cursor: "default" }) : S.sourceBtn,
												disabled: !!ccBusy,
												onClick: function () { importCc(); },
											}, t("src.import")),
											// 导入操作气泡：同一位置按状态切换（进行中 → 结果），不另起气泡
											ccBusy === "importing" || (ccResult && ccResult.from === "import")
												? h("span", {
													style: ccBusy === "importing"
														? Object.assign({}, S.ccBubble, S.ccBubbleBusy)
														: Object.assign({}, S.ccBubble, ccResult.ok ? S.ccBubbleOk : S.ccBubbleErr),
												},
													ccBusy === "importing"
														? [
															h("span", { key: "i", style: { flex: "none" } }, "⏳"),
															h("span", { key: "t", style: { flex: 1 } }, t("src.importing")),
														]
														: [
															h("span", { key: "i", style: { flex: "none" } }, ccResult.ok ? "✓" : "ⓧ"),
															h("span", { key: "t", style: { flex: 1 } }, ccResult.text),
															h("span", { key: "c", style: { flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums", opacity: 0.7 } },
																ccResultLeft > 0 ? t("entry.syncCloseIn", { n: ccResultLeft }) : ""),
														])
												: null),
										// 隐藏文件选择：选 cc-switch-export-*.sql 后读取上传
										h("input", {
											type: "file",
											ref: importFileRef,
											accept: ".sql",
											style: { display: "none" },
											onChange: onImportFileChange,
										}),
										" ",
										h("span", { style: { position: "relative", display: "inline-block" } },
											h("button", {
												type: "button",
												"data-cc-del": "1",
												style: ccBusy
													? Object.assign({}, S.sourceBtn, { color: "var(--dsw-alias-error, #ea4335)", borderColor: "rgba(234,67,53,0.35)", opacity: 0.55, cursor: "default" })
													: Object.assign({}, S.sourceBtn, { color: "var(--dsw-alias-error, #ea4335)", borderColor: "rgba(234,67,53,0.35)" }),
												disabled: !!ccBusy,
												onClick: function () { deleteCc(); },
											}, t("src.delete")),
											// 删除操作气泡：同一位置按状态切换（确认 → 进行中 → 结果），不另起气泡
											(ccDelOpen && !ccBusy) || ccBusy === "deleting" || (ccResult && ccResult.from === "delete")
											? h("span", {
											// 气泡本体也要算"内部区域"：否则 pointerdown 先触发"点外部关闭"，
											// 确认按钮在 click 前就被卸载，confirmDeleteCc 永远执行不到
											"data-cc-del": "1",
											style: ccBusy === "deleting"
											? Object.assign({}, S.ccBubble, S.ccBubbleBusy)
											: (ccResult && ccResult.from === "delete")
											? Object.assign({}, S.ccBubble, ccResult.ok ? S.ccBubbleOk : S.ccBubbleErr)
											: S.ccBubble,
											},
											ccBusy === "deleting"
											? [
											h("span", { key: "i", style: { flex: "none" } }, "⏳"),
											h("span", { key: "t", style: { flex: 1 } }, t("src.deleting")),
											]
											: (ccResult && ccResult.from === "delete")
											? [
											h("span", { key: "i", style: { flex: "none" } }, ccResult.ok ? "✓" : "ⓧ"),
											h("span", { key: "t", style: { flex: 1 } }, ccResult.text),
											h("span", { key: "c", style: { flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums", opacity: 0.7 } },
											ccResultLeft > 0 ? t("entry.syncCloseIn", { n: ccResultLeft }) : ""),
											]
											: [
											t("src.confirmDelete"),
											h("button", {
											key: "ok", type: "button",
											style: Object.assign({}, S.sourceBtn, { color: "var(--dsw-alias-error, #ea4335)", borderColor: "rgba(234,67,53,0.35)" }),
											onClick: function (e) { e.stopPropagation(); confirmDeleteCc(); },
											}, t("src.confirm")),
											h("button", {
											key: "no", type: "button", style: S.sourceBtn,
											onClick: function (e) { e.stopPropagation(); setCcDelOpen(false); },
											}, t("src.cancel")),
											])
											: null))))),
						// 折叠健康提示（若有）：日志读不出来/认不出/产不出行时在表格下方显式说明，不静默显示 0。
						// 两行一组：第一行说明现象；第二行固定安慰文案，避免用户以为插件坏了（见 src.foldWarn.hint）。
						// 间距对称：卡片是 flex column（gap 8px）+ padding 12px，这一组给 4px 上外边距，
						// 于是"到表格 12px / 到卡片底边 12px"两侧一致；无提示时不渲染 → 原布局分毫不动。
						// 横向 8px 与表格首列单元格的左内边距对齐。
						foldWarn
							? h("div", { style: { padding: "0 8px", marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" } },
								h("div", { style: { fontSize: "11px", lineHeight: "18px", color: "var(--dsw-alias-error, #ea4335)" } }, foldWarn),
								h("div", { style: { fontSize: "11px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, t("src.foldWarn.hint")))
							: null));
			}

			return h("div", { style: S.usageRoot },
				h("div", { style: S.usageHeader },
					// 会话聚焦横幅：从弹层"用量详情"跳转进入；✕ 清除回到全量（还原为点击详情前的筛选条件）
					focus
						? h("span", { style: S.usageFocusBanner },
							h("span", null, t("focus.current", { title: focus.title || focus.sessionId })),
							h("button", {
								type: "button", style: S.usageFocusClear, title: t("focus.clear"),
								onClick: function () {
									var snap = focusSnapshotRef.current;
									setFocus(null);
									if (snap) {
										// 还原为点击"详情"前的 client/provider/model/days
										setClient(snap.client);
										setProvider(snap.provider);
										setModel(snap.model);
										setDays(snap.days);
										// 连"用户是否手动切过时间窗"一起还原：聚焦前没切过，
										// 关闭聚焦后仍应能被插件设置/保存广播驱动
										daysTouchedRef.current = snap.daysTouched === true;
										focusSnapshotRef.current = null;
									} else {
										// 无快照兜底：时间窗回到设置里的默认值，并恢复"跟随设置"语义
										var ps = overviewCache && overviewCache.pluginSettings;
										daysTouchedRef.current = false;
										setDays(ps && ps.defaultDays !== undefined ? ps.defaultDays : 1);
									}
								},
							}, "✕"))
						: null,
					h(FilterSelect, {
						label: t("filter.client"),
						options: ALL_OPTION.concat(filterOptions.clients),
						value: client, onChange: onClientChange,
						placeholder: t("filter.client"),
					}),
					h(FilterSelect, {
						label: t("filter.provider"),
						options: ALL_OPTION.concat(filterOptions.providers),
						value: provider, onChange: onProviderChange,
						placeholder: t("filter.provider"),
					}),
					h(FilterSelect, {
						label: t("filter.model"),
						options: ALL_OPTION.concat(filterOptions.models),
						value: model, onChange: onModelChange,
						placeholder: t("filter.model"),
					}),
					h("span", { style: { flex: 1 } }),
					h(WindowSwitcher, {
						value: days,
						onChange: function (d) { daysTouchedRef.current = true; setDays(d); },
					}),
					h("button", {
						// 行内唯一动作按钮：主色填充成为视觉焦点；深色下降一档蓝（#2f5fc7），深底不炸
						type: "button",
						style: Object.assign({}, S.refreshBtn, {
							padding: "3px 10px", fontSize: "12px", lineHeight: "18px",
							display: "inline-flex", alignItems: "center", justifyContent: "center",
							background: isDark() ? "#2547e0" : "var(--dsw-alias-state-business-primary, #1a73e8)",
							borderColor: isDark() ? "#2547e0" : "var(--dsw-alias-state-business-primary, #1a73e8)",
							color: "var(--dsw-alias-state-business-on-primary, #ffffff)",
							opacity: loading ? 0.6 : 1,
						}),
						disabled: loading || refreshing,
						// 手动刷新：先折叠（读日志更新数据库）再加载（纯读库渲染）
						onClick: function () {
							setRefreshing(true);
							fetch("/token-monitor/fold", { method: "POST" })
								.catch(function () {})
								.then(function () { load(days, client, provider, model, focus, true); });
						},
					}, refreshing ? t("usage.refreshing") : loading ? t("usage.loading") : t("usage.refresh"))),
				body,
				// 模型定价列表：放用量页最底部（数据来源之后），折叠展开
				(loading || error
					? null
					: h(ModelPricingPanel)));
		}

		/* ---------------------------- 设置页（settings.section） ---------------------------- */

		var CONFIG_URL = "/token-monitor/config";
		/** 设置页初始/默认值（与服务端 PLUGIN_CONFIG_DEFAULTS 一致；cache 为空时回退到这里）。 */
		var SETTINGS_DEFAULTS = { defaultDays: 1, pollMs: 60, retentionDays: 60 };
		/** 共享的最近一次 overview（供头部徽标、用量页、设置页复用；设置页据此同步回显，避免异步闪帧）。 */
		var overviewCache = null;
		/** 余量轮询可选项（单位：秒；全链路存秒，需要毫秒处单独 ×1000）。 */
		var POLL_MS_OPTIONS = [30, 60, 120, 300, 600];
		/** 请求记录保留时间可选项（单位：天）。 */
		var RETENTION_OPTIONS = [30, 60, 90];

		// 设置页按钮交互（对齐官方插件配置卡片 discard/save 的 CSS：hover + disabled；幂等注入一次）。
		// discard（恢复）hover 文字变亮；save 无 hover；两按钮 disabled 时 0.4 透明度。
		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"tm-settings-btn\"]")) {
			var tag = document.createElement("style");
			tag.dataset.pluginCss = "tm-settings-btn";
			tag.textContent =
				".tm-settings-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary)}" +
				".tm-settings-btn-primary:disabled,.tm-settings-btn-ghost:disabled{opacity:.4;cursor:default}";
			document.head.appendChild(tag);

		}

		// 设置页滚动容器：隐藏原生滚动条（仍可滚），避免展开"已适配供应商"后滚动条
		// 占位压缩内容宽度导致布局左右跳动。独立 style 标签保证 HMR 后仍能注入。
		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"tm-settings-scroll\"]")) {
			var scrollTag = document.createElement("style");
			scrollTag.dataset.pluginCss = "tm-settings-scroll";
			scrollTag.textContent =
				".tm-settings-scroll{scrollbar-width:none;-ms-overflow-style:none}" +
				".tm-settings-scroll::-webkit-scrollbar{display:none;width:0;height:0}";
			document.head.appendChild(scrollTag);
		}

		/** 仿 DSH 通用设置的一行：左（标题 + 说明）+ 右（控件）。数值对齐 ui-settings-general PermissionRow：
		 *  行 padding 16px 0、border-bottom；标题 14px/400/22px；说明 12px/400/18px；文本区 gap 4px、右侧留白 48px。 */
		function settingRow(title, desc, control) {
			return h("div", { style: {
				display: "flex", alignItems: "center", justifyContent: "space-between",
				gap: "8px", padding: "16px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
			} },
				h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0, flex: "1 1 auto", paddingRight: "48px" } },
					h("div", { style: { fontSize: "14px", fontWeight: 400, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" } }, title),
					desc ? h("div", { style: { fontSize: "12px", fontWeight: 400, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, desc) : null),
				h("div", { style: { flex: "none", display: "flex", alignItems: "center" } }, control));
		}

		/** 解析选项 label（支持函数，随语言切换重算）。 */
		function optionLabel(o) {
			return typeof o.label === "function" ? o.label() : o.label;
		}

		/** 官方 chevron-down 14px 图标：path 提取自 @deepseek-ai/dsh-client-ui-primitives 的 IconChevronDownOutline14
		 *  （该包被打包进 dsh web bundle、加载器不暴露，无法 import 组件；内联 svg 像素级复刻官方符号）。
		 *  open=true 时旋转 180° 朝上。 */
		function chevronDown14(open) {
			return h("svg", {
				width: 14, height: 14, viewBox: "0 0 14 14", fill: "none",
				style: { flex: "none", transform: open ? "rotate(180deg)" : "none" },
			},
				h("path", {
					d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
					fill: "currentColor",
				}));
		}

		/** 胶囊形下拉 + 自定义弹层菜单（对齐 DSH PopupSelect：胶囊按钮、圆角浮层、hover 高亮、选中打勾）。
		 *  props: { value, options: [{ v, label }], onChange(v) } */
		function pillSelect(props) {
			var rootRef = React.useRef(null);
			var openState = React.useState(false), open = openState[0], setOpen = openState[1];
			var hoverState = React.useState(null), hovered = hoverState[0], setHovered = hoverState[1];
			React.useEffect(function () {
				if (!open) return;
				function onDown(e) {
					if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
				}
				document.addEventListener("mousedown", onDown);
				return function () { document.removeEventListener("mousedown", onDown); };
			}, [open]);
			var sel = props.options.find(function (o) { return o.v === props.value; }) || props.options[0];
			return h("div", { ref: rootRef, style: { position: "relative", display: "inline-flex" } },
				h("button", {
					type: "button",
					onClick: function () { setOpen(!open); },
					style: {
						display: "inline-flex", alignItems: "center", gap: "8px",
						height: "36px", borderRadius: "18px", padding: "0 14px",
						background: "var(--dsw-alias-bg-module-platform)", cursor: "pointer", boxSizing: "border-box",
						border: "none", fontFamily: "inherit", fontSize: "14px", lineHeight: "22px",
						color: "var(--dsw-alias-label-primary)",
					},
				},
					h("span", { style: { maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, sel ? optionLabel(sel) : ""),
					chevronDown14(open)),
				open ? h("div", { style: S.popMenu },
					props.options.map(function (o) {
						var selected = o.v === props.value;
						return h("button", {
							type: "button", key: o.v,
							onMouseEnter: function () { setHovered(o.v); },
							onMouseLeave: function () { setHovered(null); },
							onClick: function () { props.onChange(o.v); setOpen(false); },
							style: (selected || hovered === o.v) ? Object.assign({}, S.popItem, S.popItemHover) : S.popItem,
						},
							h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, optionLabel(o)),
							selected ? h("span", { style: S.popCheck }, "✓") : null);
					})) : null);
		}

		/** DSH 设置面板 → Token Monitor 页：默认时间窗 / 余量轮询间隔（秒）/ 请求记录保留时间，保存写回 config.json。
		 *  首次渲染直接用共享 overview 缓存（或服务端默认值）同步回显，不存在"加载中/失败"占位帧；异步拉取仅在
		 *  用户未改动时静默刷新，避免数值跳变。 */

		/** 模型定价面板（用量页底部）：当前正在生效的版本列表，新增/编辑（封口+插入新版）。
		 *  列：模型 / 定价模式(固定|峰谷) / 币种 / 输入(命中|未命中) / 输出 / 高峰时段 / 高峰倍率 / 开始时间 / 操作。
		 *  只列 start_time <= now < end_time 的行：已封口的旧档、未开始的已公布未来档都不出现，
		 *  调价时点一到，重新拉取即自动换成新档行（开始时间即切换时刻）。
		 *  峰谷模型：高峰时段标签只显示"时段"（工作日/周末/每天 + HH:mm-HH:mm）；
		 *  倍率是模型级独立字段（peak_multiplier，默认 ×2）：列表单列展示、编辑时单输入框。
		 *  编辑交互：点"编辑"→ 整行就地在原行编辑（模式/币种/价格/倍率/开始时间输入都在本行），
		 *  高峰时段列 = 标签（点 × 删除）+ "+" 按钮弹出浮层新增；无额外表格行。
		 *  开始时间可改：默认当前时刻，改未来 = 预约调价到点生效（保存 = 封口前档 + 插入新档）。
		 *  单位 = 元（或币种）/ 百万 token；缓存创建不维护（按 0）。 */
		function ModelPricingPanel() {
			var _e = React.useState(false), expanded = _e[0], setExpanded = _e[1];
			var _r = React.useState(null), rows = _r[0], setRows = _r[1];
			var _m = React.useState(null), msg = _m[0], setMsg = _m[1];
			var _d = React.useState(null), draft = _d[0], setDraft = _d[1];
			var _ad = React.useState("1-5"), addDays = _ad[0], setAddDays = _ad[1];
			var _as = React.useState("09:00"), addStart = _as[0], setAddStart = _as[1];
			var _ae = React.useState("12:00"), addEnd = _ae[0], setAddEnd = _ae[1];
			var _ao = React.useState(false), addOpen = _ao[0], setAddOpen = _ao[1];
			var _so = React.useState(false), startOpen = _so[0], setStartOpen = _so[1];

			var DAY_OPTIONS = [
				{ v: "1-5", l: LANG === "zh" ? "工作日" : "weekday" },
				{ v: "6,7", l: LANG === "zh" ? "周末" : "weekend" },
				{ v: "*", l: LANG === "zh" ? "每天" : "daily" },
			];
			var load = React.useCallback(function () {
				fetch("/token-monitor/model-prices", { headers: { accept: "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (d) { if (d && d.ok) { setRows(d.rows || []); setMsg(null); } })
					.catch(function () {});
			}, []);
			React.useEffect(function () { if (expanded) load(); }, [expanded, load]);
			var peakRootRef = React.useRef(null);
			var startRootRef = React.useRef(null);
			React.useEffect(function () {
				if (!addOpen && !startOpen) return undefined;
				var onPointerDown = function (e) {
					if (!(e.target instanceof Node)) return;
					if (peakRootRef.current && !peakRootRef.current.contains(e.target)) setAddOpen(false);
					if (startRootRef.current && !startRootRef.current.contains(e.target)) setStartOpen(false);
				};
				var onKeyDown = function (e) {
					if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAddOpen(false); setStartOpen(false); }
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [addOpen, startOpen]);

			var fmtYuan = function (v) { return (v === null || v === undefined) ? "—" : String(Math.round(Number(v) * 1e4) / 1e4); };
			var fmtDate = function (ts) { return ts ? new Date(Number(ts) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") : "—"; };
			// datetime-local 输入值（YYYY-MM-DDTHH:mm，本地墙钟 = 北京）：与 fmtDate 同一 +8h 约定
			var dtLocal = function (ms) { return ms ? new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 16) : ""; };
			// 本地"当天 00:00"的毫秒（浏览器本地时区 = 北京）
			var dayStartMs = function () { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
			var modeLabel = function (m) { return m === "time" ? t("settings.pricing.modeTime") : t("settings.pricing.modeFixed"); };
			var dayLabel = function (d) {
				var o = DAY_OPTIONS.filter(function (x) { return x.v === d; })[0];
				return o ? o.l : d;
			};
			// peak_windows JSON → windows 数组 [{days,start,end}]（倍率是模型级字段，不进窗口）
			var windowsOf = function (rule) {
				if (!rule) return [];
				try {
					var r = JSON.parse(rule);
					return ((r && r.windows) || []).map(function (w) {
						return { days: w.days, start: w.start, end: w.end };
					});
				} catch (_e) { return []; }
			};
			// 高峰时段标签：内容宽度自适应、流式换行（不做拉伸填充）；标签只显示时段（工作日/周末/每天 + HH:mm–HH:mm），倍率不进标签文字
			// onRemove：点标签删除（带红 ×）；onPick：点标签打开编辑（不带 ×）
			var chipGrid = function (list, onRemove, onPick) {
				if (!list || list.length === 0) return null;
				return h("div", { style: { display: "flex", flexWrap: "wrap", gap: "3px", alignItems: "center" } },
					list.map(function (w, i) {
						return h("span", {
							key: w.days + w.start + w.end + i,
							onClick: onRemove ? function () { onRemove(i); } : (onPick ? function () { onPick(i); } : undefined),
							title: onRemove ? (LANG === "zh" ? "点击移除" : "click to remove")
								: (onPick ? (LANG === "zh" ? "点击编辑" : "click to edit") : dayLabel(w.days) + " " + w.start + "–" + w.end),
							style: {
								display: "inline-flex", alignItems: "center", gap: "4px", flex: "none",
								background: "rgba(128,128,128,0.12)", borderRadius: "4px",
								padding: "1px 6px", fontSize: "11px", lineHeight: "16px",
								color: "var(--dsw-alias-label-secondary)", cursor: onRemove || onPick ? "pointer" : "default",
								whiteSpace: "nowrap", maxWidth: "100%",
							},
						},
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } },
								dayLabel(w.days) + " " + w.start + "–" + w.end),
							onRemove ? h("span", { style: { color: "var(--dsw-alias-error, #ea4335)", flex: "none" } }, "×") : null);
					}));
			};

			// 编辑/新增行的"高峰时段"列：标签可点开弹窗（无独立 "+"）；无标签时占位文字即入口；fixed 显示 —
			var peakEditorCell = function () {
				if (draft.priceMode !== "time") return mutedDash();
				var ws = draft.windows || [];
				var DAYS = DAY_OPTIONS.map(function (o) { return { id: o.v, label: o.l }; });
				var noPeak = h("span", {
					role: "button", tabIndex: 0,
					title: LANG === "zh" ? "点击添加高峰时段" : "Click to add peak hours",
					style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", textDecoration: "underline dotted", cursor: "pointer" },
					onClick: openPeakPanel,
					onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPeakPanel(); } },
				}, LANG === "zh" ? "（无高峰时段，点击添加）" : "(no peak, click to add)");
				return h("div", { ref: peakRootRef, style: { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", position: "relative" } },
					ws.length
						? chipGrid(ws, null, openPeakPanel)
						: noPeak,
					addOpen
						? h("div", { style: Object.assign({}, S.filterMenu, { left: 0, top: "calc(100% + 4px)", zIndex: 130, minWidth: "0", padding: "6px", maxHeight: "none", overflow: "visible", width: "auto" }) },
							h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
								ws.length
									? h("div", { style: { display: "flex", flexDirection: "column", gap: "3px" } },
										ws.map(function (w, i) {
											return h("div", { key: i, style: { display: "flex", alignItems: "center", gap: "4px" } },
												h(FilterSelect, {
													options: DAYS,
													value: w.days,
													minWidth: "84px",
													onChange: function (v) { patchWindow(i, Object.assign({}, w, { days: v })); },
												}),
												rowSeg(i, "start", "hh", "start hour"), segSep(":"), rowSeg(i, "start", "mm", "start minute"),
												segSep("–", { margin: "0 5px" }),
												rowSeg(i, "end", "hh", "end hour"), segSep(":"), rowSeg(i, "end", "mm", "end minute"),
												h("button", {
													type: "button",
													title: LANG === "zh" ? "删除该时段" : "remove",
													style: Object.assign({}, S.windowBtn, { flex: "none", width: "30px", height: "20px", padding: "0", marginLeft: "12px", boxSizing: "border-box", color: "var(--dsw-alias-error, #ea4335)", borderColor: "rgba(234,67,53,0.35)" }),
													onClick: function () { removeWindow(i); },
												}, h("svg", {
													width: "16", height: "16", viewBox: "0 0 16 16",
													fill: "none", stroke: "currentColor", strokeWidth: "1.7",
													strokeLinecap: "round",
													style: { display: "block", margin: "0 auto" },
												},
													h("line", { x1: "4", y1: "4", x2: "12", y2: "12" }),
													h("line", { x1: "12", y1: "4", x2: "4", y2: "12" }))));
										}))
									: null,
								h("div", { style: ws.length
									? { display: "flex", alignItems: "center", gap: "4px", borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: "5px" }
									: { display: "flex", alignItems: "center", gap: "4px" } },
									h(FilterSelect, {
										options: DAYS,
										value: addDays,
										minWidth: "84px",
										onChange: function (v) { setAddDays(v); },
									}),
									timeSeg("start", "hh", "add start hour"), segSep(":"), timeSeg("start", "mm", "add start minute"),
									segSep("–", { margin: "0 5px" }),
									timeSeg("end", "hh", "add end hour"), segSep(":"), timeSeg("end", "mm", "add end minute"),
									h("button", {
										type: "button",
										title: LANG === "zh" ? "新增高峰时段" : "Add peak hour",
										style: Object.assign({}, S.windowBtn, { flex: "none", width: "30px", height: "20px", padding: "0", marginLeft: "12px", boxSizing: "border-box", color: "var(--dsw-alias-success, #34a853)", borderColor: "rgba(52,168,83,0.35)" }),
										onClick: addNewWindow,
									}, h("svg", {
										width: "16", height: "16", viewBox: "0 0 16 16",
										fill: "none", stroke: "currentColor", strokeWidth: "1.7",
										strokeLinecap: "round",
										style: { display: "block", margin: "0 auto" },
									},
										h("line", { x1: "8", y1: "4", x2: "8", y2: "12" }),
										h("line", { x1: "4", y1: "8", x2: "12", y2: "8" }))))))
						: null);
			};
			var beginEdit = function (row) {
				setDraft({
					editing: !!row,
					model: row ? row.model : "",
					priceMode: row ? row.mode : "fixed", // 新增默认"固定"（全天同价）；需要峰谷再切换
					currency: row ? row.currency : "CNY",
					cacheHitInput: row ? String(row.cacheHitInput) : "",
					input: row ? String(row.input) : "",
					output: row ? String(row.output) : "",
					multiplier: row && row.peakMultiplier != null ? String(row.peakMultiplier) : "2",
					windows: row ? windowsOf(row.peakWindows) : [],
					start: dtLocal(dayStartMs()), // 生效起点：默认当天 00:00；改未来 = 预约调价
				});
				setAddDays("1-5"); setAddStart("09:00"); setAddEnd("12:00");
			};
			var patch = function (k, v) { setDraft(function (d) { var n = {}; for (var x in d) n[x] = d[x]; n[k] = v; return n; }); };
			// 高峰时段弹窗：行内直接编辑（改即写草稿）；底部一行做新增
			var openPeakPanel = function () { setAddOpen(true); };
			var removeWindow = function (idx) {
				patch("windows", (draft.windows || []).filter(function (_, i) { return i !== idx; }));
			};
			var normTime = function (s) { var t = timePartsOf(s); return pad2(t.hh || "0") + ":" + pad2(t.mm || "0"); };
			var patchWindow = function (idx, w) {
				patch("windows", (draft.windows || []).map(function (x, i) { return i === idx ? w : x; }));
			};
			var setWindowTime = function (idx, field, part, raw) {
				var digits = String(raw == null ? "" : raw).replace(/\D/g, "");
				if (digits.length > 2) return;
				if (digits.length === 2 && part === "hh" && Number(digits) > 23) return;
				if (digits.length === 2 && part === "mm" && Number(digits) > 59) return;
				var w = (draft.windows || [])[idx];
				if (!w) return;
				var t = timePartsOf(w[field]);
				t[part] = digits;
				var next = {}; for (var x in w) next[x] = w[x];
				next[field] = (t.hh || "") + ":" + (t.mm || "");
				patchWindow(idx, next);
			};
			var addNewWindow = function () {
				if (addStart === "" || addEnd === "") return;
				patch("windows", (draft.windows || []).concat([{ days: addDays, start: normTime(addStart), end: normTime(addEnd) }]));
				setAddDays("1-5"); setAddStart("09:00"); setAddEnd("12:00");
			};
			// 开始时间 = 自绘"年-月-日 时:分"分段控件：draft.start 存 "YYYY-MM-DDTHH:mm"
			var pad2 = function (v) { v = String(v); return v.length === 1 ? "0" + v : v; };
			var startParts = function () {
				var s = (draft.start || "").split("T");
				var d = s[0] ? s[0].split("-") : [];
				var t = s[1] ? s[1].split(":") : [];
				return { y: d[0] || "", mo: d[1] || "", dd: d[2] || "", hh: t[0] || "", mm: t[1] || "" };
			};
			var setStartPart = function (key, raw) {
				var digits = String(raw == null ? "" : raw).replace(/\D/g, "");
				var p = startParts();
				if (key === "y") { if (digits.length > 4) return; }
				else if (digits.length > 2) return;
				// 越界只在位数打满时拦（1 位数字始终放行，方便连打）
				if (key === "mo" && digits.length === 2 && Number(digits) > 12) return;
				if (key === "dd" && digits.length === 2) {
					var yN = Number(p.y), moN = Number(p.mo);
					var maxD = (p.y && p.y.length >= 4 && p.mo && p.mo.length === 2 && yN >= 2000 && moN >= 1 && moN <= 12)
						? new Date(yN, moN, 0).getDate() : 31;
					if (Number(digits) > maxD) return;
				}
				if (key === "hh" && digits.length === 2 && Number(digits) > 23) return;
				if (key === "mm" && digits.length === 2 && Number(digits) > 59) return;
				p[key] = digits;
				patch("start", p.y + "-" + p.mo + "-" + p.dd + "T" + p.hh + ":" + p.mm);
			};
			var startSeg = function (key, label, w) {
				return h("input", {
					type: "text", inputMode: "numeric", maxLength: key === "y" ? 4 : 2,
					"aria-label": label,
					value: startParts()[key],
					style: {
						boxSizing: "border-box",
						width: w + "px", fontSize: "12px", lineHeight: "16px", padding: "1px 2px", textAlign: "center",
						border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "4px",
						background: "none", color: "var(--dsw-alias-label-primary)", outline: "none",
					},
					onChange: function (e) { setStartPart(key, e.target.value); },
				});
			};
			var segSep = function (ch, extra) {
				return h("span", { style: Object.assign({ color: "var(--dsw-alias-label-tertiary)", flex: "none" }, extra || {}) }, ch);
			};
			// 高峰时段的起止时间 = 同款自绘"时:分"分段输入（addStart/addEnd 存 "HH:mm"，输入过程允许 1 位原始数字）
			var timePartsOf = function (v) {
				var m = /^(\d*):(\d*)$/.exec(String(v == null ? "" : v));
				return m ? { hh: m[1], mm: m[2] } : { hh: "", mm: "" };
			};
			var setTimePart = function (kind, part, raw) {
				var digits = String(raw == null ? "" : raw).replace(/\D/g, "");
				if (digits.length > 2) return;
				if (digits.length === 2 && part === "hh" && Number(digits) > 23) return;
				if (digits.length === 2 && part === "mm" && Number(digits) > 59) return;
				var cur = kind === "start" ? addStart : addEnd;
				var t = timePartsOf(cur);
				t[part] = digits;
				var out = (t.hh || "") + ":" + (t.mm || "");
				if (kind === "start") setAddStart(out); else setAddEnd(out);
			};
			var segBoxS = {
				boxSizing: "border-box",
				width: "24px", fontSize: "12px", lineHeight: "16px", padding: "1px 2px", textAlign: "center",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "4px",
				background: "none", color: "var(--dsw-alias-label-primary)", outline: "none",
			};
			var timeSeg = function (kind, part, label) {
				var cur = kind === "start" ? addStart : addEnd;
				var t = timePartsOf(cur);
				return h("input", {
					type: "text", inputMode: "numeric", maxLength: 2,
					"aria-label": label,
					value: t[part],
					style: segBoxS,
					onChange: function (e) { setTimePart(kind, part, e.target.value); },
				});
			};
			// 弹窗列表行内的时段分段输入：直接读写 draft.windows[idx] 的 start/end
			var rowSeg = function (idx, field, part, label) {
				var w = (draft.windows || [])[idx];
				if (!w) return null;
				var t = timePartsOf(w[field]);
				return h("input", {
					type: "text", inputMode: "numeric", maxLength: 2,
					"aria-label": label,
					value: t[part],
					style: segBoxS,
					onChange: function (e) { setWindowTime(idx, field, part, e.target.value); },
				});
			};
			var save = function () {
				if (!draft || !(draft.model && draft.model.trim())) return;
				setMsg(null);
				var isTime = draft.priceMode === "time";
				var mk = Number(draft.multiplier);
				var payload = {
					model: draft.model.trim(),
					mode: draft.priceMode, currency: draft.currency,
					cacheHitInput: Number(draft.cacheHitInput), input: Number(draft.input),
					output: Number(draft.output), cacheCreate: 0,
				};
				if (draft.start) {
					// 输入过程允许原始 1–2 位数字；保存时校验并补零成标准 "YYYY-MM-DDTHH:mm"
					var ps2 = startParts();
					var year2 = ps2.y, mo2 = ps2.mo, dd2 = ps2.dd, hh2 = ps2.hh, mm2 = ps2.mm;
					if (!/^\d{4}$/.test(year2)) { setMsg(LANG === "zh" ? "开始时间需补全年份（4 位数字）" : "Year must be 4 digits"); return; }
					if (mo2 === "" || dd2 === "" || hh2 === "" || mm2 === "") { setMsg(LANG === "zh" ? "开始时间不完整，请补全月/日/时/分" : "Start time is incomplete"); return; }
					var moN2 = Number(mo2), ddN2 = Number(dd2), hhN2 = Number(hh2), mmN2 = Number(mm2);
					if (moN2 < 1 || moN2 > 12 || hhN2 > 23 || mmN2 > 59) { setMsg(LANG === "zh" ? "开始时间的月/日/时/分超出范围" : "Start time out of range"); return; }
					var maxD2 = new Date(Number(year2), moN2, 0).getDate();
					if (ddN2 < 1 || ddN2 > maxD2) { setMsg(LANG === "zh" ? "该月份没有这一天" : "Invalid day for month"); return; }
					payload.startTime = Date.parse(year2 + "-" + pad2(mo2) + "-" + pad2(dd2) + "T" + pad2(hh2) + ":" + pad2(mm2));
				}
				if (isTime) {
					payload.multiplier = isFinite(mk) && mk > 0 ? mk : 2;
					payload.windows = draft.windows; // 空数组 = 无高峰（全天按基础价），显式传
				}
				fetch("/token-monitor/model-prices", {
					method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify(payload),
				}).then(function (r) { return r.json(); })
					.then(function (d) {
						if (d && d.ok) { setDraft(null); setMsg(t("settings.pricing.saved")); load(); }
						else setMsg((d && d.error) || t("settings.pricing.saveFailed"));
					})
					.catch(function () { setMsg(t("settings.pricing.saveFailed")); });
			};

			var numCell = function (v) { return h("td", { style: { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, fmtYuan(v)); };
			var td = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)", whiteSpace: "nowrap" };
			var tdWrap = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)", whiteSpace: "normal" };
			var inputS = Object.assign({}, S.windowBtn, { width: "76px", padding: "2px 6px", textAlign: "left", outline: "none" });

			// 编辑输入区（替换数据行的下方展开；编辑已有行时，时段标签保留在数据行上点删，这里不再重复）
			// 字段输入控件（与所在列同宽）与高峰倍率输入
			var editFill = function () { return Object.assign({}, inputS, { width: "100%", boxSizing: "border-box", minWidth: "0" }); };
			var editNum = function (k) {
				var fill = editFill();
				return h("input", { style: fill, type: "number", step: "any", min: "0", value: draft[k],
					onChange: function (e) { patch(k, e.target.value); } });
			};
			var editMultInput = function (fill) {
				return h("input", { style: fill, type: "number", step: "any", min: "0.1", value: draft.multiplier,
					title: LANG === "zh" ? "高峰倍率（默认 2）" : "peak multiplier (default 2)",
					onChange: function (e) { patch("multiplier", e.target.value); } });
			};
			var actionBtns = function () {
				return h("span", { style: { display: "inline-flex", gap: "4px" } },
					h("button", { type: "button", style: S.windowBtn, onClick: function () { setDraft(null); } }, t("settings.pricing.cancel")),
					h("button", { type: "button", style: S.windowBtn, onClick: save }, t("settings.pricing.save")));
			};
			// 新增模型（无数据行）：整行字段输入 + 峰谷时高峰时段管理行（点标签删除、右侧新增）
			var editableRows = function () {
				var isTime = draft.priceMode === "time";
				var fill = editFill();
				var rows2 = [];
				rows2.push(h("tr", { key: "__new" },
					h("td", { style: Object.assign({}, td, { paddingLeft: 0 }) }, h("input", { style: fill, placeholder: t("settings.pricing.namePlaceholder"), value: draft.model, onChange: function (e) { patch("model", e.target.value); } })),
					h("td", { style: td }, h(FilterSelect, {
						options: [
							{ id: "time", label: t("settings.pricing.modeTime") },
							{ id: "fixed", label: t("settings.pricing.modeFixed") },
						],
						value: draft.priceMode,
						minWidth: "0",
						rootStyle: { width: "100%" },
						style: Object.assign({}, S.windowBtn, { width: "100%", padding: "2px 6px" }),
						onChange: function (v) { patch("priceMode", v); },
					})),
					h("td", { style: td }, h(FilterSelect, {
						options: [
							{ id: "CNY", label: "CNY" },
							{ id: "USD", label: "USD" },
						],
						value: draft.currency,
						minWidth: "0",
						rootStyle: { width: "100%" },
						style: Object.assign({}, S.windowBtn, { width: "100%", padding: "2px 6px" }),
						onChange: function (v) { patch("currency", v); },
					})),
					h("td", { style: td }, editNum("cacheHitInput")),
					h("td", { style: td }, editNum("input")),
					h("td", { style: td }, editNum("output")),
					h("td", { style: tdWrap }, peakEditorCell()),
					h("td", { style: td }, isTime ? editMultInput(fill) : mutedDash()),
					h("td", { style: td }, h("div", { ref: startRootRef, style: { position: "relative", width: "100%" } },
						h("button", {
							type: "button",
							title: LANG === "zh" ? "生效起点：默认当天 00:00；选未来日期 = 预约调价，到点自动生效" : "Effective from (click to change)",
							style: Object.assign({}, S.windowBtn, {
								width: "100%", padding: "2px 6px", fontSize: "11px",
								display: "inline-flex", justifyContent: "space-between", alignItems: "center",
							}),
							onClick: function () { setStartOpen(!startOpen); },
						},
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
								(draft.start || dtLocal(Date.now())).replace("T", " ")),
							h("svg", {
								width: "10", height: "6", viewBox: "0 0 10 6",
								fill: "none", stroke: "currentColor", strokeWidth: "1.5",
								strokeLinecap: "round", strokeLinejoin: "round",
								style: { flex: "none", marginLeft: "6px" },
							}, h("path", { d: startOpen ? "M1 5l4-4 4 4" : "M1 1l4 4 4-4" }))),
						startOpen
							? h("div", {
								style: Object.assign({}, S.filterMenu, { right: 0, left: "auto", top: "calc(100% + 4px)", zIndex: 130, minWidth: "150px", padding: "6px", width: "auto" }),
							},
								h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
									h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
										startSeg("y", LANG === "zh" ? "年" : "year", 36),
										segSep("-"),
										startSeg("mo", LANG === "zh" ? "月" : "month", 22),
										segSep("-"),
										startSeg("dd", LANG === "zh" ? "日" : "day", 22),
										segSep("·", { margin: "0 8px" }),
										startSeg("hh", LANG === "zh" ? "时" : "hour", 20),
										segSep(":"),
										startSeg("mm", LANG === "zh" ? "分" : "minute", 20)),
									h("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" } },
										LANG === "zh"
											? "默认当天（保存即刻生效）"
											: "Today by default (effective immediately)")))
							: null)),
					h("td", { style: Object.assign({}, td, { paddingRight: 0, whiteSpace: "nowrap" }) }, actionBtns())));
				return rows2;
			};
			// 编辑已有模型：原行就地全字段输入（高峰时段标签 + "+" 新增都在高峰时段列内完成）
			var editRows = function (row) {
				var isTime = draft.priceMode === "time";
				var fill = editFill();
				var out = [];
				out.push(h("tr", { key: "__edit-" + draft.model },
					h("td", { style: Object.assign({}, td, { paddingLeft: 0 }) }, h("span", {
						title: draft.model,
						style: { color: "var(--dsw-alias-label-tertiary)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
					}, draft.model)),
					h("td", { style: td }, h(FilterSelect, {
						options: [
							{ id: "time", label: t("settings.pricing.modeTime") },
							{ id: "fixed", label: t("settings.pricing.modeFixed") },
						],
						value: draft.priceMode,
						minWidth: "0",
						rootStyle: { width: "100%" },
						style: Object.assign({}, S.windowBtn, { width: "100%", padding: "2px 6px" }),
						onChange: function (v) { patch("priceMode", v); },
					})),
					h("td", { style: td }, h(FilterSelect, {
						options: [
							{ id: "CNY", label: "CNY" },
							{ id: "USD", label: "USD" },
						],
						value: draft.currency,
						minWidth: "0",
						rootStyle: { width: "100%" },
						style: Object.assign({}, S.windowBtn, { width: "100%", padding: "2px 6px" }),
						onChange: function (v) { patch("currency", v); },
					})),
					h("td", { style: td }, editNum("cacheHitInput")),
					h("td", { style: td }, editNum("input")),
					h("td", { style: td }, editNum("output")),
					h("td", { style: tdWrap }, peakEditorCell()),
					h("td", { style: td }, isTime ? editMultInput(fill) : mutedDash()),
					h("td", { style: td }, h("div", { ref: startRootRef, style: { position: "relative", width: "100%" } },
						h("button", {
							type: "button",
							title: LANG === "zh" ? "生效起点：默认当天 00:00；选未来日期 = 预约调价，到点自动生效" : "Effective from (click to change)",
							style: Object.assign({}, S.windowBtn, {
								width: "100%", padding: "2px 6px", fontSize: "11px",
								display: "inline-flex", justifyContent: "space-between", alignItems: "center",
							}),
							onClick: function () { setStartOpen(!startOpen); },
						},
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
								(draft.start || dtLocal(Date.now())).replace("T", " ")),
							h("svg", {
								width: "10", height: "6", viewBox: "0 0 10 6",
								fill: "none", stroke: "currentColor", strokeWidth: "1.5",
								strokeLinecap: "round", strokeLinejoin: "round",
								style: { flex: "none", marginLeft: "6px" },
							}, h("path", { d: startOpen ? "M1 5l4-4 4 4" : "M1 1l4 4 4-4" }))),
						startOpen
							? h("div", {
								style: Object.assign({}, S.filterMenu, { right: 0, left: "auto", top: "calc(100% + 4px)", zIndex: 130, minWidth: "150px", padding: "6px", width: "auto" }),
							},
								h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
									h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
										startSeg("y", LANG === "zh" ? "年" : "year", 36),
										segSep("-"),
										startSeg("mo", LANG === "zh" ? "月" : "month", 22),
										segSep("-"),
										startSeg("dd", LANG === "zh" ? "日" : "day", 22),
										segSep("·", { margin: "0 8px" }),
										startSeg("hh", LANG === "zh" ? "时" : "hour", 20),
										segSep(":"),
										startSeg("mm", LANG === "zh" ? "分" : "minute", 20)),
									h("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" } },
										LANG === "zh"
											? "默认当天（保存即刻生效）"
											: "Today by default (effective immediately)")))
							: null)),
					h("td", { style: Object.assign({}, td, { paddingRight: 0, whiteSpace: "nowrap" }) }, actionBtns())));
				return out;
			};
			var fmtMult = function (v) { return v == null ? "" : String(Math.round(Number(v) * 100) / 100); };
			var mutedDash = function () { return h("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "—"); };
			// 数据行：当前生效价只读展示
			var viewRow = function (row) {
				var ws = windowsOf(row.peakWindows);
				return h("tr", { key: row.model },
					h("td", {
						title: row.model,
						style: Object.assign({}, td, { paddingLeft: 0, color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis" }),
					}, row.model),
					h("td", { style: td }, modeLabel(row.mode)),
					h("td", { style: td }, row.currency),
					numCell(row.cacheHitInput), numCell(row.input), numCell(row.output),
					h("td", { style: tdWrap },
						row.mode === "time" && ws.length
							? chipGrid(ws)
							: mutedDash()),
					h("td", { style: td },
						row.mode === "time" && row.peakMultiplier != null
							? "×" + fmtMult(row.peakMultiplier)
							: mutedDash()),
					h("td", { style: td }, fmtDate(row.startTime)),
					h("td", { style: Object.assign({}, td, { paddingRight: 0 }) },
						h("button", { type: "button", style: S.windowBtn, onClick: function () { beginEdit(row); } }, t("settings.pricing.edit"))));
			};

			var thead = h("thead", null, h("tr", null,
				h("th", { style: Object.assign({}, thSt(), { paddingLeft: 0, width: "15%" }) }, t("settings.pricing.colModel")),
				h("th", { style: Object.assign({}, thSt(), { width: "6%" }) }, t("settings.pricing.colMode")),
				h("th", { style: Object.assign({}, thSt(), { width: "6%" }) }, t("settings.pricing.colCurrency")),
				h("th", { style: Object.assign({}, thSt(), { width: "8%" }) }, t("settings.pricing.colCacheHit")),
				h("th", { style: Object.assign({}, thSt(), { width: "8%" }) }, t("settings.pricing.colInput")),
				h("th", { style: Object.assign({}, thSt(), { width: "5%" }) }, t("settings.pricing.colOutput")),
				h("th", { style: Object.assign({}, thSt(), { width: "23%" }) }, t("settings.pricing.colPeak")),
				h("th", { style: Object.assign({}, thSt(), { width: "6%" }) }, t("settings.pricing.colMultiplier")),
				h("th", { style: Object.assign({}, thSt(), { width: "11%" }) }, t("settings.pricing.colSince")),
				h("th", { style: Object.assign({}, thSt(), { width: "12%", paddingRight: 0 }) }, t("settings.pricing.colAction"))));
			function thSt() { return { textAlign: "left", padding: "4px 8px", color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l2)", whiteSpace: "nowrap" }; }

			var trs = [];
			(rows || []).forEach(function (row) {
				if (draft && draft.editing && draft.model === row.model) {
					var es = editRows(row);                // 原行就地编辑（高峰时段列内含标签点删 + "+" 浮层新增）
					for (var i = 0; i < es.length; i++) trs.push(es[i]);
				} else trs.push(viewRow(row));
			});
			if (draft && !draft.editing) {
				var ns = editableRows();
				for (var j = 0; j < ns.length; j++) trs.push(ns[j]);
			}
			if (!draft || draft.editing) {
				// 底部"新增"空行：平时常驻；编辑已有行时保留；仅"新增草稿"编辑中隐藏（避免重复入口）
				trs.push(h("tr", { key: "__add-row", style: { background: "transparent" } },
					h("td", {
						colSpan: 9,
						style: Object.assign({}, td, { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" }),
					},
						LANG === "zh" ? "＋ 为其它模型添加定价" : "＋ Add pricing for another model"),
					h("td", { style: Object.assign({}, td, { paddingRight: 0, whiteSpace: "nowrap" }) },
						h("button", {
							type: "button",
							title: LANG === "zh" ? "新增定价行" : "Add a pricing row",
							style: Object.assign({}, S.windowBtn, { color: "var(--dsw-alias-label-secondary)" }),
							onClick: function () { beginEdit(null); },
						}, t("settings.pricing.add")))));
			}

			var body = null;
			if (rows === null) body = h("div", { style: S.muted }, t("settings.pricing.loading"));
			else if (trs.length === 0) body = h("div", { style: S.muted }, t("settings.pricing.noData"));
			else body = h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px", tableLayout: "fixed" } },
				thead, h("tbody", null, trs));

			return h("div", { style: S.usageCard },
				h("div", {
					role: "button", tabIndex: 0, title: t("settings.pricing.title"),
					onClick: function () { setExpanded(!expanded); },
					onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } },
					style: { width: "100%", display: "flex", alignItems: "center", gap: "2px", cursor: "pointer", padding: "0", fontFamily: "inherit" },
				},
					h("div", { style: S.usageCardTitle }, t("settings.pricing.title")),
					h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" } },
						t("settings.pricing.hint")),
					h("span", { style: { flex: "1 1 auto" } }),
					chevronDown14(expanded)),
				expanded
					? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
						msg ? h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-success, #34a853)", lineHeight: "16px" } }, msg) : null,
						body)
					: null);
		}

		/** 版本号前 3 段数值比较（"1.0.6" 与 "v1.0.6" 视为同一个版本）。 */
		function sameVer(a, b) {
			if (!a || !b) return false;
			var part = function (x) {
				return String(x).split(".").slice(0, 3).map(function (n) { return parseInt(n, 10) || 0; });
			};
			var x = part(a), y = part(b);
			return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
		}

		/** 数据来源卡"最近同步"：最近一次同步导入的条数（无记录显示 —）。 */
		function fmtSyncRows(x) {
			if (!x) return "—";
			return t("src.syncRows", { n: x.imported });
		}

		function SettingsView() {
			var init = (overviewCache && overviewCache.pluginSettings) ? overviewCache.pluginSettings : SETTINGS_DEFAULTS;
			var cfgState = React.useState(init);            // 生效配置（缓存或服务端默认）
			var cfg = cfgState[0], setCfg = cfgState[1];
			var draftState = React.useState(init);          // 表单草稿，首帧即回显
			var draft = draftState[0], setDraft = draftState[1];
			var uiState = React.useState({ saving: false, savedAt: 0, err: "" });
			var busy = uiState[0], setBusy = uiState[1];
			var touchedRef = React.useRef(false);           // 用户是否改动过（改动后不再被后台回显覆盖）

			// 已适配供应商清单（/token-monitor/adapters）；可折叠，默认收起
			var adaptersState = React.useState(null);
			var adapters = adaptersState[0], setAdapters = adaptersState[1];
			var adaptersOpenState = React.useState(false);
			var adaptersExpanded = adaptersOpenState[0], setAdaptersExpanded = adaptersOpenState[1];
			// 版本更新行状态：版本信息 / 升级中 / 升级结果
			// 初始即带当前版本（overview 共享缓存）：首帧就显示"当前版本 vX（已是最新版本）"，不闪兜底文案
			var _version = React.useState(function () {
				var cv = (overviewCache && overviewCache.version) || null;
				return { current: cv, latest: null, hasUpdate: false, channel: "unknown", dep: null };
			});
			var version = _version[0], setVersion = _version[1];
			var _upgrading = React.useState(false), upgrading = _upgrading[0], setUpgrading = _upgrading[1];
			var _upResult = React.useState(null), upgradeResult = _upResult[0], setUpgradeResult = _upResult[1];
			React.useEffect(function () {
				var disposed = false;
				// 版本路由兜底：失败时用 overview 下发的当前版本（共享缓存）按"已是最新"显示
				var fallback = function () {
					var cv = (overviewCache && overviewCache.version) || null;
					if (!disposed) setVersion({ current: cv, latest: null, hasUpdate: false });
				};
				fetch("/token-monitor/version", { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : null; })
					.then(function (d) { if (!disposed) { if (d && d.ok) setVersion(d); else fallback(); } })
					.catch(fallback);
				return function () { disposed = true; };
			}, []);
			React.useEffect(function () {
				var disposed = false;
				fetch("/token-monitor/adapters", { headers: { accept: "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (d) { if (!disposed && d && d.ok) setAdapters(d.groups || []); })
					.catch(function () {});
				return function () { disposed = true; };
			}, []);

			React.useEffect(function () {
				var disposed = false;
				fetch(OVERVIEW_URL, { headers: { accept: "application/json" } })
					.then(function (r) { return r.json(); })
					.then(function (d) {
						if (disposed || !d || !d.pluginSettings) return;
						overviewCache = d; // 刷新共享缓存
						if (!touchedRef.current) { // 用户未改 → 回显服务端最新（通常与缓存一致，无跳变）
							setCfg(d.pluginSettings);
							setDraft(d.pluginSettings);
						}
					})
					.catch(function () { /* 静默：保持当前渲染值 */ });
				return function () { disposed = true; };
			}, []);

			function save() {
				if (!draft) return;
				setBusy({ saving: true, savedAt: 0, err: "" });
				fetch(CONFIG_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					// pollMs 全链路统一存秒（config.json / draft / 下拉），无需换算
					body: JSON.stringify({
						defaultDays: Number(draft.defaultDays),
						pollMs: Number(draft.pollMs),
						retentionDays: Number(draft.retentionDays),
					}),
				})
					.then(function (r) { return r.json(); })
					.then(function (d) {
						if (d && d.ok && d.pluginSettings) {
							setCfg(d.pluginSettings);
							setDraft(d.pluginSettings);
							setBusy({ saving: false, savedAt: Date.now(), err: "" });
							// 同步共享缓存 + 广播：头部立即重拉（pollMs 即时生效）、用量页未手切时更新默认时间窗
							if (overviewCache) { overviewCache.pluginSettings = d.pluginSettings; }
							else { overviewCache = { pluginSettings: d.pluginSettings }; }
							try { window.dispatchEvent(new Event("token-monitor:settings-saved")); } catch (_e) { /* 忽略 */ }
						} else {
							setBusy({ saving: false, savedAt: 0, err: t("settings.saveFailed") });
						}
					})
					.catch(function (e) {
						setBusy({ saving: false, savedAt: 0, err: String((e && e.message) || e) });
					});
			}

			function reset() {
				if (!cfg) return;
				var c = {}; for (var k in cfg) c[k] = cfg[k];
				setDraft(c);
			}

			/** 是否有未保存的改动（草稿 ≠ 生效配置）：恢复按钮据此启用/禁用。 */
			function hasChanges() {
				if (!draft || !cfg) return false;
				return Number(draft.defaultDays) !== Number(cfg.defaultDays)
					|| Number(draft.pollMs) !== Number(cfg.pollMs)
					|| Number(draft.retentionDays) !== Number(cfg.retentionDays);
			}
			var dirty = hasChanges();

			// 默认时间窗下拉：与用量页时间窗共用 WINDOW_OPTIONS；若 config 里的值不在列表（手改），兜底插入一项以回显
			var windowOptions = WINDOW_OPTIONS.slice();
			if (!windowOptions.some(function (o) { return o.v === Number(draft.defaultDays); })) {
				var cur = Number(draft.defaultDays);
				windowOptions.unshift({ v: cur, label: function () { return t("usage.windowDays", { d: cur }); } });
			}

			var rows = [
				settingRow(t("settings.defaultDays"), t("settings.defaultDays.hint"),
					h(pillSelect, {
						value: Number(draft.defaultDays),
						options: windowOptions,
						onChange: function (v) {
							touchedRef.current = true;
							var next = {}; for (var k in draft) next[k] = draft[k];
							next.defaultDays = String(v);
							setDraft(next);
						},
					})),
				settingRow(t("settings.pollMs"), t("settings.pollMs.hint", { sec: Number(draft.pollMs) }),
					h(pillSelect, {
						value: Number(draft.pollMs),
						options: POLL_MS_OPTIONS.map(function (s) { return { v: s, label: String(s) + t("unit.second") }; }),
						onChange: function (v) {
							touchedRef.current = true;
							var next = {}; for (var k in draft) next[k] = draft[k];
							next.pollMs = Number(v);
							setDraft(next);
						},
					})),
				settingRow(t("settings.retentionDays"), t("settings.retentionDays.hint"),
					h(pillSelect, {
						value: Number(draft.retentionDays),
						options: RETENTION_OPTIONS.map(function (d) {
							return { v: d, label: t("usage.windowDays", { d: d }) };
						}),
						onChange: function (v) {
							touchedRef.current = true;
							var next = {}; for (var k in draft) next[k] = draft[k];
							next.retentionDays = String(v);
							setDraft(next);
						},
					})),
			];

			return h("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				h("div", { className: "tm-settings-scroll", style: { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, overflow: "auto" } },
				rows,
				h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "16px 2px", borderBottom: "1px solid var(--dsw-alias-border-l2)" } },
					h("button", {
						type: "button",
						onClick: function () { setAdaptersExpanded(!adaptersExpanded); },
						style: {
							width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
							background: "none", border: "none", cursor: "pointer", padding: "0 12px 0 0",
							fontFamily: "inherit",
						},
					},
						h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", textAlign: "left" } },
							h("span", { style: { fontSize: "14px", fontWeight: 500, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" } },
								t("settings.adapters.title")),
							h("span", { style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } },
								t("settings.adapters.hint"))),
						chevronDown14(adaptersExpanded)),
					adaptersExpanded
						? (adapters === null
							? h("div", { style: S.muted }, t("settings.adapters.loading"))
							: h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
							h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } },
							h("thead", null, h("tr", null,
								h("th", { style: { textAlign: "left", padding: "4px 8px 4px 0", color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l2)" } }, t("settings.adapters.colVendor")),
								h("th", { style: { textAlign: "left", padding: "4px 8px", color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l2)" } }, t("settings.adapters.colProvider")),
								h("th", { style: { textAlign: "left", padding: "4px 8px", color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l2)" } }, t("settings.adapters.colAdapted")),
								h("th", { style: { textAlign: "left", padding: "4px 0 4px 8px", color: "var(--dsw-alias-label-tertiary)", fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l2)" } }, t("settings.adapters.colVerified")))),
							h("tbody", null, adapters.reduce(function (rows, g) {
									var cellStyle = { padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)" };
									g.providers.forEach(function (p, pi) {
										rows.push(h("tr", { key: p.id },
											pi === 0
												? h("td", { rowSpan: g.providers.length, style: Object.assign({}, cellStyle, { paddingLeft: 0, color: "var(--dsw-alias-label-primary)", verticalAlign: "middle" }) }, g.vendor)
												: null,
											h("td", { style: Object.assign({}, cellStyle, { color: "var(--dsw-alias-label-primary)" }) }, p.provider),
											h("td", { style: Object.assign({}, cellStyle, { color: "var(--dsw-alias-label-secondary)" }) }, p.adapted ? t("settings.adapters.yes") : "—"),
											h("td", { style: Object.assign({}, cellStyle, { paddingRight: 0, color: p.verified ? "var(--dsw-alias-success, #34a853)" : "var(--dsw-alias-label-tertiary)" }) },
												p.verified ? t("settings.adapters.verified") : t("settings.adapters.pending"))));
									});
									return rows;
								}, []))),
								h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px", padding: "4px 2px 0" } },
									t("settings.adapters.note")))) : null),
				// 版本更新行：标题 + 当前/新版本副标题 + 右侧升级按钮
				// 三态全部由 /version 的数据推导：升级会原地重写本插件自己的 lib/client.js，
				// 而 DSH 的 client-hmr 在 web profile 里无条件挂载、每 500ms 轮询每个客户端
				// bundle 的 mtime/size，一有变化就热替换该插件（拆旧 fiber → 重新执行 bundle →
				// 重新挂载），插件内的 React state 随之清零。因此"升级成功、需重启"这类必须
				// 长期可见的信息不能只放在组件内存里，要能从服务端数据重新算出来。
				(function () {
					// 版本接口失败也显示该行（兜底对象带缓存的当前版本）
					var v = version || { current: null, latest: null, hasUpdate: false, channel: "unknown", dep: null };
					// 仅 npm/github 渠道支持在线升级；link（本地挂载）与 unknown（接口失败/无依赖声明）不支持
					var canUpgrade = (v.channel === "npm" || v.channel === "github") && !!v.hasUpdate;
					// 第三态"已下载未重启"：服务端说没有可升级的新版（hasUpdate 取磁盘版本与
					// latest 比），但进程里跑的版本并不是 latest —— 即新版已落盘、只差重启。
					// 判据刻意不依赖 installed 字段：这样对接旧版宿主（不发 installed）也成立。
					var restartPending = (v.channel === "npm" || v.channel === "github")
						&& !!v.latest && !!v.current && !v.hasUpdate && !sameVer(v.current, v.latest);
					var verTitle = t("settings.version.title");
					// 副标题三态：可升级 → 提示新版本；已下载未重启 → 当前运行 + 已下载；
					// 其余按最新。link 显示版本 + 渠道依赖原文；unknown 恒显示"已是最新"。
					var verDesc;
					if (v.channel === "link") {
						verDesc = (v.current ? t("settings.version.current", { v: v.current }) : "")
							+ "（" + t("settings.version.channelLink") + (v.dep ? "：" + v.dep : "") + "）";
					} else if (v.channel === "npm" || v.channel === "github") {
						if (canUpgrade) verDesc = t("settings.version.found", { v: v.latest, c: v.current });
						else if (restartPending) verDesc = (v.current ? t("settings.version.current", { v: v.current }) : t("settings.version.latest"))
							+ (v.installed ? "（" + t("settings.version.downloaded", { v: v.installed }) + "）" : "");
						else verDesc = v.current ? t("settings.version.current", { v: v.current }) + "（" + t("settings.version.latest") + "）" : t("settings.version.latest");
					} else {
						verDesc = v.current ? t("settings.version.current", { v: v.current }) + "（" + t("settings.version.latest") + "）" : t("settings.version.latest");
					}
					// 右侧文案：本次点击的结果优先（错误必须能看见）；否则"已下载未重启"常驻绿字。
					var rightText = upgradeResult ? upgradeResult.text : (restartPending ? t("settings.version.ok") : null);
					var rightOk = upgradeResult ? upgradeResult.ok : true;
					return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)" } },
						h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
							h("span", { style: { fontSize: "14px", fontWeight: 500, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" } }, verTitle),
							h("span", { style: { display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", lineHeight: "18px", color: v.hasUpdate ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)" } },
								// 有新版：前置绿色小圆点 + 文案转主文字色（不再绿色高亮）
								v.hasUpdate
									? h("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: "var(--dsw-alias-success, #34a853)", flex: "none" } })
									: null,
								verDesc)),
						h("div", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } },
							rightText
								? h("span", { style: { fontSize: "11px", color: rightOk ? "var(--dsw-alias-success, #34a853)" : "var(--dsw-alias-error, #ea4335)" } }, rightText)
								: null,
							// 已下载待重启：不再显示（灰掉的）升级按钮，避免与"重启后生效"并列产生歧义
							restartPending ? null : h("button", {
								type: "button",
								// 仅 npm/github 且有新版本时可点；link/unknown 恒禁用
								disabled: !canUpgrade || upgrading,
								// 与设置页下拉同款胶囊（高 36/圆角 18/字号 14）；可升级时换保存按钮同款主题（反色填充）
								style: Object.assign({
									display: "inline-flex", alignItems: "center", gap: "8px",
									height: "36px", borderRadius: "18px", padding: "0 22px",
									boxSizing: "border-box", border: "none", fontFamily: "inherit",
									fontSize: "14px", lineHeight: "22px",
									cursor: canUpgrade && !upgrading ? "pointer" : "default",
								}, canUpgrade && !upgrading
									? { background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)" }
									: { background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-tertiary)" }),
								onMouseDown: function (e) { e.preventDefault(); },
								onClick: function () {
									if (!canUpgrade || upgrading) return;
									setUpgrading(true);
									setUpgradeResult(null);
									fetch("/token-monitor/upgrade", { method: "POST" })
										.then(function (r) { return r.json(); })
										.then(function (d) {
											if (d && d.ok) {
												// 宿主已做"退出码 + 落盘版本"双重校验；服务端插件需重启 dsh web 才加载。
												// 该提示即使因 HMR 热替换丢内存，也会由 restartPending（/version 数据）续上。
												setUpgradeResult({ ok: true, text: t("settings.version.ok") });
											} else if (d && d.error) {
												// 直接展示宿主可读错误（含 link 渠道说明 / 版本未到位等），细节截断附尾
												setUpgradeResult({ ok: false, text: d.error + (d.detail ? "\n" + String(d.detail).slice(0, 300) : "") });
											} else {
												setUpgradeResult({ ok: false, text: t("settings.version.failed") });
											}
										})
										.catch(function () { setUpgradeResult({ ok: false, text: t("settings.version.failed") }); })
										.then(function () { setUpgrading(false); });
								},
							}, upgrading ? t("settings.version.upgrading") : t("settings.version.upgrade"))));
				})(),
				),
				h("div", { style: {
					position: "sticky", bottom: 0,
					background: "var(--dsw-alias-bg-layer-2)",
					display: "flex", alignItems: "center", justifyContent: "flex-end",
					gap: "8px", padding: "16px 2px",
				} },
					busy.savedAt
						? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-success, #34a853)" } }, t("settings.saved"))
						: busy.err
							? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-error, #ea4335)" } }, busy.err)
							: null,
					h("button", {
						onClick: reset,
						disabled: busy.saving || !dirty,
						style: S.btnGhost,
						className: "tm-settings-btn tm-settings-btn-ghost",
					}, t("settings.reset")),
					h("button", {
						onClick: save,
						disabled: busy.saving || !dirty,
						style: S.btnPrimary,
						className: "tm-settings-btn tm-settings-btn-primary",
					}, busy.saving ? "…" : t("settings.save"))));
		}

		/* ---------------------------- 插件入口 ---------------------------- */

		function apply(ctx) {
			try {
				apiRef.current = ctx.connection ? ctx.connection.api : null;
			} catch (_ignored) {
				apiRef.current = null;
			}
			// DSH 0.1.2+：探测类型化 Remote 命名空间 remote.session（取值以新版优先；
			// 老版本没有该服务，ctx.inject 永不回调 → remoteSessionRef 保持 null，
			// 取模型时自动回退旧版 connection.api 通道）。
			// ctx.inject 会在服务可用后回调（不阻塞 apply、不影响老版本）。
			try {
				var probeRemote = function () {
					var found = null;
					try { found = ctx.get ? ctx.get("remote.session") : null; } catch (_e) { found = null; }
					if (found) remoteSessionRef.current = found;
				};
				probeRemote();
				if (typeof ctx.inject === "function") {
					ctx.inject(["remote.session"], function (scope) {
						try {
							var s = scope && scope.get ? scope.get("remote.session") : scope;
							if (s) remoteSessionRef.current = s;
						} catch (_e2) { /* 忽略 */ }
					});
				}
			} catch (_ignored2) { /* 无 remote 服务：保持 null */ }
			// 主题服务接入（dsh-client-ui-theme）：getTheme 读当前外观，theme/change 时
			// 广播窗口事件驱动图表重算色板；服务缺失（老版本 DSH）静默走 isDark 亮度兜底
			try {
				var ts = ctx.get ? ctx.get("theme") : null;
				if (ts && typeof ts.getTheme === "function") {
					themeServiceRef.current = ts;
					ctx.on("theme/change", function () {
						try { window.dispatchEvent(new Event("token-monitor:theme-change")); } catch (_e) { /* 忽略 */ }
					});
				}
			} catch (_ignored2) { /* 无 theme 服务：亮度兜底 */ }
			// 语言接入（方案 B）：注册字典 + 绑定模块级 t/LANG；locale/change 时刷新引用。
			// 框架在语言切换时自动重渲染 slot 出口，组件用到的 t/LANG 即新语言的。
			if (ctx.locale) {
				ctx.effect(function () {
					var dispose = ctx.locale.register(NS, DICT);
					var sync = function () {
						t = ctx.locale.bind(NS);
						LANG = ctx.locale.getLocale().active;
					};
					sync();
					ctx.on("locale/change", sync);
					return dispose;
				});
			}
			ctx.slots.inject("conversation.session.header.utilities", function () {
				return ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "token-monitor",
					// 会话头部工具条的排序：框架按 order 升序**稳定排序**
					// （`dsh-client-ui-renderer` 的 `sort((a,b) => a.order - b.order)`），
					// 且 `slots.register()` 不校验 options —— 因此"排最左"等价于"order 比所有注册者都小"。
					// 同 order 时按注册先后（取决于插件激活/热替换顺序）→ 会左右乱跳，必须避免撞号。
					//
					// 官方现用量级：open-in-app（文件夹）-10、session-log-export（会话日志）默认 0、
					// 其余槽位 10/15/20/25。这里取 -99（比官方最小再低 89），
					// 让徽标稳定钉在工具条最左；若哪天官方出现更小的值，需再下调此常量。
					order: -99,
					locale: NS,
					// 0.1.2 会话槽条目不再把 sessionId 塞进渲染 props：由框架以
					// inject(sessionId) 显式下发（官方 ui-model-selection 同款模式）。
					inject: function (sessionId) {
						return { sessionId: sessionId };
					},
				}, TokenMonitorEntry);
			});
			// 主区"用量"页签（DESIGN.md §8 终态）：与"对话/轨迹"并列。
			// 页签切换由框架的 tab ring 处理（点击 → chatStore.setView），本插件只需注册条目。
			ctx.slots.inject("conversation.view", function () {
				return ctx.slots.register({
					name: "conversation.view",
					id: "token-monitor-usage",
					// chat(0) < trajectory(10) < 用量(20)
					order: 20,
					// label 支持函数：读取时按当前语言解析（框架 resolveSlotLabel 调用）
					label: function () { return t("usage.tab"); },
					locale: NS,
				}, UsageView);
			});
			// DSH 设置面板 → Token Monitor 设置页（settings.section 插槽）。
			// 纯 Client 增量注册（replaceRisk:none），不依赖 dsh-settings/schemastery；
			// 与自带页 general(0)/models(10)/plugins(15)/agent-presets(20) 并列，order 25 排最后。
			// 表单读写走自有路由 POST /token-monitor/config → config.json（插件自管，零内部依赖）。
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "token-monitor",
					order: 25,
					label: function () { return t("settings.title"); },
					locale: NS,
				}, SettingsView);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
