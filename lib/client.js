/**
 * dsh-token-monitor — 浏览器半。
 *
 * 手写 __ModuleLoader__ 懒 CJS 格式（与 dsh 内置客户端插件的产物一致），
 * 因此无需任何构建步骤：编辑本文件后 dsh-client-hmr 的轮询会发现内容
 * 变化并热替换这个插件。
 *
 * 行为：向会话头部右侧的 conversation.session.header.utilities 列表槽注册
 * 一个余量监控组件。徽标显示当前会话所用模型对应供应商的关键余量指标；
 * 点击弹出详情层：当前供应商卡片、本会话 token 用量（useProjection 投影）、
 * 以及“全部模型监控”折叠区（Host 路由返回的所有供应商）。
 */
window.__ModuleLoader__.load({
	id: "dsh-token-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var OVERVIEW_URL = "/token-monitor/overview";
		var POLL_MS = 60000;

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

		var inject = ["slots", "connection"];

		/* ------------------------------ 格式化 ------------------------------ */

		/** token 数字的中文大数格式：万 → 亿 → 万亿；整数部分恒 ≤4 位 + 两位小数，不挤压瓦片。 */
		function fmtTokens(n) {
			if (typeof n !== "number" || !isFinite(n)) return "—";
			if (n >= 1e12) return (n / 1e12).toFixed(2) + " 万亿";
			if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
			if (n >= 1e4) return (n / 1e4).toFixed(2) + " 万";
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
			if (!isFinite(ms) || ms <= 0) return "正在刷新…";
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
			pickerRoot: { position: "relative", display: "flex", width: "100%" },
			pickerTrigger: {
				// 与"全部模型"toggle 样式对齐：无边框、同 padding/gap/字号；flex:1 撑满左侧，
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
				borderRadius: "10px", boxShadow: "var(--dsw-shadow-lv3)",
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
				// 无水平 padding：左侧与"全部模型"文字（menu 内边距 8px 起）对齐
				padding: "0",
			},
			refreshBtn: {
				background: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px",
				padding: "2px 8px", cursor: "pointer", fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
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
				background: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px",
				padding: "3px 10px", fontSize: "12px", cursor: "pointer",
				color: "var(--dsw-alias-label-secondary)", lineHeight: "18px",
			},
			windowBtnActive: {
				background: "rgba(128,128,128,0.14)", color: "var(--dsw-alias-label-primary)",
				borderColor: "var(--dsw-alias-border-l3, #5f6368)",
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
				borderRadius: "999px", padding: "2px 10px", fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
			},
			usageFocusClear: {
				background: "none", border: 0, cursor: "pointer", padding: "0 2px",
				color: "var(--dsw-alias-label-tertiary)", fontSize: "11px",
			},
			pickerDetail: {
				flex: "none", background: "none", border: 0, cursor: "pointer",
				color: "var(--dsw-alias-label-tertiary)", fontSize: "12px",
				padding: "0 3px", borderRadius: "4px", lineHeight: "18px",
			},
			/** 同步提示条（§11.3）：类似"有更新"的通知样式（橙黄），有未同步数据时才渲染。 */
			syncBanner: {
				display: "flex", alignItems: "center", gap: "6px",
				border: "1px solid var(--dsw-alias-warning, #f9ab00)",
				background: "rgba(249,171,0,0.10)", borderRadius: "8px",
				padding: "6px 8px", fontSize: "11px", lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)",
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
			var src;
			var prefix;
			if (weekly && weekly.remainingPct <= 0) {
				src = weekly; prefix = "7d 剩 ";
			} else if (st.window) {
				src = st.window; prefix = "5h 剩 ";
			} else if (weekly) {
				src = weekly; prefix = "7d 剩 ";
			} else {
				return null;
			}
			var cd = "";
			var ms = src.resetAt ? src.resetAt - now : NaN;
			if (isFinite(ms) && ms <= 5 * 60 * 1000) {
				// 剩余不足 5 分钟才启用秒级走字，其余时候用静态文案。
				cd = " · " + formatLiveCountdown(ms);
			} else if (src.countdown) {
				cd = " · " + String(src.countdown).replace(/后重置$/, "");
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
					h("div", { style: S.sectionTitle }, "当前模型"),
					h("div", { style: S.muted }, props.model
						? "当前路由 " + props.model.provider + "/" + props.model.model + " 未配置监控"
						: "尚未识别当前模型"));
			}
			var metrics = p.metrics || [];
			return h("div", { style: S.section },
				h("div", { style: S.sectionTitle },
					h("span", { style: S.dot(p.ok ? "ok" : "err") }),
					h("span", null, p.label),
					h("span", { style: { flex: 1 } }),
					h("span", { style: S.muted }, [p.badge, props.model && props.model.model].filter(Boolean).join(" · "))),
				p.ok
					? metrics.map(function (m, i) { return h(MetricRow, { key: i, label: m.label, value: m.value, detail: m.detail, pct: m.pct }); })
					: h("div", { style: S.error }, p.error || "查询失败"));
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
					"aria-expanded": open, "aria-label": "选择会话",
					onClick: function () { setOpen(function (v) { return !v; }); },
				},
					// 与"全部模型"同款：符号 + "当前会话（标题）"；前缀与标题合并成一个 span，
					// 避免 flex gap 在括号与标题之间产生空隙；pickerTitle 尾部截断时前缀保留
					h("span", { style: { flex: "none", color: "var(--dsw-alias-label-tertiary)" } }, open ? "▾" : "▸"),
					h("span", { style: S.pickerTitle }, "当前会话（" + currentTitle + "）")),
				// 详情入口移到触发器行最右侧（下拉菜单项里不再放 ↗）
				h("button", {
					type: "button", style: S.refreshBtn,
					title: "在主区打开该会话的用量统计",
					onClick: function (e) {
						e.stopPropagation();
						if (props.onDetail && currentSession) props.onDetail(currentSession);
					},
				}, "用量详情"),
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
						setOther({ id: effectiveId, error: (r && r.error && r.error.message) || "加载失败" });
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
				body = h("div", { style: S.muted }, "加载中…");
			} else if (loadError) {
				body = h("div", { style: S.error }, loadError);
			} else if (!usage) {
				body = h("div", { style: S.muted }, "该会话暂无用量数据");
			}
			if (body === null) {
				var input = usage.uncachedInputTokens;
				var output = usage.outputTokens;
				var cacheRead = usage.cacheReadTokens;
				var cacheWrite = usage.cacheWriteTokens;
				// 命中率 = 命中 ÷（命中 + 新增输入），分母为 0（还没跑过请求）时不显示。
				var hitDenom = cacheRead + input;
				var hitPct = hitDenom > 0 ? Math.round((cacheRead / hitDenom) * 1000) / 10 : null;
				// 总输入（未缓存 + 命中 + 创建），只用于"总消耗"瓦片
				var totalInput = input + cacheRead + cacheWrite;
				var defs = [
					// 输入 = 未缓存（新增）部分；总消耗 = 全四桶合计
					{ key: "in", label: "新增输入", value: fmtTokens(input) },
					{ key: "out", label: "输出", value: fmtTokens(output) },
					{ key: "hit", label: "缓存命中", value: fmtTokens(cacheRead) },
				];
				// 缓存创建恒 0 不占位，出现非 0（如接 Anthropic）时自动补一块瓦片
				if (cacheWrite > 0) defs.push({ key: "cw", label: "缓存创建", value: fmtTokens(cacheWrite) });
				// 第四块：总消耗（总输入 + 输出），与其他三块同为 token 维度
				defs.push({ key: "total", label: "总消耗", value: fmtTokens(totalInput + output) });
				// 奇数块时最后一块通栏，网格不留半空位
				var tiles = defs.map(function (d, i) {
					return h(StatTile, {
						key: d.key, label: d.label, value: d.value,
						wide: i === defs.length - 1 && defs.length % 2 === 1,
					});
				});
				body = h("div", { style: S.statGrid },
					hitPct !== null
						? tiles.concat([h(RateTile, { key: "rate", label: "缓存命中率", value: hitPct + "%", pct: hitPct })])
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
			if (!providers.length) return h("div", { style: S.muted }, "暂无供应商数据");
			return providers.map(function (p) {
				// 订阅类供应商（有 stats）：value 列显示余量组合——已用百分比对用户没有直觉
				// 意义，改显 5h 余量 + 7d 余量 + 重置倒计时；余额类（无 stats）保持 headline。
				var st = p.stats;
				var quota = null;
				if (p.ok && st) {
					var parts = [];
					var weekly = st.weekly;
					if (weekly && weekly.remainingPct <= 0) {
						// 7d 额度耗尽：只显示 7d 0%（告急优先，不显示 5h）
						parts.push("7d " + weekly.remainingPct + "%");
					} else {
						if (st.window) parts.push("5h " + st.window.remainingPct + "%");
						if (weekly) parts.push("7d " + weekly.remainingPct + "%");
					}
					if (parts.length) quota = parts.join(" · ");
				}
				return h("div", { key: p.id, style: S.providerRow },
					h("span", { style: S.dot(p.ok ? "ok" : "err") }),
					h("span", { style: S.rowLabel }, p.label),
					h("span", { style: p.ok ? S.rowValue : Object.assign({}, S.rowValue, S.error) },
						p.ok ? (quota || p.headline || "—") : (p.error || "失败")));
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
				fetch("/token-monitor/import/cc-switch", {
					method: "POST", headers: { accept: "application/json" },
				}).then(function (r) { return r.json(); })
					.then(function (d) {
						if (!d || !d.ok) {
							setSyncDone({ error: (d && d.error) || "导入失败" });
						} else {
							// 结果摘要带过期时间：右侧显示 N 秒倒计时后自动关闭并重新探测（§11.3）
							setSyncDone({
								imported: d.imported, skipped: d.skipped,
								skippedUnknownApp: d.skippedUnknownApp || 0,
								expiresAt: Date.now() + 3000,
							});
							setTimeout(function () {
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

			// silent=true 用于后台轮询：不打扰刷新按钮的 loading 态；
			// 打开弹层和手动点击（silent=false）才显示"刷新中…"。
			var refresh = React.useCallback(function (silent) {
				if (!silent) setRefreshing(true);
				fetch(OVERVIEW_URL, { headers: { accept: "application/json" } })
					.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
					.then(function (d) { setOverview(d); setFetchError(null); })
					.catch(function (e) { setFetchError(String((e && e.message) || e)); })
					.then(function () { if (!silent) setRefreshing(false); });
			}, []);

			React.useEffect(function () {
				refresh(false);
				var timer = setInterval(function () { refresh(true); }, POLL_MS);
				return function () { clearInterval(timer); };
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
				label = "余量监控";
				dotState = "err";
			} else if (currentProvider) {
				label = (current ? current.model : currentProvider.label) + " · "
					+ (currentProvider.ok ? (quotaText(currentProvider, now) || currentProvider.headline || "—") : "查询失败");
				dotState = dotStateOf(currentProvider);
			} else if (current) {
				label = current.model + " · 余量";
			} else {
				label = "余量监控";
			}

			// "↗ 详情"：交棒聚焦会话 → 关弹层 → 切到"用量"页签。
			// 活跃 view 存在 conversation 插件闭包私有的 chatStore 里，外部插件没有公共
			// setView API；页签按钮的 onClick 走框架自己的 actions.setView 路径，模拟点击即可。
			function openUsageDetail(s) {
				usageFocusRequest = { sessionId: s.id, title: s.title };
				setOpen(false);
				var tabs = document.querySelectorAll('button[role="tab"]');
				for (var i = 0; i < tabs.length; i++) {
					if (tabs[i].textContent.replace(/\s+/g, " ").trim() === "用量") {
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
					title: "大模型余量监控",
					onClick: function () { setOpen(function (v) { return !v; }); if (!open) refresh(); },
					onMouseEnter: function () { setHovered(true); },
					onMouseLeave: function () { setHovered(false); },
				},
					h("span", { style: S.dot(dotState) }),
					h("span", null, label)),
				open
					? h("div", { style: S.menu, role: "dialog", "aria-label": "大模型余量监控" },
						h(ProviderCard, { provider: currentProvider, model: current }),
						h(UsageSection, {
							usage: usage, sessions: sessionOptions, currentSessionId: sessionId,
							onDetail: openUsageDetail,
						}),
						// 收紧只作用于"全部模型"按钮与下方邻居（折叠时 8px→4px）；
						// footer 永不动，上下间距恒 8px 对称（提示条存在时也不破坏）
						h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", marginBottom: showAll ? 0 : "-4px" } },
							h("button", {
								type: "button", style: S.toggle,
								"aria-expanded": showAll,
								onClick: function () { setShowAll(function (v) { return !v; }); },
							}, (showAll ? "▾ " : "▸ ") + "全部模型（" + providers.length + "）"),
							showAll ? h("div", { style: S.section }, h(AllProviders, { providers: providers })) : null),
						h("div", { style: S.footer },
							h("span", null, fetchError
								? h("span", { style: S.error }, "拉取失败：" + fetchError)
								: "▸ 更新于 " + fmtTime(overview && overview.fetchedAt)),
							h("button", {
								type: "button",
								style: refreshing ? Object.assign({}, S.refreshBtn, { opacity: 0.55, cursor: "default" }) : S.refreshBtn,
								disabled: refreshing,
								onClick: function () { refresh(false); },
							}, refreshing ? "刷新中…" : "刷新")),
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
										: "已同步 " + syncDone.imported + " 条"
											+ (syncDone.skipped ? " · 跳过 " + syncDone.skipped + " 条" : "")),
								syncDone.error
									? h("button", { type: "button", style: S.refreshBtn, onClick: runSync }, "重试")
									: h("span", {
										style: { flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums",
											color: "var(--dsw-alias-label-tertiary)" },
									}, syncLeft > 0 ? syncLeft + "s 后关闭" : ""))
							: (syncPending && syncPending.length
								? syncPending.map(function (p) {
									return h("div", { key: p.source, style: S.syncBanner },
										h("span", { style: { flex: "none" } }, "ⓘ"),
										h("span", { style: { flex: 1 } },
											p.error
												? p.label + "：" + p.error
												: "检测到 " + p.label + " 有 " + p.pending + " 条请求记录可同步"),
										p.error
											? null
											: h("button", {
												type: "button",
												style: syncing ? Object.assign({}, S.refreshBtn, { opacity: 0.55, cursor: "default" }) : S.refreshBtn,
												disabled: syncing,
												onClick: runSync,
											}, syncing ? "同步中…" : "同步"));
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
		};
		var WINDOW_OPTIONS = [7, 30, 90];

		/** 弹层"↗ 详情"交棒给用量页签的聚焦会话（同模块变量跨组件传递，消费一次即清）。 */
		var usageFocusRequest = null;

		function fmtUsd(n) {
			if (typeof n !== "number" || !isFinite(n)) return "—";
			if (n === 0) return "$0";
			if (n >= 1000) return "$" + Math.round(n).toLocaleString();
			if (n >= 1) return "$" + n.toFixed(2);
			return "$" + n.toFixed(4);
		}

		function fmtLatency(ms) {
			if (typeof ms !== "number" || !isFinite(ms)) return "—";
			if (ms >= 60000) return (ms / 60000).toFixed(1) + "min";
			if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
			return Math.round(ms) + "ms";
		}

		/** 区块卡片：标题 + 子内容。 */
		function UsageCard(props) {
			return h("div", { style: S.usageCard },
				props.title ? h("div", { style: S.usageCardTitle }, props.title) : null,
				props.children);
		}

		/** 大数字卡：左标签右数值。 */
		function UsageStatCard(props) {
			return h("div", { style: S.usageStatCard },
				h("span", { style: S.usageStatLabel }, props.label),
				h("span", { style: Object.assign({}, S.usageStatValue, props.valueStyle || {}) }, props.value));
		}

		/** 时间窗切换按钮组（7/30/90 天）。 */
		function WindowSwitcher(props) {
			return h("div", { style: { display: "inline-flex", gap: "4px" } },
				WINDOW_OPTIONS.map(function (d) {
					var active = d === props.value;
					return h("button", {
						key: d, type: "button",
						style: active ? Object.assign({}, S.windowBtn, S.windowBtnActive) : S.windowBtn,
						onClick: function () { props.onChange(d); },
					}, d + "天");
				}));
		}

		/** 按天趋势柱状图（纯 div 无依赖）。mode: "cost" | "requests" | "tokens"。 */
		function DailyTrend(props) {
			var data = props.data || [];
			if (!data.length) return h("div", { style: S.muted }, "窗口内暂无数据");
			var key = props.mode === "requests" ? "requests" : (props.mode === "tokens" ? "tokens" : "cost");
			var values = data.map(function (d) { return d[key] || 0; });
			var max = Math.max.apply(null, values);
			var step = data.length > 14 ? Math.ceil(data.length / 14) : 1;
			var fmt = props.mode === "cost" ? fmtUsd : function (n) { return fmtTokens(n); };
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
				h("div", { style: { display: "flex", alignItems: "flex-end", gap: "3px", height: "120px" } },
					data.map(function (d) {
						var v = d[key] || 0;
						var pct = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * 100) : 0;
						return h("div", {
							key: d.day,
							title: d.day + " · " + fmt(v),
							style: { flex: "1 1 0", minWidth: "2px", height: "100%", display: "flex", alignItems: "flex-end", cursor: "default" },
						}, h("div", {
							style: {
								width: "100%", height: pct + "%", minHeight: pct > 0 ? "2px" : 0,
								background: props.mode === "cost"
									? "var(--dsw-alias-state-business-primary, #1a73e8)"
									: "var(--dsw-alias-success, #34a853)",
								borderRadius: "2px 2px 0 0",
							},
						}));
					})),
				h("div", { style: { display: "flex", gap: "3px" } },
					data.map(function (d, i) {
						var show = i % step === 0 || i === data.length - 1;
						return h("span", {
							key: d.day,
							style: Object.assign({
								flex: "1 1 0", fontSize: "10px", textAlign: "center",
								color: "var(--dsw-alias-label-tertiary)", overflow: "hidden",
								textOverflow: "ellipsis", whiteSpace: "nowrap",
							}, show ? {} : { visibility: "hidden" }),
						}, d.day.slice(5));
					})));
		}

		/** 通用数据表：列定义 { key, label, render? }，右对齐数值列。 */
		function UsageTable(props) {
			var cols = props.columns || [];
			var rows = props.rows || [];
			return h("div", { style: { overflowX: "auto" } },
				h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } },
					h("thead", null, h("tr", null, cols.map(function (c, i) {
						return h("th", {
							key: c.key || i,
							style: Object.assign({}, S.usageTh, i > 0 ? { textAlign: "right" } : {}),
						}, c.label);
					}))),
					h("tbody", null, rows.map(function (row, ri) {
						return h("tr", {
							key: row.key || ri,
							style: row.highlight ? { background: "rgba(128,128,128,0.14)" } : undefined,
						}, cols.map(function (c, ci) {
							return h("td", {
								key: c.key || ci,
								style: Object.assign({}, S.usageTd, ci > 0 ? { textAlign: "right" } : {}),
							}, c.render ? c.render(row) : String(row[c.key] ?? ""));
						}));
					}))));
		}

		/** 主区"用量"数据面板（DESIGN.md §8 终态：时间窗 + 大数字卡 + 趋势 + 排行 + 会话明细 + 费用）。 */
		function UsageView() {
			var _days = React.useState(30), days = _days[0], setDays = _days[1];
			var _daily = React.useState(null), daily = _daily[0], setDaily = _daily[1];
			var _byModel = React.useState(null), byModel = _byModel[0], setByModel = _byModel[1];
			var _sessions = React.useState(null), sessions = _sessions[0], setSessions = _sessions[1];
			var _error = React.useState(null), error = _error[0], setError = _error[1];
			var _loading = React.useState(true), loading = _loading[0], setLoading = _loading[1];
			var _mode = React.useState("cost"), mode = _mode[0], setMode = _mode[1];
			var _focus = React.useState(null), focus = _focus[0], setFocus = _focus[1];

			// 弹层"↗ 详情"交棒：聚焦指定会话。渲染期条件消费（React 官方模式）——
			// 页签已挂载时再点"↗ 详情"也能收到新交棒；消费一次即清。
			if (usageFocusRequest) {
				setFocus(usageFocusRequest);
				usageFocusRequest = null;
			}

			var load = React.useCallback(function (d) {
				setLoading(true);
				setError(null);
				var q = "?days=" + (d || 30);
				var ok = function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); };
				Promise.all([
					fetch(USAGE_URLS.daily + q, { headers: { accept: "application/json" } }).then(ok),
					fetch(USAGE_URLS.byModel + q, { headers: { accept: "application/json" } }).then(ok),
					fetch(USAGE_URLS.sessions + q, { headers: { accept: "application/json" } }).then(ok),
				]).then(function (results) {
					setDaily(results[0].data || []);
					setByModel(results[1].data || []);
					setSessions(results[2].data || []);
				}).catch(function (e) {
					setError(String((e && e.message) || e));
				}).then(function () {
					setLoading(false);
				});
			}, []);

			React.useEffect(function () { load(days); }, [days, load]);

			// 大数字卡汇总：请求数 / 总消耗 token（四桶合计）/ 费用 / 平均 TTFT（按请求数加权）
			var totals = React.useMemo(function () {
				var t = { requests: 0, tokens: 0, cost: 0, unpriced: 0, ttftSum: 0, ttftCount: 0, ttft: null };
				var rows = daily || [];
				for (var i = 0; i < rows.length; i++) {
					var r = rows[i];
					t.requests += r.requests || 0;
					t.tokens += (r.input_tokens || 0) + (r.output_tokens || 0)
						+ (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
					t.cost += r.cost_usd || 0;
					t.unpriced += r.unpriced_requests || 0;
					if (r.ttft_avg_ms != null) {
						t.ttftSum += (r.ttft_avg_ms || 0) * (r.requests || 0);
						t.ttftCount += r.requests || 0;
					}
				}
				t.ttft = t.ttftCount > 0 ? t.ttftSum / t.ttftCount : null;
				return t;
			}, [daily]);

			// 按天聚合（daily 是 天×模型 粒度 → 按天合并）
			var trend = React.useMemo(function () {
				var map = {};
				var rows = daily || [];
				for (var i = 0; i < rows.length; i++) {
					var r = rows[i];
					var d = map[r.day];
					if (!d) d = map[r.day] = { day: r.day, cost: 0, requests: 0, tokens: 0 };
					d.cost += r.cost_usd || 0;
					d.requests += r.requests || 0;
					d.tokens += (r.input_tokens || 0) + (r.output_tokens || 0)
						+ (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
				}
				return Object.keys(map).sort().map(function (k) { return map[k]; });
			}, [daily]);

			var modelColumns = [
				{ key: "model", label: "模型" },
				{ key: "provider", label: "供应商" },
				{ key: "client", label: "客户端" },
				{ key: "requests", label: "调用", render: function (r) { return fmtTokens(r.requests); } },
				{ key: "input_tokens", label: "新增输入", render: function (r) { return fmtTokens(r.input_tokens); } },
				{ key: "output_tokens", label: "输出", render: function (r) { return fmtTokens(r.output_tokens); } },
				{ key: "cache_read_tokens", label: "缓存读", render: function (r) { return fmtTokens(r.cache_read_tokens); } },
				{ key: "cost_usd", label: "费用", render: function (r) { return fmtUsd(r.cost_usd); } },
				{ key: "ttft_avg_ms", label: "平均TTFT", render: function (r) { return fmtLatency(r.ttft_avg_ms); } },
			];

			var sessionColumns = [
				{ key: "title", label: "会话" },
				{ key: "requests", label: "调用", render: function (r) { return fmtTokens(r.requests); } },
				{ key: "input_tokens", label: "新增输入", render: function (r) { return fmtTokens(r.input_tokens); } },
				{ key: "output_tokens", label: "输出", render: function (r) { return fmtTokens(r.output_tokens); } },
				{ key: "cache_read_tokens", label: "缓存读", render: function (r) { return fmtTokens(r.cache_read_tokens); } },
				{ key: "cost_usd", label: "费用", render: function (r) { return fmtUsd(r.cost_usd); } },
			];

			var sessionRows = (sessions || []).map(function (s) {
				return Object.assign({ key: s.session_id }, s,
					{ highlight: !!focus && focus.sessionId === s.session_id });
			});

			var trendToggle = [
				{ key: "cost", label: "费用" },
				{ key: "requests", label: "请求数" },
				{ key: "tokens", label: "Token" },
			];

			var body = null;
			if (loading) {
				body = h("div", { style: S.muted }, "加载中…");
			} else if (error) {
				body = h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
					h("span", { style: S.error }, "加载失败：" + error),
					h("button", { type: "button", style: S.refreshBtn, onClick: function () { load(days); } }, "重试"));
			} else if (!daily || !daily.length) {
				body = h("div", { style: S.muted }, "该时间窗内暂无用量数据");
			} else {
				body = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
					h("div", { style: S.usageStatGrid },
						h(UsageStatCard, { label: "调用次数", value: fmtTokens(totals.requests) }),
						h(UsageStatCard, { label: "Token 总消耗", value: fmtTokens(totals.tokens) }),
						h(UsageStatCard, {
							label: "估算费用",
							value: fmtUsd(totals.cost),
							valueStyle: totals.cost > 0 ? { color: "var(--dsw-alias-state-business-primary, #1a73e8)" } : {},
						}),
						h(UsageStatCard, { label: "平均 TTFT", value: fmtLatency(totals.ttft) })),
					h("div", { style: S.usageNote },
						totals.unpriced > 0
							? "另有 " + totals.unpriced + " 次调用未定价（计入 token、不计入费用）"
							: "全部调用均已按 pi-ai 刊例价定价 · 费用单位 USD"),
					h(UsageCard, { title: "按天趋势" },
						h("div", { style: { display: "flex", gap: "4px" } },
							trendToggle.map(function (t) {
								var active = t.key === mode;
								return h("button", {
									key: t.key, type: "button",
									style: active ? Object.assign({}, S.windowBtn, S.windowBtnActive) : S.windowBtn,
									onClick: function () { setMode(t.key); },
								}, t.label);
							})),
						h(DailyTrend, { data: trend, mode: mode })),
					h(UsageCard, { title: "按模型排行" },
						byModel && byModel.length
							? h(UsageTable, { columns: modelColumns, rows: byModel })
							: h("div", { style: S.muted }, "暂无数据")),
					h(UsageCard, { title: "按会话明细" },
						focus
							? h("div", { style: S.usageFocusBanner },
								h("span", null, "聚焦会话：" + (focus.title || focus.sessionId)),
								h("button", {
									type: "button", style: S.usageFocusClear,
									onClick: function () { setFocus(null); },
								}, "✕ 清除"))
							: null,
						sessionRows.length
							? h(UsageTable, { columns: sessionColumns, rows: sessionRows })
							: h("div", { style: S.muted }, "暂无数据")));
			}

			return h("div", { style: S.usageRoot },
				h("div", { style: S.usageHeader },
					h("span", { style: S.usageTitle }, "用量"),
					h(WindowSwitcher, { value: days, onChange: setDays }),
					h("button", {
						type: "button", style: S.refreshBtn,
						disabled: loading,
						onClick: function () { load(days); },
					}, loading ? "加载中…" : "刷新")),
				body);
		}

		/* ---------------------------- 插件入口 ---------------------------- */

		function apply(ctx) {
			try {
				apiRef.current = ctx.connection ? ctx.connection.api : null;
			} catch (_ignored) {
				apiRef.current = null;
			}
			ctx.slots.inject("conversation.session.header.utilities", function () {
				return ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "token-monitor",
					// 负数 order：排到 Session log（默认 0）左侧，而不是最右边缘。
					order: -10,
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
					label: "用量",
				}, UsageView);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
