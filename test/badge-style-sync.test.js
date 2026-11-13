/**
 * 徽标样式漂移检测（issue: 徽标与系统控件大小不一致）
 *
 * 我们的头部徽标是照着 DSH 系统组件 `.OMoRSG_split` / `.OMoRSG_main`
 * （`@deepseek-ai/dsh-client-ui-open-in-app` 里的「分体按钮」）逐条对齐的。
 * 系统升级后这几个数值可能变化，而类名哈希每次构建都会变（CAgGvG → OMoRSG），
 * 不能靠类名引用，只能靠**比对数值**发现漂移。
 *
 * 本测试从已安装的 DSH 包里读出该组件的实际 CSS，与 lib/client.js 里的
 * `S.pill` / `S.trigger` 逐字段比较；不一致即失败并打印两边的值。
 * 未安装 DSH（纯 CI 环境）时自动跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = path.join(repoRoot, 'lib', 'client.js');

/** 规范化：去引号、去多余空格、0.5px → .5px、小写属性值里的空白。 */
function norm(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\b0\.(\d)/g, '.$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 在已安装的 DSH profile 里找 open-in-app 的客户端产物。 */
function findSystemClientFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [];
  const profiles = path.join(home, 'profiles');
  if (fs.existsSync(profiles)) {
    for (const name of fs.readdirSync(profiles)) {
      candidates.push(path.join(
        profiles, name, 'node_modules', '@deepseek-ai',
        'dsh-client-ui-open-in-app', 'lib', 'client.js',
      ));
    }
    candidates.push(path.join(
      profiles, 'node_modules', '@deepseek-ai',
      'dsh-client-ui-open-in-app', 'lib', 'client.js',
    ));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** 取出某个 CSS 声明块的属性值。 */
function decl(block, prop) {
  const m = block.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

/** 从系统 CSS 文本里定位分体按钮：包含 border + height + border-radius 的 `_split` 规则。 */
function readSystemMetrics(css) {
  const splitRules = [...css.matchAll(/\.([A-Za-z0-9_-]+)_split\{([^}]*)\}/g)]
    .map((m) => ({ prefix: m[1], block: m[2] }))
    .filter((r) => decl(r.block, 'border') && decl(r.block, 'height') && decl(r.block, 'border-radius'));

  if (splitRules.length === 0) return null;
  const split = splitRules[0];

  // 注意：字号等属性可能写在共享选择器里（`.X_main,.X_chevron{...}`），
  // 所以要把所有选择器含 `X_main` 的规则块合并后再取声明。
  const mainBlocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].includes(`${split.prefix}_main`))
    .map((m) => m[2]);
  if (mainBlocks.length === 0) return null;
  const main = mainBlocks.join(';');

  return {
    height: decl(split.block, 'height'),
    borderRadius: decl(split.block, 'border-radius'),
    border: decl(split.block, 'border'),
    alignItems: decl(split.block, 'align-items'),
    fontSize: decl(main, 'font-size'),
    lineHeight: decl(main, 'line-height'),
    padding: decl(main, 'padding'),
    gap: decl(main, 'gap'),
  };
}

/** 从我们的 client.js 里取出 S.pill / S.trigger 的对应值。 */
function readOursMetrics(source) {
  const pill = source.match(/\bpill:\s*\{([\s\S]*?)\n\t\t\t\}/);
  const trigger = source.match(/\btrigger:\s*\{([\s\S]*?)\n\t\t\t\}/);
  assert.ok(pill, '未能在 lib/client.js 中找到 S.pill 样式对象');
  assert.ok(trigger, '未能在 lib/client.js 中找到 S.trigger 样式对象');

  const grab = (block, key) => {
    const m = block.match(new RegExp(`\\b${key}:\\s*"([^"]*)"`));
    return m ? m[1] : null;
  };

  return {
    height: grab(pill[1], 'height'),
    borderRadius: grab(pill[1], 'borderRadius'),
    border: grab(pill[1], 'border'),
    alignItems: grab(pill[1], 'alignItems'),
    fontSize: grab(trigger[1], 'fontSize'),
    lineHeight: grab(trigger[1], 'lineHeight'),
    padding: grab(trigger[1], 'padding'),
    gap: grab(trigger[1], 'gap'),
  };
}

test('徽标样式与系统分体按钮（.OMoRSG_split/.OMoRSG_main）保持一致', (t) => {
  const systemFile = findSystemClientFile();
  if (!systemFile) {
    t.skip('未安装 DSH 客户端包（@deepseek-ai/dsh-client-ui-open-in-app），跳过漂移检测');
    return;
  }

  const css = fs.readFileSync(systemFile, 'utf8');
  const sys = readSystemMetrics(css);
  if (!sys) {
    t.skip('系统包里没找到分体按钮规则（DSH 可能重构了该组件），请手动复核徽标样式来源');
    return;
  }

  const ours = readOursMetrics(fs.readFileSync(clientPath, 'utf8'));

  const fields = ['height', 'borderRadius', 'border', 'alignItems', 'fontSize', 'lineHeight', 'padding', 'gap'];
  const mismatches = [];
  for (const key of fields) {
    const a = norm(sys[key]);
    const b = norm(ours[key]);
    if (a !== b) mismatches.push(`  ${key}: 系统=${a}  我们=${b}`);
  }

  assert.deepEqual(
    mismatches, [],
    `徽标样式与系统分体按钮已漂移，请按系统值更新 S.pill / S.trigger：\n${mismatches.join('\n')}\n\n来源：${systemFile}`,
  );
});
