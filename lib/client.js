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

		/** apply 闭包里捕获的连接 API 句柄（connection 由 inject 保证已就绪）。 */
		var apiRef = { current: null };

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
				"entry.title": "大模型余量监控",
				"entry.allProviders": "全部提供方（{n}）",
				"entry.updatedAt": "▸ 更新于 {time}",
				"entry.fetchFailed": "拉取失败：{err}",
				"entry.refreshing": "刷新中…",
				"entry.refresh": "刷新",
				"entry.syncing": "同步中…",
				"entry.sync": "同步",
				"entry.syncRetry": "重试",
				"entry.syncDone": "已同步 {n} 条",
				"entry.syncSkipped": " · 未知应用跳过 {n} 条",
				"entry.syncCloseIn": "{n}s 后关闭",
				"entry.syncDetected": "检测到 {name} 有 {n} 条请求记录可同步",
				"entry.selectSession": "选择会话",
				"entry.currentSession": "当前会话（{title}）",
				"entry.openUsage": "在主区打开该会话的用量统计",
				"entry.usageDetail": "用量详情",
				"entry.unsupported": "插件未适配，敬请期待",
				// —— 供应商卡片 / 会话用量 ——
				"card.currentModel": "当前模型",
				"card.routeUnmonitored": "当前路由 {p}/{m} 未配置监控",
				"card.modelNotIdentified": "尚未识别当前模型",
				"card.queryFailed": "查询失败",
				"card.failed": "失败",
				"card.loadFailed": "加载失败",
				"card.loading": "加载中…",
				"card.noSessionData": "该会话暂无用量数据",
				"card.noProviderData": "暂无供应商数据",
				"card.remaining": "{label} 剩 ",
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
				"usage.loadFailed": "加载失败：{err}",
				"usage.retry": "重试",
				"usage.refreshing": "刷新中…",
				"usage.refresh": "刷新",
				"usage.noWindowData": "窗口内暂无数据",
				"usage.noRecords": "暂无记录",
				"usage.totalRecords": "共 {n} 条记录",
				"usage.windowToday": "当天",
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
				"rec.col.provider": "供应商",
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
				// —— 筛选 ——
				"filter.client": "客户端",
				"filter.provider": "供应商",
				"filter.model": "模型",
				"filter.all": "全部",
				// —— 数据来源 ——
				"src.title": "数据来源",
				"src.note": "（CC 记录，支持本机自动同步与 SQL 文件手动导入）",
				"src.col.source": "来源",
				"src.col.desc": "简要说明",
				"src.col.dir": "目录",
				"src.col.action": "操作",
				"src.dshLogs": "DSH 会话日志",
				"src.dshDesc": "本工具的会话日志（自动增量采集）",
				"src.ccDesc": "CC 汇总的其他客户端请求记录（手动导入，已排除 DSH 数据）",
				"src.openDir": "打开目录",
				"src.import": "导入",
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
				"vendor.kimi": "月之暗面（Kimi）",
				"vendor.zhipu": "智谱（GLM）",
				"vendor.qwen": "通义（Qwen）",
				"vendor.xiaomi": "小米（Xiaomi）",
				"vendor.antling": "蚂蚁灵积（Ling）",
				"vendor.deepseek": "深度求索（DeepSeek）",
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
				"settings.reset": "恢复当前值",
				"settings.saved": "保存成功",
				"settings.saveFailed": "保存失败",
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
				"entry.title": "LLM Quota Monitor",
				"entry.allProviders": "All Providers ({n})",
				"entry.updatedAt": "▸ Updated {time}",
				"entry.fetchFailed": "Failed: {err}",
				"entry.refreshing": "Refreshing…",
				"entry.refresh": "Refresh",
				"entry.syncing": "Syncing…",
				"entry.sync": "Sync",
				"entry.syncRetry": "Retry",
				"entry.syncDone": "Synced {n} records",
				"entry.syncSkipped": " · {n} unknown app(s) skipped",
				"entry.syncCloseIn": "Close in {n}s",
				"entry.syncDetected": "{name} has {n} pending request records to sync",
				"entry.selectSession": "Select session",
				"entry.currentSession": "Current Session ({title})",
				"entry.openUsage": "Open usage stats for this session in main area",
				"entry.usageDetail": "Usage Details",
				"entry.unsupported": "Plugin not supported yet",
				// —— 供应商卡片 / 会话用量 ——
				"card.currentModel": "Current Model",
				"card.routeUnmonitored": "Route {p}/{m} has no monitoring configured",
				"card.modelNotIdentified": "Model not identified",
				"card.queryFailed": "Query failed",
				"card.failed": "Failed",
				"card.loadFailed": "Failed to load",
				"card.loading": "Loading…",
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
				"usage.loadFailed": "Failed to load: {err}",
				"usage.retry": "Retry",
				"usage.refreshing": "Refreshing…",
				"usage.refresh": "Refresh",
				"usage.noWindowData": "No data in this window",
				"usage.noRecords": "No records",
				"usage.totalRecords": "{n} records total",
				"usage.windowToday": "Today",
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
				// —— 筛选 ——
				"filter.client": "Client",
				"filter.provider": "Provider",
				"filter.model": "Model",
				"filter.all": "All",
				// —— 数据来源 ——
				"src.title": "Data Sources",
				"src.note": "（CC records · auto-sync locally or manual SQL import）",
				"src.col.source": "Source",
				"src.col.desc": "Description",
				"src.col.dir": "Directory",
				"src.col.action": "Action",
				"src.dshLogs": "DSH Session Logs",
				"src.dshDesc": "This tool's session logs (auto incremental collection)",
				"src.ccDesc": "Other client request records aggregated by CC (manually imported, DSH data excluded)",
				"src.openDir": "Open Folder",
				"src.import": "Import",
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
				"vendor.deepseek": "DeepSeek",
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
				"settings.reset": "Reset to current",
				"settings.saved": "Saved successfully",
				"settings.saveFailed": "Save failed",
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
			btnPrimary: {
				height: "36px", borderRadius: "18px", padding: "0 16px",
				display: "inline-flex", alignItems: "center", gap: "6px",
				fontSize: "14px", lineHeight: "22px", cursor: "pointer", border: "none",
				fontFamily: "inherit", boxSizing: "border-box",
				// 比主题 primary（#1a73e8）更浅的蓝色，视觉更轻
				background: "#4a8bf5",
				color: "#ffffff",
			},
			btnGhost: {
				height: "36px", borderRadius: "18px", padding: "0 16px",
				display: "inline-flex", alignItems: "center", gap: "6px",
				fontSize: "14px", lineHeight: "22px", cursor: "pointer", border: "none",
				fontFamily: "inherit", boxSizing: "border-box",
				background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-label-primary)",
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
				margin: 0, padding: "4px", listStyle: "none",
				background: "var(--dsw-specific-menu)", border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "6px", boxShadow: "var(--dsw-shadow-lv3)",
				display: "flex", flexDirection: "column", gap: "1px",
				maxHeight: "240px", overflow: "auto",
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
						h("span", null, p.label),
						h("span", { style: { flex: 1 } }),
						h("span", { style: S.muted }, props.model && props.model.model)),
					h("div", { style: S.muted }, t("entry.unsupported")));
			}
			var metrics = p.metrics || [];
			return h("div", { style: S.section },
				h("div", { style: S.sectionTitle },
					h("span", { style: S.dot(p.ok ? "ok" : "err") }),
					h("span", null, p.label),
					h("span", { style: { flex: 1 } }),
					h("span", { style: S.muted }, [p.badge, props.model && props.model.model].filter(Boolean).join(" · "))),
				p.ok
					? metrics.map(function (m, i) { return h(MetricRow, { key: i, label: locServer(m.label), value: locServer(m.value), detail: locServer(m.detail), pct: m.pct }); })
					: h("div", { style: S.error }, locServer(p.error) || t("card.queryFailed")));
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

		/** 自绘会话下拉：原生 select 的弹出列表不可定制，故按钮 + 绝对定位菜单。 */
		function SessionPicker(props) {
			var _o = React.useState(false), open = _o[0], setOpen = _o[1];
			var _hov = React.useState(null), hoverId = _hov[0], setHoverId = _hov[1];
			var rootRef = React.useRef(null);

			React.useEffect(function () {
				if (!open) return undefined;
				var onPointerDown = function (e) {
					if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
				};
				var onKeyDown = function (e) {
					if (e.key === "Escape") {
						// 只关下拉，别连带关弹层
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

			var currentTitle = props.value;
			var currentSession = null;
			for (var i = 0; i < props.sessions.length; i++) {
				if (props.sessions[i].id === props.value) {
					currentTitle = props.sessions[i].title;
					currentSession = props.sessions[i];
					break;
				}
			}

			return h("div", { ref: rootRef, style: S.pickerRoot },
				h("button", {
					type: "button", style: S.pickerTrigger,
					"aria-expanded": open, "aria-label": t("entry.selectSession"),
					onClick: function () { setOpen(function (v) { return !v; }); },
				},
					// 与"全部提供方"同款：符号 + "当前会话（标题）"；前缀与标题合并成一个 span，
					// 避免 flex gap 在括号与标题之间产生空隙；pickerTitle 尾部截断时前缀保留
					h("span", { style: { flex: "none", color: "var(--dsw-alias-label-tertiary)" } }, open ? "▾" : "▸"),
					h("span", { style: S.pickerTitle }, t("entry.currentSession", { title: currentTitle }))),
				// 详情入口移到触发器行最右侧（下拉菜单项里不再放 ↗）
				h("button", {
					type: "button", style: S.refreshBtn,
					title: t("entry.openUsage"),
					onClick: function (e) {
						e.stopPropagation();
						if (props.onDetail && currentSession) props.onDetail(currentSession);
					},
				}, t("entry.usageDetail")),
				open
					? h("ul", { style: S.pickerMenu, role: "listbox" },
						props.sessions.map(function (s) {
							var active = s.id === props.value;
							var itemStyle = s.id === hoverId
								? Object.assign({}, S.pickerItem, { background: "rgba(128,128,128,0.12)" })
								: S.pickerItem;
							return h("li", { key: s.id, role: "option", "aria-selected": active },
								h("button", {
									type: "button", style: itemStyle,
									onMouseEnter: function () { setHoverId(s.id); },
									onMouseLeave: function () { setHoverId(null); },
									onClick: function () { props.onChange(s.id); setOpen(false); },
								},
									h("span", { style: S.pickerItemText }, s.title),
									active ? h("span", { style: S.pickerCheck }, "✓") : null));
						}))
					: null);
		}

		function UsageSection(props) {
			// 会话下拉：默认当前会话；切到其他会话时拉其 history 尾页的投影快照拿 tokenUsage
			var _s = React.useState(null), selectedId = _s[0], setSelectedId = _s[1];
			var effectiveId = selectedId || props.currentSessionId;
			var isCurrent = effectiveId === props.currentSessionId;
			var _o = React.useState(null), other = _o[0], setOther = _o[1];

			React.useEffect(function () {
				if (isCurrent) return undefined;
				var api = apiRef.current;
				if (!api || !effectiveId) return undefined;
				var disposed = false;
				setOther(null);
				api.sessions.history({ sessionId: effectiveId }).then(function (res) {
					var r = res && res.result;
					if (disposed) return;
					if (r && r.ok && r.value) {
						setOther({ id: effectiveId, usage: r.value.projections && r.value.projections.values
							? r.value.projections.values.tokenUsage : undefined });
					} else {
						setOther({ id: effectiveId, error: (r && r.error && r.error.message) || t("card.loadFailed") });
					}
				}).catch(function (e) {
					if (!disposed) setOther({ id: effectiveId, error: String((e && e.message) || e) });
				});
				return function () { disposed = true; };
			}, [effectiveId, isCurrent]);

			var usage = isCurrent ? props.usage : (other && other.id === effectiveId ? other.usage : undefined);
			var loadError = !isCurrent && other && other.id === effectiveId ? other.error : null;
			var loading = !isCurrent && (!other || other.id !== effectiveId);
			var body = null;
			if (loading) {
				body = h("div", { style: S.muted }, t("card.loading"));
			} else if (loadError) {
				body = h("div", { style: S.error }, loadError);
			} else if (!usage) {
				body = h("div", { style: S.muted }, t("card.noSessionData"));
			}
			if (body === null) {
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
			// 标题行（当前会话 + 下拉）在卡片外；卡片只包统计瓦片
			var sessions = props.sessions || [];
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
				h(SessionPicker, {
					sessions: sessions,
					value: effectiveId || "",
					onChange: function (id) { setSelectedId(id === props.currentSessionId ? null : id); },
					onDetail: props.onDetail,
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
					if (monthly && monthly.remainingPct >= 0) parts.push(monthlyLabel + " " + monthly.remainingPct + "%");
					if (parts.length) quota = parts.join(" · ");
				}
				return h("div", { key: p.id, style: S.providerRow },
					h("span", { style: S.dot(p.ok ? "ok" : "err") }),
					h("span", { style: S.rowLabel }, p.label),
					h("span", { style: p.ok ? S.rowValue : Object.assign({}, S.rowValue, S.error) },
						p.ok ? (quota || locServer(p.headline) || "—") : (locServer(p.error) || t("card.failed"))));
			});
		}

		/* ---------------------------- 主组件 ---------------------------- */

		function TokenMonitorEntry(props) {
			var sessionId = props.sessionId;
			var useProjection = props.useProjection;
			var usage = useProjection ? useProjection("tokenUsage") : undefined;
			// 会话下拉的数据源：全局会话列表（id + 展示名）
			var sessionOptions = props.useSessions
				? props.useSessions(function (s) {
					return s.ids.map(function (id) { return { id: id, title: (s.byId[id] && s.byId[id].displayTitle) || id }; });
				})
				: [];

			var _a = React.useState(null), overview = _a[0], setOverview = _a[1];
			var _b = React.useState(null), fetchError = _b[0], setFetchError = _b[1];
			var _c = React.useState(null), current = _c[0], setCurrent = _c[1];
			var _d = React.useState(false), openState = _d[0], setOpen = _d[1];
			var open = PIN_OPEN ? true : openState;
			var _e = React.useState(false), showAll = _e[0], setShowAll = _e[1];
			var _g = React.useState(false), hovered = _g[0], setHovered = _g[1];
			var _h = React.useState(false), refreshing = _h[0], setRefreshing = _h[1];
			var _i = React.useState(function () { return Date.now(); }), now = _i[0], setNow = _i[1];
			var _j = React.useState(null), syncPending = _j[0], setSyncPending = _j[1];
			var _k = React.useState(false), syncing = _k[0], setSyncing = _k[1];
			var _l = React.useState(null), syncDone = _l[0], setSyncDone = _l[1];
			// 同步成功摘要的自动关闭定时器（组件卸载时清理，防卸载后 setState）
			var syncTimerRef = React.useRef(null);
			var rootRef = React.useRef(null);

			// CC-switch 未同步探测（DESIGN §11.3）：弹层打开时拉一次；同步完成后再拉。
			var refreshPending = React.useCallback(function () {
				fetch("/token-monitor/sync/pending", { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
					.then(function (d) { setSyncPending(d && d.ok ? (d.pending || []) : null); })
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
						// 合并服务端动态模型展示名（/v1/models 实时 display_name，覆盖硬编码兜底）
						if (d && Array.isArray(d.providers)) {
							for (var pi = 0; pi < d.providers.length; pi++) {
								var ml = d.providers[pi] && d.providers[pi].modelLabels;
								if (ml) for (var key in ml) MODEL_LABELS[key] = ml[key];
							}
						}
					})
					.catch(function (e) { setFetchError(String((e && e.message) || e)); })
					.then(function () { if (!silent) setRefreshing(false); });
			}, []);

			// 轮询周期跟随插件设置（overview.pluginSettings.pollMs，单位秒，默认 60）；配置变化时重建定时器。
			// pollMs 存的是秒，setInterval 需要毫秒，这里单独 ×1000。
			var pollMsSec = (overview && overview.pluginSettings && overview.pluginSettings.pollMs) || POLL_MS;
			var pollMs = pollMsSec * 1000;
			React.useEffect(function () {
				refresh(false);
				var timer = setInterval(function () { refresh(true); }, pollMs);
				return function () { clearInterval(timer); };
			}, [refresh, pollMs]);

			// 设置保存广播：立即重拉一次（pollMs 生效并重建定时器，无需等下一轮询）
			React.useEffect(function () {
				function onSaved() { refresh(true); }
				window.addEventListener("token-monitor:settings-saved", onSaved);
				return function () { window.removeEventListener("token-monitor:settings-saved", onSaved); };
			}, [refresh]);

			// 徽标秒级倒计时的走时心跳；有 resetAt 时才有可见效果，开销可忽略。
			React.useEffect(function () {
				var timer = setInterval(function () { setNow(Date.now()); }, 1000);
				return function () { clearInterval(timer); };
			}, []);

			// 当前会话的模型选择；弹层每次打开时重读一次。
			React.useEffect(function () {
				var api = apiRef.current;
				if (!api || !sessionId) return undefined;
				var disposed = false;
				api.sessions.models({ sessionId: sessionId }).then(function (res) {
					var r = res && res.result;
					if (!disposed && r && r.ok && r.value && r.value.current) setCurrent(r.value.current);
				}).catch(function () {});
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
			var currentProvider = current
				? providers.find(function (p) { return p.id === (PROVIDER_ALIASES[current.provider] || current.provider); }) || null
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
					+ (currentProvider.ok ? (quotaText(currentProvider, now) || locServer(currentProvider.headline) || "—") : t("card.queryFailed"));
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
					title: t("entry.title"),
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
							usage: usage, sessions: sessionOptions, currentSessionId: sessionId,
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
								? h("span", { style: S.error }, t("entry.fetchFailed", { err: fetchError }))
								: t("entry.updatedAt", { time: fmtTime(overview && overview.fetchedAt) })),
							h("button", {
								type: "button",
								style: refreshing ? Object.assign({}, S.refreshBtn, { opacity: 0.55, cursor: "default" }) : S.refreshBtn,
								disabled: refreshing,
								onClick: function () { refresh(false); },
							}, refreshing ? t("entry.refreshing") : t("entry.refresh"))),
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
										? syncDone.error
										: t("entry.syncDone", { n: syncDone.imported })
											+ (syncDone.skippedUnknownApp ? t("entry.syncSkipped", { n: syncDone.skippedUnknownApp }) : "")),
								syncDone.error
									? h("button", { type: "button", style: S.refreshBtn, onClick: runSync }, t("entry.syncRetry"))
									: h("span", {
										style: { flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums",
											color: "var(--dsw-alias-label-tertiary)" },
									}, syncLeft > 0 ? t("entry.syncCloseIn", { n: syncLeft }) : ""))
							: (syncPending && syncPending.length
								? syncPending.map(function (p) {
									return h("div", { key: p.source, style: S.syncBanner },
										h("span", { style: { flex: "none" } }, "ⓘ"),
										h("span", { style: { flex: 1 } },
											p.error
												? p.label + "：" + p.error
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
								: null))
					: null);
		}

		/* ---------------------------- 用量页签（conversation.view） ---------------------------- */

		/** Host 用量统计路由（与弹层共用同一套 Host 查询，无口径分叉）。 */
		var USAGE_URLS = {
			daily: "/token-monitor/usage/daily",
			byModel: "/token-monitor/usage/by-model",
			sessions: "/token-monitor/usage/sessions",
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
		/**
		 * 时间窗选项（用量页切换按钮组 + 设置页下拉共用同一份，保证页签标签与下拉数据一致）：
		 * v = 天数；0 = "全部"（无时间上限）。label 为函数，渲染时按当前语言解析。
		 */
		var WINDOW_OPTIONS = [
			{ v: 1, label: function () { return t("usage.windowToday"); } },
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

		/** 模型 id → 友好展示名（硬编码兜底，已查证）。 */
		var MODEL_LABELS = {
			"kimi-for-coding": "Kimi K2.7 Code",
			"kimi-for-coding-highspeed": "Kimi K2.7 Code Highspeed",
			k3: "Kimi K3",
			"k3-256k": "Kimi K3-256K",
		};
		function modelLabel(id) {
			return MODEL_LABELS[id] || id;
		}

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
			[/（(.+?)后重置）/, " ($1 until reset)"],
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
			[/可用/, "available"],
			[/^是$/, "yes"],
			[/^否$/, "no"],
			[/未配置 ([A-Z_]+)/, "missing $1"],
			[/额度/, "quota"],
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

		/** 区块卡片：标题 + 子内容。 */
		function UsageCard(props) {
			return h("div", { style: S.usageCard },
				props.title ? h("div", { style: S.usageCardTitle }, props.title) : null,
				props.children);
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
			return {
				animationDuration: 300,
				// containLabel: 轴标签宽度计入 grid，窗口窄时标签也不会被裁掉
				grid: { left: 12, right: 12, top: 16, bottom: 34, containLabel: true },
				legend: {
					icon: "diamond", itemWidth: 10, itemHeight: 10, itemGap: 16,
					bottom: 0,
					textStyle: { fontSize: 11, color: axisColor },
				},
				tooltip: {
					trigger: "axis",
					formatter: function (params) {
						if (!params || !params.length) return "";
						var lines = [params[0].axisValue];
						for (var i = 0; i < params.length; i++) {
							var p = params[i];
							var key = seriesKeyOf[p.seriesName] || p.seriesName;
							var v = key === "cost" ? fmtCny(p.value)
								: key === "ttft" ? fmtAxisLatency(p.value)
									: fmtTokens(p.value);
							lines.push(p.marker + " " + p.seriesName + "：" + v);
						}
						return lines.join("<br/>");
					},
				},
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
			var data = props.data || [];
			// serialized 含 LANG：语言切换时重建 option（图例/标签随语言刷新）
			var serialized = JSON.stringify({ d: data, m: metric, l: LANG });
			var option = React.useMemo(function () {
				return data.length ? buildTrendOption(data, metric) : null;
			}, [serialized]);
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
			// 左柱：模型分段堆叠（stack=tokens）。颜色 = 模型所属供应商的色系（vendor 基础色）
			// + 该供应商内按 token 消耗降序排名（第 0 名最深，最后一名最浅）
			// 先算每个 vendor 下各模型的 token 降序排名（并列名次相同）
			var vendorRank = {}; // vendor -> { model: rank }
			for (var ri = 0; ri < data.models.length; ri++) {
				var rm = data.models[ri];
				var rv = (data.modelVendor && data.modelVendor[rm]) || "unknown";
				vendorRank[rv] = vendorRank[rv] || {};
				vendorRank[rv][rm] = 0;
			}
			var vendorModelsArr = {};
			for (var vk in vendorRank) {
				vendorModelsArr[vk] = Object.keys(vendorRank[vk]).sort(function (a, b) {
					return ((data.tokens[vk] && data.tokens[vk][b]) || 0) - ((data.tokens[vk] && data.tokens[vk][a]) || 0);
				});
			}
			for (var vk2 in vendorModelsArr) {
				var arr = vendorModelsArr[vk2];
				for (var vi2 = 0; vi2 < arr.length; vi2++) {
					vendorRank[vk2][arr[vi2]] = vi2;
				}
			}
			for (var i = 0; i < data.models.length; i++) {
				(function (mi) {
					var m = data.models[mi];
					var v = (data.modelVendor && data.modelVendor[m]) || "unknown";
					// shade = rank / max(模型数-1, 1)，最深 0 → 最浅 0.7
					var rank = (vendorRank[v] && vendorRank[v][m]) || 0;
					var total = vendorModelsArr[v] ? vendorModelsArr[v].length : 1;
					var shade = total > 1 ? (rank / (total - 1)) * 0.7 : 0;
					var color = modelBarColor(v, shade);
					series.push({
						name: m, type: "bar", stack: "tokens", yAxisIndex: 0, barMaxWidth: 36,
						itemStyle: { color: color },
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
				},
				tooltip: {
					trigger: "axis",
					axisPointer: { type: "shadow" },
					formatter: function (params) {
						if (!params || !params.length) return "";
						// params[0].name = 该柱的 vendor id（xAxis data 用原始 id，标签层映射展示名）
						var vendorId = params[0].name;
						var lines = ["<b>" + providerLabel(vendorId) + "</b>"];
						// 完整模型构成（含被 Top8 归入"其他"的模型）：vendorModels[vendor] = [{model, tokens}]
						var vms = data.vendorModels && data.vendorModels[vendorId];
						if (vms && vms.length) {
							for (var vi = 0; vi < vms.length; vi++) {
								// 与柱状图同色：模型所属 vendor 色系 + 按 token 降序排名变浅（vi 即排名）
								var mv = (data.modelVendor && data.modelVendor[vms[vi].model]) || vendorId;
								var shade2 = vms.length > 1 ? (vi / (vms.length - 1)) * 0.7 : 0;
								lines.push('<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + modelBarColor(mv, shade2) + ';margin-right:4px"></span>'
									+ vms[vi].model + "：" + fmtTokens(vms[vi].tokens));
							}
						}
						// 右侧合计指标（费用/请求次数）
						for (var i = 0; i < params.length; i++) {
							var p = params[i];
							if (p.seriesName === rightLabel) {
								lines.push(p.marker + " " + p.seriesName + "："
									+ (rightKey === "cost" ? fmtCny(p.value) : p.value + t("prov.times")));
								break;
							}
						}
						return lines.join("<br/>");
					},
				},
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

			var serialized = JSON.stringify({ d: data, m: metric, l: LANG });
			var option = React.useMemo(function () {
				return data && data.providers.length ? buildModelBarsOption(data, metric) : null;
			}, [serialized]);

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

		/** 蓝系十级色阶：GitHub 浅灰 → DeepSeek 主色（线性插值）。 */
		var HEAT_COLORS = (function () {
			var arr = [];
			for (var i = 0; i < 10; i++) arr.push(mixHex("#ebedf0", "#3964fe", i / 9));
			return arr;
		})();

		/** 日历热力图 option：calendar 坐标 + heatmap 系列，piecewise 五级蓝。 */
		function buildCalendarOption(agg) {
			var dayList = agg.dayList, byDay = agg.byDay, maxTok = agg.maxTok;
			var axisColor = cssVar("--dsw-alias-label-tertiary", "#9aa0a6");
			var q = maxTok > 0 ? maxTok / 9 : 1;
			return {
				animationDuration: 0,
				tooltip: {
					formatter: function (p) {
						var d = p.data[2] || {};
						return p.data[0] + " · " + (d.requests || 0) + t("prov.times") + " · " + fmtTokens(p.data[1]);
					},
				},
				visualMap: {
					show: false, type: "piecewise", dimension: 1,
					pieces: [
						{ value: 0, color: HEAT_COLORS[0] },
						{ gt: 0, lte: q, color: HEAT_COLORS[1] },
						{ gt: q, lte: q * 2, color: HEAT_COLORS[2] },
						{ gt: q * 2, lte: q * 3, color: HEAT_COLORS[3] },
						{ gt: q * 3, lte: q * 4, color: HEAT_COLORS[4] },
						{ gt: q * 4, lte: q * 5, color: HEAT_COLORS[5] },
						{ gt: q * 5, lte: q * 6, color: HEAT_COLORS[6] },
						{ gt: q * 6, lte: q * 7, color: HEAT_COLORS[7] },
						{ gt: q * 7, lte: q * 8, color: HEAT_COLORS[8] },
						{ gt: q * 8, color: HEAT_COLORS[9] },
					],
				},
				calendar: {
					top: 26, left: 44, right: 12, bottom: 4,
					cellSize: [12, 12],
					range: [agg.rangeStart, agg.rangeEnd],
					orient: "horizontal",
					splitLine: { show: false },
					itemStyle: { borderColor: "rgba(255,255,255,0.6)", borderWidth: 2 },
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

			var serialized = JSON.stringify({ b: agg.byDay, l: LANG });
			var option = React.useMemo(function () {
				return buildCalendarOption(agg, serialized);
			}, [serialized]);

			return h("div", null,
				h("div", { style: { display: "flex", alignItems: "center", gap: "2px" } },
					h("div", { style: S.usageCardTitle }, t("heat.title")),
					h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" } },
						t("heat.note")),
					h("span", { style: { flex: 1 } }),
					// GitHub 风 少→多 图例
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary)" } },
						t("heat.low"),
						HEAT_COLORS.map(function (c, i) {
							return h("span", { key: i, style: { width: "10px", height: "10px", borderRadius: "2px", background: c } });
						}),
						t("heat.high"))),
				h(EChart, { option: option, serialized: serialized, height: 168 }));
		}

		/** 时间列格式：完整 yyyy-MM-dd HH:mm:ss。 */
		function fmtRecordTime(ms) {
			var d = new Date(ms);
			var pad = function (x) { return String(x).padStart(2, "0"); };
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
				+ " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
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

			// 页码序列：首页 1-3、当前页附近、末页 3 个，缺口用 …（1 2 3 … 169 170 171 风格）
			function pageItems() {
				var set = { 1: 1, 2: 1, 3: 1 };
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

			var _goto = React.useState(""), gotoVal = _goto[0], setGoto = _goto[1];
			var _gotoErr = React.useState(false), gotoErr = _gotoErr[0], setGotoErr = _gotoErr[1];
			// 校验：只允许输入数字；跳转时页码必须存在于 1..totalPages，否则红框提示不跳转
			function jump() {
				var n = parseInt(gotoVal, 10);
				if (gotoVal !== "" && isFinite(n) && n >= 1 && n <= totalPages) {
					setPage(n);
					setGoto("");
					setGotoErr(false);
				} else {
					setGotoErr(true);
				}
			}
			var columns = [
				{ key: "created_at", label: t("rec.col.time"), width: "12%", render: function (r) { return fmtRecordTime(r.created_at); } },
				{ key: "title", label: t("rec.col.session"), width: "16%", render: function (r) { return r.title || "—"; } },
				{ key: "model", label: t("rec.col.model"), width: "10%" },
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
				err ? h("div", { style: S.error }, err) : null,
				!data && !err ? h("div", { style: S.muted }, t("usage.loading")) : null,
				data && data.rows.length
					? h(UsageTable, { columns: columns, rows: data.rows })
					: (data ? h("div", { style: S.muted }, t("usage.noRecords")) : null),
				data
					? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", marginTop: "12px" } },
						h("span", null, t("usage.totalRecords", { n: data.total })),
						h("span", { style: { flex: 1 } }),
						h("button", {
							type: "button",
							// inline-flex 下高度由内容撑：文字按钮 26px（行高18+padding6+border2），
							// svg 只有 10px，必须显式给 26px 才能与页码按钮等高；
							// box-sizing 固定 border-box，整排（箭头/页码/输入/下拉/跳转）统一 26px
							style: Object.assign({}, S.windowBtn, { minWidth: "26px", height: "26px", padding: "3px 6px", boxSizing: "border-box" }),
							disabled: page <= 1,
							onMouseDown: function (e) { e.preventDefault(); },
							onClick: function () { setPage(function (p) { return Math.max(1, p - 1); }); },
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
								onClick: function () { setPage(item); },
							}, String(item));
						}),
						h("button", {
							type: "button",
							style: Object.assign({}, S.windowBtn, { minWidth: "26px", height: "26px", padding: "3px 6px", boxSizing: "border-box" }),
							disabled: page >= totalPages,
							onMouseDown: function (e) { e.preventDefault(); },
							onClick: function () { setPage(function (p) { return Math.min(totalPages, p + 1); }); },
						}, h("svg", {
							width: "6", height: "10", viewBox: "0 0 6 10",
							fill: "none", stroke: "currentColor", strokeWidth: "1.5",
							strokeLinecap: "round", strokeLinejoin: "round",
						}, h("path", { d: "M1 1l4 4-4 4" }))),
						h("input", {
							style: Object.assign({}, S.windowBtn, { width: "44px", textAlign: "center", outline: "none" },
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
							onChange: function (v) { setPageSize(v || "10"); setPage(1); },
						}),
						h("button", {
							type: "button", style: S.windowBtn,
							onMouseDown: function (e) { e.preventDefault(); },
							onClick: jump,
						}, t("rec.go")))
					: null);
		}
		/** 使用排行表：按 模型/供应商/客户端 三维度聚合（服务端已算好，props.data 一次含三维度），
		 *  切维度零请求；首维占首列，其余两维在尾部，位置随模式互换。 */
		function RankTable(props) {
			var dim = props.dim;
			// 服务端返回 { model: [...], provider: [...], client: [...] }，每行含 name + 用量 + models/providers/clients 集合
			var rows = (props.data && props.data[dim]) || [];

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
			/** 组合列：该组的模型/供应商/客户端 id 集合 → 展示名按"DSH 永远在前、其余首字母"排序拼接。 */
			var rank2 = function (x) { return x === "DSH" ? "0" : "1" + x; };
			var comboCol = function (key, label, width, labelFn) {
				return {
					key: key, label: label, width: width,
					render: function (r) {
						return trunc20((r[key] || []).slice().sort(function (a, b) {
							return rank2(labelFn(a)).localeCompare(rank2(labelFn(b)));
						}).map(labelFn).join(" | "));
					},
					title: function (r) {
						return (r[key] || []).slice().sort(function (a, b) {
							return rank2(labelFn(a)).localeCompare(rank2(labelFn(b)));
						}).map(labelFn).join(" | ");
					},
				};
			};
			var cols = [nameCol(dim, DIM_LABEL[dim], "11%")].concat(METRIC_COLS);
			if (dim === "model") {
				cols.push(comboCol("providers", t("rank.combo.providers"), "13.3%", providerLabel), comboCol("clients", t("rank.combo.clients"), "13.3%", clientLabel));
			} else if (dim === "provider") {
				cols.push(comboCol("models", t("rank.combo.models"), "13.3%", function (id) { return id; }), comboCol("clients", t("rank.combo.clients"), "13.3%", clientLabel));
			} else {
				cols.push(comboCol("providers", t("rank.combo.providers"), "13.3%", providerLabel), comboCol("models", t("rank.combo.models"), "13.3%", function (id) { return id; }));
			}

			return rows.length
				? h(UsageTable, { columns: cols, rows: rows })
				: h("div", { style: S.muted }, t("rank.noData"));
		}

		/** 通用数据表：列定义 { key, label, render? }，右对齐数值列。 */
		function UsageTable(props) {
			var cols = props.columns || [];
			var rows = props.rows || [];
			return h("div", { style: { overflowX: "auto" } },
				// tableLayout fixed：列宽由列定义（width）与均分剩余空间决定，翻页不跳动
				h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px", tableLayout: "fixed" } },
					h("thead", null, h("tr", null, cols.map(function (c, i) {
						return h("th", {
							key: c.key || i,
							style: Object.assign({}, S.usageTh, i > 0 ? { textAlign: "right" } : {}, c.width ? { width: c.width } : {}),
						}, c.label);
					}))),
					h("tbody", null, rows.map(function (row, ri) {
						return h("tr", {
							key: row.key || ri,
							style: row.highlight ? { background: "rgba(128,128,128,0.14)" } : undefined,
						}, cols.map(function (c, ci) {
							var rendered = c.render ? c.render(row) : String(row[c.key] ?? "");
							return h("td", {
								key: c.key || ci,
								// c.title 提供全值（截断显示时悬停用）；否则字符串渲染值兜底
								title: c.title ? c.title(row) : (typeof rendered === "string" ? rendered : undefined),
								style: Object.assign({}, S.usageTd, ci > 0 ? { textAlign: "right" } : {},
									{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
							}, rendered);
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
			var rootStyle = { position: "relative", display: "inline-flex", alignItems: "center" };
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
					h("span", { style: { maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label),
					// SVG 细线 chevron：收起朝下 ∨、打开朝上 ∧；stroke 跟随 currentColor
					h("svg", {
						width: "10", height: "6", viewBox: "0 0 10 6",
						fill: "none", stroke: "currentColor", strokeWidth: "1.5",
						strokeLinecap: "round", strokeLinejoin: "round",
						style: { flex: "none", marginLeft: "8px" },
					}, h("path", { d: open ? "M1 5l4-4 4 4" : "M1 1l4 4 4-4" }))),
				open
					? h("ul", {
						// left+right 撑满 root（整体控件宽，含标题），宽度与整体按钮一致
						style: Object.assign({}, S.filterMenu, { left: 0, right: 0 }),
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
				setFocus(usageFocusRequest);
				setClient("dsh");
				setProvider("");
				setModel("");
				setDays(0);
				usageFocusRequest = null;
			}

			// 弹层跳转事件监听：用量 tab 已激活时模拟点击不触发渲染，改由事件驱动消费
			// （组件挂载期间一直有效；与渲染期消费互补，两者消费同一请求但互不干扰）
			React.useEffect(function () {
				function onFocusSession(e) {
					var d = e && e.detail;
					if (!d || !d.sessionId) return;
					setFocus({ sessionId: d.sessionId, title: d.title || d.sessionId });
					setClient("dsh");
					setProvider("");
					setModel("");
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
				// "当天"拉渲染就绪的趋势数据（服务端已完成区间/颗粒度/分桶封装；带筛选参数）
				if (d === 1) {
					var hq = "?day=" + localDay(Date.now()) + (params.length > 1 ? "&" + params.slice(1).join("&") : "");
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
					setHourly(d === 1 && results[idx] ? (results[idx].data || null) : hourly);
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
								showCcResult("import", false, (d && d.error) || t("src.importFailed"));
							}
						})
						.catch(function (err) { showCcResult("import", false, String((err && err.message) || err)); })
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
							showCcResult("delete", false, (d && d.error) || t("src.deleteFailed"));
						}
					})
					.catch(function (err) { showCcResult("delete", false, String((err && err.message) || err)); })
					.then(function () { setCcBusy(null); });
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
				// 当天：hourly 已就绪才用（避免切换瞬间 hourly 未到 → 闪空）；
				// 未就绪回退 daily 聚合（当天单点），hourly 到达后替换为分钟级曲线
				if (days === 1 && hourly && hourly.buckets && hourly.buckets.length) {
					return hourly.buckets;
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
				var p = function (x) { return String(x).padStart(2, "0"); };
				var out = [];
				for (var i2 = days - 1; i2 >= 0; i2--) {
					var dt = new Date(Date.now() - i2 * 86400000);
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
					h("span", { style: S.error }, t("usage.loadFailed", { err: error })),
					h("button", { type: "button", style: S.refreshBtn, onClick: function () { load(days, client, provider, model, focus); } }, t("usage.retry")));
			} else {
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
						hitPct !== null
							? h(UsageStatCard, { label: t("stat.hitRate"), value: hitPct + "%", color: STAT_COLORS.rate })
							: h("div", { style: { minHeight: "44px" } })),
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
									h("th", { style: Object.assign({}, S.usageTh, { width: "10%" }) }, t("src.col.source")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "40%" }) }, t("src.col.desc")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "30%" }) }, t("src.col.dir")),
									h("th", { style: Object.assign({}, S.usageTh, { width: "20%" }) }, t("src.col.action")))),
							h("tbody", null,
								h("tr", null,
									h("td", { style: S.usageTd }, t("src.dshLogs")),
									h("td", { style: S.usageTd }, t("src.dshDesc")),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis" }), title: sources ? sources.dshSessions : "~/.dsh/sessions" },
										sources ? sources.dshSessions : "~/.dsh/sessions"),
									h("td", { style: S.usageTd },
										h("button", {
											type: "button", style: S.sourceBtn,
											onClick: function () { openSourceDir("dsh"); },
										}, t("src.openDir")))),
								h("tr", null,
									h("td", { style: S.usageTd }, "CC Switch"),
									h("td", { style: S.usageTd }, t("src.ccDesc")),
									h("td", { style: Object.assign({}, S.usageTd, { overflow: "hidden", textOverflow: "ellipsis" }), title: sources ? sources.ccSwitchDb : "~/.cc-switch/cc-switch.db" },
										sources ? sources.ccSwitchDb : "~/.cc-switch/cc-switch.db"),
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
											: null)))))));
			}

			return h("div", { style: S.usageRoot },
				h("div", { style: S.usageHeader },
					// 会话聚焦横幅：从弹层"用量详情"跳转进入；✕ 清除回到全量（时间窗恢复为设置里的默认值）
					focus
						? h("span", { style: S.usageFocusBanner },
							h("span", null, t("focus.current", { title: focus.title || focus.sessionId })),
							h("button", {
								type: "button", style: S.usageFocusClear, title: t("focus.clear"),
								onClick: function () {
									setFocus(null);
									// 聚焦时时间窗被置为"全部"（会话历史累计）；取消聚焦恢复为设置里的默认时间窗
									var ps = overviewCache && overviewCache.pluginSettings;
									setDays(ps && ps.defaultDays !== undefined ? ps.defaultDays : 1);
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
						// 行内唯一动作按钮：主题主色填充成为视觉焦点（配色同激活时间窗）
						type: "button",
						style: Object.assign({}, S.refreshBtn, {
							padding: "3px 10px", fontSize: "12px", lineHeight: "18px",
							display: "inline-flex", alignItems: "center", justifyContent: "center",
							background: "var(--dsw-alias-state-business-primary, #1a73e8)",
							borderColor: "var(--dsw-alias-state-business-primary, #1a73e8)",
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
				body);
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

		// 设置页按钮 hover 反馈（仿 DSH 客户端插件的 CSS 注入：幂等、随模块加载一次）。
		// 两个按钮效果一致（上移 2px + 放大 1.02 + 同尺寸四周光晕），仅阴影颜色不同：
		// 保存=蓝色光晕（突出），恢复=中性黑。0.18s 平滑过渡；disabled 时不生效。
		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"tm-settings-btn\"]")) {
			var tag = document.createElement("style");
			tag.dataset.pluginCss = "tm-settings-btn";
			tag.textContent =
				".tm-settings-btn-primary:hover:not(:disabled){" +
				"transform:translateY(-2px) scale(1.02);" +
				"box-shadow:0 0 8px rgba(74,139,245,0.55)}" +
				".tm-settings-btn-ghost:hover:not(:disabled){" +
				"transform:translateY(-2px) scale(1.02);" +
				"box-shadow:0 0 8px rgba(0,0,0,0.16)}" +
				".tm-settings-btn-primary,.tm-settings-btn-ghost{transition:transform .18s ease,box-shadow .18s ease}";
			document.head.appendChild(tag);
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
					h("span", { style: S.pickerChevron(open) })),
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
		function SettingsView() {
			var init = (overviewCache && overviewCache.pluginSettings) ? overviewCache.pluginSettings : SETTINGS_DEFAULTS;
			var cfgState = React.useState(init);            // 生效配置（缓存或服务端默认）
			var cfg = cfgState[0], setCfg = cfgState[1];
			var draftState = React.useState(init);          // 表单草稿，首帧即回显
			var draft = draftState[0], setDraft = draftState[1];
			var uiState = React.useState({ saving: false, savedAt: 0, err: "" });
			var busy = uiState[0], setBusy = uiState[1];
			var touchedRef = React.useRef(false);           // 用户是否改动过（改动后不再被后台回显覆盖）

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
							setBusy({ saving: false, savedAt: 0, err: (d && d.error) || t("settings.saveFailed") });
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

			return h("div", { style: { display: "flex", flexDirection: "column" } },
				rows,
				h("div", { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px", padding: "16px 2px" } },
					busy.savedAt
						? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-success, #34a853)" } }, t("settings.saved"))
						: busy.err
							? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-error, #ea4335)" } }, busy.err)
							: null,
					h("button", {
						onClick: reset,
						disabled: busy.saving || !dirty,
						// 无改动时禁用：半透明 + 默认光标
						style: (busy.saving || !dirty) ? Object.assign({}, S.btnGhost, { opacity: 0.5, cursor: "default" }) : S.btnGhost,
						className: "tm-settings-btn tm-settings-btn-ghost",
					}, t("settings.reset")),
					h("button", {
						onClick: save,
						disabled: busy.saving || !dirty,
						// 无改动时禁用：半透明 + 默认光标（与恢复按钮一致）
						style: (busy.saving || !dirty) ? Object.assign({}, S.btnPrimary, { opacity: 0.5, cursor: "default" }) : S.btnPrimary,
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
					// 负数 order：排到 Session log（默认 0）左侧，而不是最右边缘。
					order: -10,
					locale: NS,
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
