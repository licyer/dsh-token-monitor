/**
 * 徽标样式契约（issue: 徽标与系统控件大小不一致）
 *
 * 0.2.2-rc.3 起，会话头部右侧只剩两个操作按钮（open-in-app 的文件夹胶囊已移出头部）：
 *   1. 三个点（会话菜单）：`contextMenu.button` → 共享 Button `size="sm"` + `.headerMenuButton`
 *      → height 28px、border-radius var(--dsw-radius-sm)=8px、hover 背景
 *        var(--dsw-alias-interactive-bg-hover)
 *   2. 展开（右侧栏）：`sidebar-right` 的 `.iconButton` → 28×28、radius 8px、同一 hover 背景
 * 两者的 hover **只换背景色，尺寸不变**。
 *
 * 我们的徽标保留 0.5px 描边（系统那两个没有），其余（高度/圆角/hover 背景）与之一致；
 * 悬浮提示气泡照系统 Tooltip 的 `_bubble`（padding 3px 7px / radius 8px / 13px 20px /
 * tooltip 专用前景背景色 / 下方居中 / 150ms 淡入）。
 *
 * 系统那几个值来自 DSH 安装包（app.asar），普通 node 的 fs 读不了 asar，所以这里改成
 * **快照断言**：把对齐后的数值钉死，任何一侧被改都会失败并打印当前值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'lib', 'client.js'), 'utf8');

/** 取出 S.pill / S.trigger 样式对象体。 */
function styleBlock(name) {
  const m = source.match(new RegExp(`\\b${name}:\\s*\\{([\\s\\S]*?)\\n\\t\\t\\t\\}`));
  assert.ok(m, `未能在 lib/client.js 中找到 S.${name} 样式对象`);
  return m[1];
}

