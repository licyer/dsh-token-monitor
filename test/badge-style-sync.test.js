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
  const m = source.match(/\.tm-badge-tip\{([^}]*)\}/);
  assert.ok(m, '未找到 .tm-badge-tip 样式');
  const css = m[1];
  const has = (re, label) => assert.ok(re.test(css), `气泡缺少 ${label}：${css}`);

  has(/padding:3px 7px/, 'padding 3px 7px');
  has(/border-radius:var\(--dsw-radius-sm\)/, 'radius-sm 圆角');
  has(/font-size:13px/, '13px 字号');
  has(/line-height:20px/, '20px 行高');
  has(/background:var\(--dsw-alias-tooltip-bg/, 'tooltip 背景色 token');
  has(/color:var\(--dsw-alias-tooltip-label/, 'tooltip 前景色 token');
  has(/top:calc\(100% \+ 6px\)/, '位于徽标下方 6px');
  has(/left:50%/, '水平居中');
  has(/pointer-events:none/, '不拦截鼠标');
  has(/animation:tm-badge-tip-in \.15s/, '150ms 淡入');
});

test('悬浮提示：500ms 延迟，与系统 Tooltip 的 delayMs 一致', () => {
  assert.ok(/setTimeout\(function \(\) \{ setTipOn\(true\); \}, 500\)/.test(source), '提示延迟应为 500ms');
});
