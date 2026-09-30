/**
 * dsh-token-monitor — 版本升级（按 dsh 插件市场同款思路实现）。
 *
 * 现网做法要点（对照 dshmarket）：
 *  1. profile 动态定位（从本插件自身安装路径反推所在的 <dshHome>/profiles/<name>），绝不写死；
 *  2. 子进程环境补全：PATH 追加 pnpm/npm/node 安装目录、代理翻译成 npm_config_*、CI=true
 *     （防 pnpm 无 TTY 时交互挂起）、Windows .cmd shim 经 cmd.exe 显式命令；
 *  3. 优先以解析出的真实 dsh 入口（node + bin 绝对路径）重启 CLI，避免依赖 PATH；
 *  4. npm 渠道升级 = `dsh plugin --profile <p> update <name>@<精确版本>`（把依赖 spec 钉到已解析的
 *     latest，保证真的装上目标版本）；github 渠道 = `update <name>`（按原 spec 重拉 main）；
 *  5. 成功判定双重校验：退出码 0 之外，再读 profile 安装目录的 package.json 版本，与期望版本一致才算成功；
 *  6. link（开发挂载）渠道明确拒绝并说明原因；
 *  7. 服务端插件更新后无法热加载 → 返回 restartRequired，由前端提示"请重启 dsh web 生效"；
 *  8. 子进程一律**异步** spawn（不用 spawnSync）：本插件在宿主进程内，同步等待会把整个
 *     DSH 的事件循环钉住（最长 5 分钟），届时所有页面一起卡死。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './http.js';

export const PLUGIN_NAME = 'dsh-token-monitor';
const NPM_LATEST_URL = 'https://registry.npmjs.org/dsh-token-monitor/latest';
const SPAWN_TIMEOUT_MS = 5 * 60 * 1000;

/* ------------------------- 宿主环境判别（两种安装方式） ------------------------- */

/** 安全取宿主服务（ctx 可能为 undefined，服务可能不存在/抛错）。 */
function safeGet(ctx, name) {
  try { return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined; } catch { return undefined; }
}

/**
 * 运行环境：`packaged`（桌面版：宿主带内置包管理器）/ `hosted`（web 版：用 PATH 上的 pnpm）。
 * 判据取自官方 `profileContext.packageManager`——其契约原文即
 * "Packaged applications supply their bundled runtime instead of a PATH executable."
 */
function runtimeOf(profileContext) {
  return profileContext && profileContext.packageManager ? 'packaged' : 'hosted';
}

/** 重启目标的用户文案（两端进程不同）。 */
function restartTarget(runtime) {
  return runtime === 'packaged' ? '桌面应用' : 'dsh web';
}

/* ------------------------- profile / 安装渠道定位 ------------------------- */

/**
 * 定位"本插件所在的 profile"。
 *
 * **优先用宿主注入的 `profileContext`**（权威）：它直接给出当前宿主是谁（`name`）与 profile 目录（`dir`）。
 * 为什么必须优先它：本模块以 `link:` 挂载时，自身真实路径在 `profiles/` 之外，只能落到下面的
 * "扫描 profiles/*" 兜底，而扫描按目录名排序 → **两端都会推成排在前面的 `desktop`**，
 * 于是 web 实例会拿桌面 profile 去升级/判定渠道。`profileContext` 没有这个问题。
 * @param {object} [profileContext] 宿主服务（`ctx.get("profileContext")`），可选
 */
export function resolveOwnProfile(profileContext) {
  if (profileContext
    && typeof profileContext.name === 'string' && profileContext.name
    && typeof profileContext.dir === 'string' && profileContext.dir) {
    try {
      if (fs.existsSync(path.join(profileContext.dir, 'package.json'))) {
        return { profile: profileContext.name, dir: profileContext.dir };
      }
    } catch { /* 落到下方兜底 */ }
  }
  // 从本模块自身文件路径反推所在 profile：<dshHome>/profiles/<name>/node_modules/dsh-token-monitor/...
  try {
    const here = fileURLToPath(import.meta.url).split(/[\\/]+/).filter(Boolean);
    for (let i = 0; i < here.length - 1; i += 1) {
      if (here[i] === 'profiles' && here[i + 1] && here[i + 1] !== 'node_modules') {
        const profile = here[i + 1];
        const dir = path.join(here.slice(0, i).join(path.sep), 'profiles', profile);
        if (fs.existsSync(path.join(dir, 'package.json'))) return { profile, dir };
        return null;
      }
    }
  } catch { /* 落入下方兜底 */ }
  // 兜底：扫描 dshHome/profiles/* 中声明了本插件的 profile（按目录名排序，可能不是当前宿主）
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    const root = path.join(home, 'profiles');
    if (!fs.existsSync(root)) return null;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const pkg = path.join(dir, 'package.json');
      if (!fs.existsSync(pkg)) continue;
      let deps = {};
      try { deps = JSON.parse(fs.readFileSync(pkg, 'utf8')).dependencies || {}; } catch { continue; }
      if (typeof deps[PLUGIN_NAME] === 'string') return { profile: name, dir };
    }
  } catch { /* ignore */ }
  return null;
}