/** 从一个样式对象体里取某个键的字符串值。 */
function decl(block, key) {
  const m = block.match(new RegExp(`\\b${key}:\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

test('徽标容器：高度 / 圆角 / 描边与系统头部按钮对齐', () => {
  const pill = styleBlock('pill');
  // 系统两个按钮都是 28px 高、radius-sm(8px)；我们保留 0.5px 描边
  assert.equal(decl(pill, 'height'), '28px', '徽标高度应与系统头部按钮一致（28px）');
  assert.equal(decl(pill, 'borderRadius'), 'var(--dsw-radius-sm)', '圆角应与系统一致（radius-sm=8px）');
  assert.equal(decl(pill, 'border'), '0.5px solid var(--dsw-alias-border-l4)', '描边保留，颜色沿用 border-l4');
  assert.equal(decl(pill, 'alignItems'), 'stretch');
  assert.equal(decl(pill, 'boxSizing'), 'border-box');
});

test('内层按钮：字号与行高沿用系统 sm 规格', () => {
  const trigger = styleBlock('trigger');
  assert.equal(decl(trigger, 'fontSize'), '11px');
  assert.equal(decl(trigger, 'lineHeight'), '16px');
  assert.equal(decl(trigger, 'gap'), '4px');
  assert.equal(decl(trigger, 'padding'), '3px 5px');
});

test('hover：只换背景色，尺寸不变', () => {
  // 系统按钮的 hover 规则：background: var(--dsw-alias-interactive-bg-hover)，无尺寸变化
  const hoverLine = source.match(/if \(hovered\) triggerStyle\.background = "([^"]+)"/);
  assert.ok(hoverLine, '未找到 hover 背景色设置');
  assert.equal(hoverLine[1], 'var(--dsw-alias-interactive-bg-hover)');
  // hover 分支里不得改动尺寸
  assert.ok(!/hovered[^\n]*(height|padding|width|border)/i.test(source), 'hover 不应改变尺寸或边框');
});

test('悬浮提示气泡：照系统 Tooltip 的 _bubble 规格', () => {
  const m = source.match(/\.tm-tip\{([^}]*)\}/);
  assert.ok(m, '未找到 .tm-tip 样式');
  const css = m[1];
  const has = (re, label) => assert.ok(re.test(css), `气泡缺少 ${label}：${css}`);

  has(/position:fixed/, 'fixed 定位（委托层统一摆放）');
  has(/padding:3px 7px/, 'padding 3px 7px');
  has(/border-radius:var\(--dsw-radius-sm\)/, 'radius-sm 圆角');
  has(/font-size:13px/, '13px 字号');
  has(/line-height:20px/, '20px 行高');
  has(/background:var\(--dsw-alias-tooltip-bg/, 'tooltip 背景色 token');
  has(/color:var\(--dsw-alias-tooltip-label/, 'tooltip 前景色 token');
  has(/pointer-events:none/, '不拦截鼠标');
  has(/animation:tm-badge-tip-in \.15s/, '150ms 淡入');
});

test('悬浮提示：定位交给 CSS 锚点（gap 8 / bottom / 自动换边）', () => {
  // 默认间距 8（系统 Tooltip 的 gap 默认值），表格单元格变体贴底 0
  assert.ok(/margin-top:var\(--tm-tip-gap,8px\)/.test(source), 'gap 默认应为 8px');
  assert.ok(/\.tm-tip\[data-variant=cell\]\{--tm-tip-gap:0\}/.test(source), '表格单元格应贴底（gap 0）');
  // 锚点定位 + 自动换边（不再由 JS 算坐标）
  assert.ok(/position-anchor:--tm-tip-anchor/.test(source), '缺少 position-anchor');
  assert.ok(/top:anchor\(bottom\)/.test(source), '应锚定在目标下方');
  assert.ok(/position-try-fallbacks:--tm-tip-up,--tm-tip-end,--tm-tip-up-end/.test(source), '缺少翻上/靠右的回退');
  assert.ok(/@position-try --tm-tip-end\{left:auto;right:anchor\(right\)/.test(source), '靠右回退应贴目标右缘');
  // 表格单元格：按列自身对齐方式决定气泡对齐（左列贴左、右列贴右）
  assert.ok(/getComputedStyle\(el\)\.textAlign/.test(source), '应读取单元格的 text-align');
  assert.ok(/ta === "right" \|\| ta === "end"\) \? "end"/.test(source), '右对齐列应靠右');
  assert.ok(/ta === "left" \|\| ta === "start"\) \? "start"/.test(source), '左对齐列应靠左');
  assert.ok(/anchor-name|anchor-name: --tm-tip-anchor/.test(source) || source.includes('setProperty("anchor-name"'), '应在 hover 时给目标挂 anchor-name');
  // 浏览器支持检测 + 兜底
  assert.ok(/CSS\.supports\("position-anchor: --tm-tip-anchor"\)/.test(source), '缺少锚点定位能力检测');
  assert.ok(/tipPlaceFallback/.test(source), '缺少不支持时的兜底定位');
  // 徽标与右侧「三个点」一致：align=end
  assert.ok(/"data-tip": tipText,\s*\n\s*"data-tip-align": "end",/.test(source), '徽标提示应为 align=end（与三个点一致）');
  // 逐元素覆盖仍可用
  for (const attr of ['data-tip-side', 'data-tip-align', 'data-tip-gap']) {
    assert.ok(source.includes(`getAttribute("${attr}")`), `缺少 ${attr} 覆盖支持`);
  }
});

test('悬浮提示：全局委托层 500ms 延迟，数据来源卡也走同一层', () => {
  assert.ok(/setTimeout\(function \(\) \{ tipTimer = null; tipShow\(el\); \}, 500\)/.test(source), '提示延迟应为 500ms');
  assert.ok(/tipTimer = setTimeout/.test(source), '缺少延迟定时器');
  assert.ok(source.includes('closest("[data-tip]")'), '缺少 data-tip 委托查找');
  // 数据来源卡的「简要说明」「目录」与操作按钮都改走 data-tip，不再用原生 title
  assert.ok(/"data-tip": t\("src\.dshDesc"\)/.test(source), 'DSH 简要说明未使用 data-tip');
  assert.ok(/"data-tip": t\("src\.ccDesc"\)/.test(source), 'CC 简要说明未使用 data-tip');
  assert.ok(/"data-tip": t\("src\.openDir"\)/.test(source), '打开目录按钮未使用 data-tip');
  assert.ok(!/title: t\("src\.(dshDesc|ccDesc|openDir|import|export|delete)"\)/.test(source), '数据来源卡不应再残留原生 title');
});

test('所有悬浮提示统一：无自建浮层、无原生 title 属性', () => {
  // 旧的「跟随鼠标」自绘浮层已删除，表格也改走 data-tip
  assert.ok(!source.includes('data-tip-text'), '旧自绘浮层（data-tip-text）应已移除');
  assert.ok(!source.includes('data-tm-tip'), '旧浮层节点（data-tm-tip）应已移除');
  assert.ok(
    /var cellProps = c\.title \? \{ "data-tip": c\.title\(row\) \}/.test(source),
    '表格长内容列应使用 data-tip',
  );
  // 原先用原生 title 的位置逐个抽查
  for (const key of ['entry.openSite', 'entry.openUsage', 'focus.clear', 'settings.pricing.title', 'src.dshDesc']) {
    assert.ok(source.includes(`"data-tip": t("${key}")`), `${key} 未改走 data-tip`);
  }
  // h(...) 的 props 里不应再出现原生 title（列定义里的 c.title 是数据字段，不在此列）
  const domTitle = source.match(/h\("[a-z]+", \{[^{}]*?\btitle:\s/g);
  assert.equal(domTitle, null, `仍有原生 title 属性：${domTitle}`);
});
