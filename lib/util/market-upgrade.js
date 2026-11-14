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

/* ------------------------- 包管理器执行失败的中文文案 ------------------------- */

/**
 * 把失败原因翻成一句能看懂的中文（保留 code 供 UI 分类）。
 *
 * 表里只列**本模块真的会产出**的 code，其余走通用兜底：
 *  - `no-package-manager`：宿主没给 profileContext.packageManager
 *  - `operation-error`：pnpm / dsh CLI 非 0 退出
 *  - `timeout`：5 分钟超时
 *  - `already-installed`：web 端 CLI 拒绝重复添加
 * （link / github / network / version-mismatch / no-profile 有自己的完整句子，不走这张表。）
 */
export function upgradeErrorText(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  const table = {
    'no-package-manager': '当前宿主没有可用的 pnpm（请在桌面应用内更新）',
    'operation-error': '包管理器执行失败',
    timeout: '更新超时（5 分钟），已中止',
    'already-installed': '该版本已安装',
  };
  const base = table[code] || (code ? `更新失败（${code}）` : '更新失败');
  const diag = error && typeof error.detail === 'string' && error.detail ? `：${error.detail.slice(0, 300)}` : '';
  return base + diag;
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
  // 宿主启动时注入的 profile 目录最准确（桌面/web 各自不同，避免扫描时误判）
  const envDir = process.env.DSH_PROFILE_DIR;
  if (typeof envDir === 'string' && envDir) {
    try {
      if (fs.existsSync(path.join(envDir, 'package.json'))) {
        return { profile: process.env.DSH_PROFILE || path.basename(envDir), dir: envDir };
      }
    } catch { /* 落到下方兜底 */ }
  }
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
 * 决定 `dsh plugin <add|remove> …` 的参数（对齐 dshmarket 的 pnpm 兼容层）。
 *
 * profile 目录带 `pnpm-workspace.yaml` 时是 pnpm workspace 根：pnpm 9 在根上 add 必须带 `-w`，
 * 否则报 ERR_PNPM_ADDING_TO_ROOT；而**不是** workspace 时任何 pnpm 版本都拒绝 `-w`。
 * 所以只在 profile 确实是 workspace 根时注入。
 *
 * @param {string} profileDir profile 目录
 * @param {string[]} pluginArgs 形如 `['add', 'dsh-token-monitor@1.1.2']`
 * @returns {string[]}
 */
export function pluginArgsFor(profileDir, pluginArgs) {
  if (pluginArgs[0] !== 'add' && pluginArgs[0] !== 'remove') return pluginArgs;
  let isWorkspace = false;
  try {
    isWorkspace = fs.existsSync(path.join(profileDir, 'pnpm-workspace.yaml'));
  } catch { /* 读不到当非 workspace */ }
  if (!isWorkspace) return pluginArgs;
  return [pluginArgs[0], '-w', ...pluginArgs.slice(1)];
}

/* ------------------------- 更新进度（供客户端轮询） ------------------------- */

/**
 * 进度状态。百分比照插件市场的做法从 pnpm 的进度行算：
 * `Progress: resolved 42, reused 30, downloaded 10, added 2`
 * → (reused + downloaded + added) / resolved，钳在 4–96（开头给 4，收尾交给成功态）。
 */
var upgradeProgress = { running: false, startedAt: 0, pct: 0, lastLine: '', finishedAt: 0, ok: null };

/** 当前进度快照（含已用毫秒，客户端直接展示）。 */
export function upgradeProgressSnapshot() {
  return {
    running: upgradeProgress.running,
    pct: upgradeProgress.pct,
    lastLine: upgradeProgress.lastLine,
    elapsedMs: upgradeProgress.running ? Date.now() - upgradeProgress.startedAt : 0,
    finishedAt: upgradeProgress.finishedAt || 0,
    ok: upgradeProgress.ok,
  };
}

function beginProgress() {
  upgradeProgress = { running: true, startedAt: Date.now(), pct: 4, lastLine: '', finishedAt: 0, ok: null };
}

function endProgress(ok) {
  upgradeProgress = { ...upgradeProgress, running: false, pct: ok ? 100 : upgradeProgress.pct, finishedAt: Date.now(), ok: ok === null ? null : !!ok };
}

/** 解析 pnpm 进度行并更新百分比；其余行只更新"当前行"。 */
const PNPM_PROGRESS = /resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/;

export function noteProgressLine(line) {
  const text = String(line || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!text) return;
  upgradeProgress.lastLine = text.slice(0, 200);
  const m = PNPM_PROGRESS.exec(text);
  if (!m) return;
  const resolved = Number(m[1]);
  if (!resolved) return;
  const done = Number(m[2]) + Number(m[3]) + Number(m[4]);
  upgradeProgress.pct = Math.max(4, Math.min(96, Math.round((done / resolved) * 100)));
}

/** 把 chunk 拆行回调（保留跨 chunk 的半行）。 */
function lineFeeder(onLine) {
  let rest = '';
  return (buf) => {
    rest += buf.toString('utf8');
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() || '';
    for (const line of parts) onLine(line);
  };
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
export function runDshPlugin(profile, pluginArgs, onLine) {
  const { file, args, cwd, viaShell } = dshArgv();
  const fullArgs = [...args, 'plugin', '--profile', profile, ...pluginArgs];
  const feed = onLine ? lineFeeder(onLine) : null;
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
    const collect = (buf) => { output += buf.toString('utf8'); if (feed) feed(buf); };
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

/* ------------------------- npm latest / 更新主体 ------------------------- */

/**
 * 覆盖安装（与插件市场更新自身同一套做法）。
 *
 * 用宿主自带 pnpm 在 profile 目录执行 `pnpm add <name>@<version>`：
 * 对**已在 profile 声明**的依赖，pnpm add 是覆盖语义——磁盘文件换成新版，当前进程继续跑旧代码，
 * 所以不需要先卸载自己（卸载会把自己从正在运行的进程里摘掉），装完提示重启即可。
 *
 * @param {string} profileDir profile 目录
 * @param {string} spec 精确版本 spec，如 `dsh-token-monitor@1.1.2`
 * @param {{command:string,args:readonly string[],env:Readonly<Record<string,string>>}} [invocation] 宿主内置 pnpm 调用
 * @returns {Promise<{ok:boolean, code?:string, detail?:string}>}
 */
export async function overlayInstall(profileDir, spec, invocation, onLine) {
  if (!invocation || typeof invocation.command !== 'string' || !invocation.command.trim()) {
    return { ok: false, code: 'no-package-manager' };
  }
  const args = [...(invocation.args || []), 'add', spec];
  const feed = onLine ? lineFeeder(onLine) : null;
  return await new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(invocation.command, args, {
      cwd: profileDir,
      env: { ...process.env, ...(invocation.env || {}), CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: /\.(cmd|bat)$/i.test(invocation.command),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 忽略 */ }
    }, SPAWN_TIMEOUT_MS);
    const collect = (chunk) => { output = (output + chunk.toString()).slice(-4000); if (feed) feed(chunk); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'operation-error', detail: String((error && error.message) || error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, code: 'timeout', detail: output.slice(-600) });
      if (code !== 0) return resolve({ ok: false, code: 'operation-error', detail: output.slice(-600) });
      return resolve({ ok: true });
    });
  });
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
/**
 * 更新本插件：**覆盖安装**（不卸载自己）→ 校验落盘版本 → 要求重启。
 *
 * 桌面版用宿主内置 pnpm（`profileContext.packageManager`）在 profile 目录 `pnpm add`；
 * web 版用 PATH 上的 `dsh plugin add`。两者都是"覆盖"语义，进程继续跑旧代码，
 * 因此无论结果如何都必须重启才生效。
 *
 * @param {object} [ctx] 宿主 Cordis 上下文
 * @returns {ok, code?, message?, detail?, runtime?, current?, expected?, installed?, restartRequired?}
 */