/** 读 profile package.json 里本插件的依赖声明（link: / github: / 版本号）。 */
export function readDepSpec(profileDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    const dep = pkg.dependencies && pkg.dependencies[PLUGIN_NAME];
    return typeof dep === 'string' ? dep : null;
  } catch {
    return null;
  }
}

/** 安装渠道：link（开发挂载）/ github / npm（其余均视为 npm 发布版）。 */
export function channelOf(spec) {
  if (!spec) return 'unknown';
  if (spec.startsWith('link:') || spec.startsWith('file:')) return 'link';
  if (spec.startsWith('github:')) return 'github';
  return 'npm';
}

/** 读 profile 安装目录里本插件实际落盘的版本（pnpm 的 node_modules/<pkg> 指向带版本目录，version 即实装版）。 */
export function readInstalledVersion(profileDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/* ------------------------- 子进程环境（对齐市场） ------------------------- */

function nodeExecutable() {
  const { argv0, execPath } = process;
  if (argv0 && typeof argv0 === 'string' && path.isAbsolute(argv0) && fs.existsSync(argv0)) return argv0;
  return execPath;
}

/** 目录列表：Node bin + 常见 pnpm/npm 安装位置（GUI 启动常不继承 shell PATH）。 */
function toolSearchDirs() {
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
  const pnpmHome = (process.env.PNPM_HOME || '').trim();
  add(pnpmHome);
  if (process.platform === 'win32') {
    add(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : '');
    add(process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '');
  } else {
    add('/opt/homebrew/bin'); add('/usr/local/bin');
  }
  add(path.dirname(nodeExecutable()));
  return dirs.filter(Boolean);
}

/** 系统代理 → pnpm 读的 npm_config_*（HTTPS_PROXY 等 pnpm 不认）。 */
function proxyEnvForPnpm() {
  const env = process.env;
  const out = {};
  const pick = (...names) => { for (const n of names) { const v = env[n]; if (v && String(v).trim() !== '') return String(v).trim(); } return null; };
  const hasAny = (wanted) => Object.keys(env).some((k) => k.toLowerCase() === wanted && String(env[k] || '').trim() !== '');
  const https = pick('https_proxy', 'HTTPS_PROXY');
  const http = pick('http_proxy', 'HTTP_PROXY');
  if (https && !hasAny('npm_config_https_proxy')) out.npm_config_https_proxy = https;
  if (http && !hasAny('npm_config_proxy')) out.npm_config_proxy = http;
  const noProxy = pick('no_proxy', 'NO_PROXY');
  if (noProxy && !hasAny('npm_config_noproxy')) out.npm_config_noproxy = noProxy;
  return out;
}

/** Windows .cmd shim 只能经 shell；显式构造 cmd.exe 命令并逐 token 转义。 */
const CMD_METACHARS = /[\s"&|<>^()%!]/;
function quoteCmdArg(arg) {
  if (!CMD_METACHARS.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * 解析"重新调用 dsh CLI"的入口：优先 process.argv[1]（真实入口，可能带 execArgv），
 * 否则回退 PATH 上的 `dsh`（Windows 上是 .cmd，需经 cmd.exe）。
 */
function dshArgv() {
  const entry = process.argv[1];
  if (entry && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = path.resolve(entry);
    return { file: nodeExecutable(), args: [...process.execArgv, abs], cwd: path.dirname(abs), viaShell: false };
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: process.platform === 'win32' };
}

/**
 * 跑一次 `dsh plugin --profile <name> …`（**异步**，带超时）。
 *
 * 必须是异步 spawn：本插件跑在宿主进程里，升级一次 pnpm 通常十几秒、上限 5 分钟，
 * 用 spawnSync 会把整个 DSH 的事件循环钉住（所有页面/会话一起卡死）。这里用 spawn +
 * Promise，等待期间宿主照常服务，只在结果上做同一套判定（退出码 + 超时 + 输出）。
 *
 * @returns {Promise<{exitCode:number, timedOut:boolean, output:string}>}
 */
export function runDshPlugin(profile, pluginArgs) {
  const { file, args, cwd, viaShell } = dshArgv();
  const fullArgs = [...args, 'plugin', '--profile', profile, ...pluginArgs];
  const envParts = (process.env.PATH || '').split(path.delimiter);
  for (const dir of toolSearchDirs()) if (!envParts.includes(dir)) envParts.push(dir);
  const spawnOpts = {
    cwd,
    env: { ...process.env, ...proxyEnvForPnpm(), CI: 'true', PATH: envParts.join(path.delimiter) },
    windowsHide: true,
  };

  return new Promise((resolve) => {
    let child;
    const invoke = () => {
      if (!viaShell) return spawn(file, fullArgs, { ...spawnOpts, shell: false });
      if (process.platform === 'win32') {
        const line = [file, ...fullArgs].map(quoteCmdArg).join(' ');
        return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
          ...spawnOpts, shell: false, windowsVerbatimArguments: true,
        });
      }
      return spawn(file, fullArgs, { ...spawnOpts, shell: true });
    };
    try {
      child = invoke();
    } catch (error) {
      resolve({ exitCode: 127, timedOut: false, output: String((error && error.message) || error) });
      return;
    }

    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, output: output.trim() });
    };
    const collect = (buf) => { output += buf.toString('utf8'); };
    if (child.stdout) child.stdout.on('data', collect);
    if (child.stderr) child.stderr.on('data', collect);
    // 超时：先 SIGTERM，宽限 5s 仍未退出再 SIGKILL（Windows 上等价于终止进程树）
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 已退出 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 5000).unref?.();
    }, SPAWN_TIMEOUT_MS);
    child.on('error', (error) => {
      output += String((error && error.message) || error);
      finish(127);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

/* ------------------------- npm latest / 升级主体 ------------------------- */

/**
 * 走**官方宿主服务 `pluginManager`** 执行一次安装/升级（`installBundle`）。
 *
 * 为什么它是"两种安装方式都能用"的那条路：该服务在宿主进程内、以 `ctx.profileContext` 绑定
 * **当前 profile**（桌面宿主→desktop、web 宿主→web），包管理器也由 profileContext 决定——
 * **打包应用（桌面版）用应用内置的 pnpm，其余用 PATH 上的 pnpm**；同时自带 bundle 注册、
 * 失败回滚（`package.json`/`pnpm-lock.yaml`）与 `application` 结果（`applied`/`restart-required`）。
 *
 * 两个必须注意的点：
 *  1. **不要先调 `inspect()`**：它对"已安装"会直接 `refused("already-installed")`（官方 UI 因此
 *     只给"先卸载再安装"的引导）；而 `installBundle` 内部就是 `pnpm add <spec>`，
 *     对已安装的包即升/降级到该版本 —— 这就是官方虽未在 UI 暴露、但服务层面可用的升级通道。
 *  2. `enabled` 不传（默认 true）：装完即启用该 bundle，与"升级后仍启用"的预期一致。
 *
 * @param {object} manager `ctx.get("pluginManager")`
 * @param {string} target 安装 spec，如 `dsh-token-monitor@1.0.11`
 * @returns {Promise<{ok:boolean, changed?:boolean, application?:string, error?:string}>}
 */
export async function installViaManager(manager, target) {
  try {
    const result = await manager.installBundle(target, {});
    if (!result || typeof result !== 'object') {
      return { ok: false, error: 'pluginManager.installBundle 未返回结果' };
    }
    const application = typeof result.application === 'string' ? result.application : undefined;
    if (application === 'failed' || application === 'cancelled') {
      const detail = result.error === undefined ? '' : ` ${JSON.stringify(result.error).slice(0, 300)}`;
      return { ok: false, changed: !!result.changed, application, error: `${application}${detail}` };
    }
    return { ok: true, changed: !!result.changed, application };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

let latestCache = { at: 0, value: null };
export async function npmLatest() {
  if (latestCache.value && Date.now() - latestCache.at < 5 * 60 * 1000) return latestCache.value;
  try {
    const res = await fetchJson(NPM_LATEST_URL);
    const v = res && res.ok && res.data && res.data.version;
    if (typeof v === 'string' && v) { latestCache = { at: Date.now(), value: v }; return v; }
  } catch { /* 网络失败 */ }
  return latestCache.value;
}

export function semverEqual(a, b) {
  if (!a || !b) return false;
  const p = (v) => String(v).split('.').slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const x = p(a); const y = p(b);
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

/**
 * 升级到 npm latest（npm/github 渠道）；link 渠道拒绝。
 *
 * **两种安装方式各走各的通路（都基于官方能力）**：
 *  - 桌面版（打包应用）：宿主 `pluginManager` → 应用内置 pnpm + desktop profile。
 *    独立 CLI 无权管理 desktop profile（`rejectElectronProfile`），所以**不能**走 `dsh plugin` 子进程。
 *  - web 版：同样优先走宿主 `pluginManager`（用 PATH 上的 pnpm + web profile），
 *    旧版 DSH 没有该服务时才回退到 `dsh plugin --profile web update` 子进程。
 *
 * @param {object} [ctx] 宿主 Cordis 上下文（用于取 `profileContext` / `pluginManager`）
 * @returns {ok, code?, message?, channel?, current?, expected?, installed?, restartRequired?, runtime?, detail?}
 */
export async function upgradePlugin(ctx) {
  const profileContext = safeGet(ctx, 'profileContext');
  const own = resolveOwnProfile(profileContext);
  if (!own) return { ok: false, message: '未定位到当前 dsh profile（本插件不在 profiles 安装目录内）' };
  const runtime = runtimeOf(profileContext);
  const spec = readDepSpec(own.dir);
  const channel = channelOf(spec);
  if (channel === 'link') {
    return {
      ok: false, code: 'linked-dev', runtime,
      message: `本插件以 link:（开发挂载）方式安装，不能通过发布版升级——请到源码目录 git pull 后重启${restartTarget(runtime)}；或改用应用内插件管理，或执行 "dsh plugin add dsh-token-monitor@latest" 安装正式版。`,
    };
  }
  if (channel === 'unknown') return { ok: false, message: '无法从 profile package.json 识别安装渠道' };

  const expected = await npmLatest();
  if (expected === null) return { ok: false, message: '获取 npm 最新版本失败（网络或 registry 不可达），未执行升级' };

  const before = readInstalledVersion(own.dir);
  const target = channel === 'npm' ? `${PLUGIN_NAME}@${expected}` : PLUGIN_NAME;

  // ① 官方宿主服务（两端通用；桌面版用它才能绕开 CLI 的 desktop-profile 闸门并使用内置 pnpm）
  const manager = safeGet(ctx, 'pluginManager');
  let run = null;
  let via = null;
  if (manager && typeof manager.installBundle === 'function') {
    via = 'pluginManager';
    run = await installViaManager(manager, target);
  } else {
    // ② 回退：旧版 DSH 无 pluginManager（或宿主未暴露）→ 仍用 CLI 子进程
    via = 'dsh-cli';
    const cli = await runDshPlugin(own.profile, ['update', target]);
    run = cli.timedOut
      ? { ok: false, error: `升级超时（${SPAWN_TIMEOUT_MS / 1000}s），已终止` }
      : cli.exitCode !== 0
        ? { ok: false, error: `dsh plugin update 失败（exit ${cli.exitCode}）`, detail: cli.output.slice(-800) }
        : { ok: true };
  }
  if (!run.ok) {
    return {
      ok: false, channel, runtime, via,
      message: run.error || '升级失败',
      detail: run.detail || undefined,
    };
  }

  // 双重校验：真实落盘版本是否到位（服务/命令说成功 ≠ 磁盘版本正确）
  const installed = readInstalledVersion(own.dir);
  if (channel === 'npm') {
    if (!installed) return { ok: false, channel, runtime, via, message: '升级命令返回成功，但读不到安装目录的版本号' };
    if (!semverEqual(installed, expected)) {
      return {
        ok: false, channel, runtime, via,
        message: `命令成功但版本未到位：期望 ${expected}，实际 ${installed}（可能是依赖 spec 限定了范围）`,
      };
    }
  }

  return {
    ok: true,
    channel,
    runtime,
    via,
    current: before || null,
    expected: channel === 'npm' ? expected : installed || null,
    installed,
    // 服务端插件更新已在磁盘，进程里跑的还是旧代码：需重启对应进程才加载
    restartRequired: true,
  };
}

/** 版本检查（无副作用）：当前渠道 / 已装版本 / npm latest / 是否有更新。 */
export async function versionInfo(ctx) {
  const profileContext = safeGet(ctx, 'profileContext');
  const own = resolveOwnProfile(profileContext);
  if (!own) return { ok: false, message: '未定位到当前 dsh profile' };
  const spec = readDepSpec(own.dir);
  const channel = channelOf(spec);
  const installed = readInstalledVersion(own.dir);
  const latest = channel === 'npm' || channel === 'github' ? await npmLatest() : null;
  return {
    ok: true,
    profile: own.profile,
    runtime: runtimeOf(profileContext),
    channel,
    dep: spec,
    installed,
    latest,
    hasUpdate: latest ? !semverEqual(latest, installed || '') : false,
  };
}
