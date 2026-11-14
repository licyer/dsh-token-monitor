/**
 * 更新流程：覆盖安装（pnpm add）+ 版本校验 + 必须重启。
 *
 * 用假 profile 目录与假子进程命令跑，不联网、不碰真实 profile。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  upgradeErrorText, overlayInstall, resolveOwnProfile, readInstalledVersion,
  channelOf, semverEqual, upgradePlugin, versionInfo, pluginArgsFor,
  noteProgressLine, upgradeProgressSnapshot, PLUGIN_NAME,
} from '../lib/util/market-upgrade.js';

/** 造一个 profile 目录；installedVersion 非 null 时同时写 node_modules/<pkg>/package.json。 */
function tmpProfile(depSpec, installedVersion = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upgrade-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [PLUGIN_NAME]: depSpec } }));
  if (installedVersion) {
    const pkgDir = path.join(dir, 'node_modules', PLUGIN_NAME);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version: installedVersion }));
  }
  return dir;
}

const withEnv = (key, value, fn) => {
  const old = process.env[key];
  process.env[key] = value;
  try { return fn(); } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
  }
};

test('channelOf / semverEqual：渠道与版本比较', () => {
  assert.equal(channelOf('link:E:/repo'), 'link');
  assert.equal(channelOf('file:../repo'), 'link');
  assert.equal(channelOf('github:owner/repo'), 'github');
  assert.equal(channelOf('1.1.1'), 'npm');
  assert.equal(channelOf(null), 'unknown');

  assert.equal(semverEqual('1.1.1', '1.1.1'), true);
  assert.equal(semverEqual('1.1.1', '1.1.2'), false);
  assert.equal(semverEqual(null, '1.1.1'), false);
});

test('upgradeErrorText：只翻译本模块会产出的 code，其余走通用兜底', () => {
  assert.match(upgradeErrorText({ code: 'timeout' }), /超时/);
  assert.match(upgradeErrorText({ code: 'no-package-manager' }), /没有可用的 pnpm/);
  assert.match(upgradeErrorText({ code: 'already-installed' }), /已安装/);
  assert.match(upgradeErrorText({ code: 'operation-error', detail: 'ERR_PNPM_X' }), /包管理器执行失败：ERR_PNPM_X/);
  // 未登记但可能来自未来的 code：保留 code 便于排查
  assert.equal(upgradeErrorText({ code: 'something-new' }), '更新失败（something-new）');
  assert.equal(upgradeErrorText(undefined), '更新失败');
});

test('resolveOwnProfile：优先用 DSH_PROFILE_DIR（不靠扫描猜）', () => {
  const dir = tmpProfile('1.1.1', '1.1.1');
  const own = withEnv('DSH_PROFILE_DIR', dir, () => withEnv('DSH_PROFILE', 'web', () => resolveOwnProfile(undefined)));
  assert.equal(own.profile, 'web');
  assert.equal(own.dir, dir);
});

test('readInstalledVersion：读 profile 里实际落盘版本', () => {
  const dir = tmpProfile('1.1.0', '1.1.0');
  assert.equal(readInstalledVersion(dir), '1.1.0');
  assert.equal(readInstalledVersion(path.join(dir, 'nope')), null);
});

test('pluginArgsFor：workspace 根才注入 -w（web 端 dsh CLI 用）', () => {
  const plain = tmpProfile('1.1.1', '1.1.1');
  assert.deepEqual(pluginArgsFor(plain, ['add', 'x@1.0.0']), ['add', 'x@1.0.0']);

  const ws = tmpProfile('1.1.1', '1.1.1');
  fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), 'packages: []\n');
  assert.deepEqual(pluginArgsFor(ws, ['add', 'x@1.0.0']), ['add', '-w', 'x@1.0.0']);
  assert.deepEqual(pluginArgsFor(ws, ['remove', 'x']), ['remove', '-w', 'x']);

  // 非 add/remove 的参数原样返回
  assert.deepEqual(pluginArgsFor(ws, ['list']), ['list']);
});

test('进度：解析 pnpm 的 resolved/reused/downloaded/added 算百分比', () => {
  // 初始不在跑
  assert.equal(upgradeProgressSnapshot().running, false);

  noteProgressLine('Progress: resolved 100, reused 40, downloaded 10, added 0');
  assert.equal(upgradeProgressSnapshot().pct, 50);
  assert.match(upgradeProgressSnapshot().lastLine, /resolved 100/);

  // 上限 96（收尾交给成功态）
  noteProgressLine('Progress: resolved 100, reused 100, downloaded 0, added 0');
  assert.equal(upgradeProgressSnapshot().pct, 96);

  // 下限 4（刚开始也给一点进度）
  noteProgressLine('Progress: resolved 1000, reused 0, downloaded 1, added 0');
  assert.equal(upgradeProgressSnapshot().pct, 4);

  // 非进度行只更新"当前行"，不算百分比
  const before = upgradeProgressSnapshot().pct;
  noteProgressLine('Packages: +12');
  assert.equal(upgradeProgressSnapshot().lastLine, 'Packages: +12');
  assert.equal(upgradeProgressSnapshot().pct, before);
});

test('overlayInstall：命令成功 → ok', async () => {
  const dir = tmpProfile('1.1.0', '1.1.0');
  const marker = path.join(dir, 'overlay-ran.txt');
  const invocation = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
    env: {},
  };
  const run = await overlayInstall(dir, `${PLUGIN_NAME}@1.1.2`, invocation);
  assert.equal(run.ok, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ok', '应在 profile 目录里执行');
});

test('overlayInstall：命令非 0 退出 → 失败并带输出', async () => {
  const dir = tmpProfile('1.1.0', '1.1.0');
  const invocation = {
    command: process.execPath,
    args: ['-e', 'console.error("boom-pnpm"); process.exit(2)'],
    env: {},
  };
  const run = await overlayInstall(dir, `${PLUGIN_NAME}@1.1.2`, invocation);
  assert.equal(run.ok, false);
  assert.equal(run.code, 'operation-error');
  assert.match(run.detail, /boom-pnpm/);
});

test('overlayInstall：宿主没给 pnpm 调用 → no-package-manager', async () => {
  const run = await overlayInstall(tmpProfile('1.1.0'), 'x@1', undefined);
  assert.equal(run.ok, false);
  assert.equal(run.code, 'no-package-manager');
});

test('upgradePlugin：link 安装不发请求、直接拒绝', async () => {
  const dir = tmpProfile('link:E:/repo', '1.1.0');
  const result = await withEnv('DSH_PROFILE_DIR', dir, () =>
    upgradePlugin({ get: (name) => (name === 'profileContext' ? { packageManager: undefined } : undefined) }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'linked-dev');
  assert.match(result.message, /开发挂载/);
  assert.equal(result.restartRequired, undefined);
});

test('versionInfo：link 渠道不发网络请求', async () => {
  const dir = tmpProfile('link:E:/repo', '1.1.0');
  const info = await withEnv('DSH_PROFILE_DIR', dir, () => versionInfo(undefined));
  assert.equal(info.ok, true);
  assert.equal(info.channel, 'link');
  assert.equal(info.installed, '1.1.0');
  assert.equal(info.latest, null);
  assert.equal(info.hasUpdate, false);
});