export async function upgradePlugin(ctx) {
  const profileContext = safeGet(ctx, 'profileContext');
  const runtime = runtimeOf(profileContext);
  const own = resolveOwnProfile(profileContext);
  if (!own) return { ok: false, code: 'no-profile', runtime, message: '未定位到当前 profile 目录' };

  const spec = readDepSpec(own.dir);
  const channel = channelOf(spec);
  if (channel === 'link') {
    return {
      ok: false, code: 'linked-dev', runtime,
      message: `本插件以 link:（开发挂载）方式安装，请在源码目录 git pull 后重启${restartTarget(runtime)}。`,
    };
  }
  if (channel === 'github') {
    return { ok: false, code: 'git-channel', runtime, message: '当前为 GitHub 安装，请在源码目录 git pull 后重启。' };
  }

  const target = await npmLatest();
  if (target === null) {
    return { ok: false, code: 'network', runtime, message: '获取 npm 最新版本失败（网络或 registry 不可达），未执行更新' };
  }

  const before = readInstalledVersion(own.dir);
  const installSpec = `${PLUGIN_NAME}@${target}`;
  const addArgs = pluginArgsFor(own.dir, ['add', installSpec]);

  beginProgress();
  let run;
  if (profileContext && profileContext.packageManager) {
    // 桌面版：宿主内置 pnpm 覆盖安装（与市场更新自身同一套）
    run = await overlayInstall(own.dir, installSpec, profileContext.packageManager, noteProgressLine);
  } else {
    // web 版：PATH 上的 dsh CLI（内部同样是 pnpm add，覆盖语义）。
    // workspace 根要带 -w（pnpm 9 的硬性要求），由 pluginArgsFor 判定。
    const cli = await runDshPlugin(own.profile, addArgs, noteProgressLine);
    run = cli.timedOut
      ? { ok: false, code: 'timeout', detail: `超时（${SPAWN_TIMEOUT_MS / 1000}s）` }
      : cli.exitCode !== 0
        ? { ok: false, code: /already-installed|already exists/i.test(cli.output) ? 'already-installed' : 'operation-error', detail: cli.output.slice(-600) }
        : { ok: true };
  }
  if (!run.ok) {
    endProgress(false);
    // 失败时给出可执行的出路（web 端 CLI 可能因宿主拒绝而失败）
    const hint = run.code === 'already-installed'
      ? `；可手动执行 dsh plugin --profile ${own.profile} ${addArgs.join(' ')}，或到「设置 → 插件」更新`
      : '';
    return { ok: false, code: run.code, runtime, message: upgradeErrorText(run) + hint, detail: run.detail };
  }

  const installed = readInstalledVersion(own.dir);
  if (!installed || !semverEqual(installed, target)) {
    endProgress(false);
    return {
      ok: false, code: 'version-mismatch', runtime,
      message: `安装完成但版本不符：期望 ${target}，实际 ${installed || '未知'}`,
    };
  }

  endProgress(true);
  return {
    ok: true,
    runtime,
    current: before,
    expected: target,
    installed,
    // 磁盘上已是新版本，但当前进程仍跑旧代码 → 必须重启
    restartRequired: true,
  };
}

/** 版本检查（无副作用）：当前渠道 / 已装版本 / npm latest / 是否有更新。 */
/** 版本检查（无副作用）：渠道 / 已装版本 / npm 最新版 / 是否有更新。 */
export async function versionInfo(ctx) {
  const profileContext = safeGet(ctx, 'profileContext');
  const runtime = runtimeOf(profileContext);
  const own = resolveOwnProfile(profileContext);
  if (!own) return { ok: false, runtime, message: '未定位到当前 profile 目录' };

  const spec = readDepSpec(own.dir);
  const channel = channelOf(spec);
  const installed = readInstalledVersion(own.dir);
  const latest = channel === 'npm' ? await npmLatest() : null;
  return {
    ok: true,
    profile: own.profile,
    runtime,
    channel,
    dep: spec,
    installed,
    latest,
    hasUpdate: !!latest && !semverEqual(latest, installed || ''),
  };
}
