#!/usr/bin/env node
/**
 * 一次性历史回填 CLI：把 DSH 会话日志目录之外遗留的会话日志补进 token-monitor.db。
 *
 * 什么时候需要它：DSH 升级 / 目录迁移时会把旧的 `$DSH_HOME/sessions` 整体挪走
 * （例如 `~/.dsh/sessions_backup_20260910_204118`），新目录里没有这些会话，
 * 插件常规扫描只看 `$DSH_HOME/sessions`，于是这段时间的用量在页面上是空的。
 *
 * 安全性：
 *   - 复用插件【生产同款】折叠逻辑（foldAllSessions / foldSessionFile），
 *     文件名发现、版本择新、换名重置水位、record_id 去重口径与后台采集完全一致。
 *   - 主根优先：与 `$DSH_HOME/sessions` 中同 sessionId 的副本会被跳过，
 *     不会把水位改写到备份路径、拖坏后续增量采集。
 *   - 幂等：明细是 `INSERT OR IGNORE`（主键 sessionId:seq），重复跑不会重复计费。
 *     退出码 0 且 PASS 摘要为 0 新增，即表示库已是回填后状态。
 *
 * 用法：
 *   node scripts/backfill-sessions.mjs --dry-run          # 在库副本上真实预演，报告将新增多少
 *   node scripts/backfill-sessions.mjs                    # 回填 $DSH_HOME 下所有 sessions_backup_*
 *   node scripts/backfill-sessions.mjs /path/to/backup    # 回填指定根目录（可多个）
 *   node scripts/backfill-sessions.mjs --list             # 只列出候选根目录
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldAllSessions } from '../lib/util/fold.js';
import { openUsageStore } from '../lib/util/store.js';
import { loadPricing } from '../lib/util/pricing.js';

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh');
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

if (flags.has('--help') || flags.has('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

/** 默认候选根：$DSH_HOME 下形如 sessions_backup_* / sessions.pre-restore-* 的兄弟目录。 */
function defaultRoots() {
  let names;
  try {
    names = fs.readdirSync(DSH_HOME);
  } catch {
    return [];
  }
  return names
    // 只认真实会话目录的兄弟备份：sessions_backup_* / sessions.pre-restore-*
    // （storage 下的 session_projcache* 是别的模块的数据，不要匹配进来）
    .filter((n) => /^sessions[._-]/.test(n))
    .filter((n) => !n.startsWith('session_'))
    .map((n) => path.join(DSH_HOME, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

const roots = positional.length ? positional : defaultRoots();

console.log(`DSH_HOME      : ${DSH_HOME}`);
console.log(`主根（常规）  : ${SESSIONS_ROOT}`);
console.log(`回填根        : ${roots.length ? roots.join('\n                ') : '(无)'}`);

if (!roots.length) {
  console.log('\n没有可回填的根目录；用位置参数显式指定路径。');
  process.exit(0);
}
if (flags.has('--list')) process.exit(0);

const logger = { info: () => {}, warn: (...a) => console.log('[warn]', ...a) };

/**
 * 回填跑在库副本上：--dry-run 用（真实预演但不写生产库）。
 * 生产库 WAL 里有运行中 DSH 进程尚未 checkpoint 的写入，必须连 -wal/-shm 一起拷，
 * 否则副本会少掉最近的数据、预演数字偏小。
 */
function openStoreOnCopy() {
  const srcDir = path.join(DSH_HOME, 'storages', 'token-monitor');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-backfill-dry-'));
  fs.mkdirSync(path.join(tmpDir, 'storages', 'token-monitor'), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const from = path.join(srcDir, `token-monitor.db${suffix}`);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(tmpDir, 'storages', 'token-monitor', `token-monitor.db${suffix}`));
  }
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpDir;
  const copyStore = openUsageStore(logger);
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  return { store: copyStore, tmpDir };
}

const pricing = loadPricing(logger);

function statsOf(store) {
  return {
    rows: store.db.prepare('SELECT COUNT(*) n FROM usage_requests').get().n,
    max: store.db.prepare("SELECT datetime(MAX(created_at)/1000,'unixepoch','localtime') t FROM usage_requests").get().t,
    watermarks: store.db.prepare('SELECT COUNT(*) n FROM fold_watermarks').get().n,
  };
}

if (flags.has('--dry-run')) {
  console.log('\n--dry-run：在【库副本】上执行同一份折叠逻辑，生产库零写入。');
  const { store: copy, tmpDir } = openStoreOnCopy();
  copy.db.exec('PRAGMA busy_timeout = 15000');
  // 副本放在临时 DSH_HOME 下，主根指向真实的 $DSH_HOME/sessions（只读扫描，不写生产库）
  fs.symlinkSync(SESSIONS_ROOT, path.join(tmpDir, 'sessions'));
  const beforeCopy = statsOf(copy);
  console.log(`副本起点：明细 ${beforeCopy.rows} 行，最新一条 ${beforeCopy.max}，水位 ${beforeCopy.watermarks} 条`);
  const t0 = Date.now();
  const r = foldAllSessions(copy, pricing, tmpDir, logger, roots);
  const ms = Date.now() - t0;
  const afterCopy = statsOf(copy);
  console.log(`\n预演结果（${(ms / 1000).toFixed(1)}s）：扫描 ${r.filesScanned}｜将新增 ${r.imported}｜已存在跳过 ${r.skipped}｜错误 ${r.errors.length}`);
  for (const e of r.errors.slice(0, 20)) console.log(`  [error] ${e}`);
  console.log(`副本终点：明细 ${afterCopy.rows} 行（+${afterCopy.rows - beforeCopy.rows}），最新一条 ${afterCopy.max}，水位 ${afterCopy.watermarks} 条`);
  copy.close();
  console.log('\n（生产库未改动）');
  process.exit(0);
}

const store = openUsageStore(logger);
// 与运行中的 DSH 进程并发写同一库：忙等而不是立刻 SQLITE_BUSY 失败
store.db.exec('PRAGMA busy_timeout = 15000');

const before = statsOf(store);
console.log(`\n回填前：明细 ${before.rows} 行，最新一条 ${before.max}，水位 ${before.watermarks} 条`);

const t0 = Date.now();
let result;
try {
  result = foldAllSessions(store, pricing, DSH_HOME, logger, roots);
} catch (error) {
  console.error(`\n回填失败：${error.message}`);
  store.close();
  process.exit(1);
}
const ms = Date.now() - t0;

const after = statsOf(store);
console.log(`\n回填完成（${(ms / 1000).toFixed(1)}s）`);
console.log(`  扫描文件 ${result.filesScanned}｜新增 ${result.imported}｜跳过（主键已存在）${result.skipped}｜错误 ${result.errors.length}`);
for (const e of result.errors.slice(0, 20)) console.log(`  [error] ${e}`);
if (result.errors.length > 20) console.log(`  …另有 ${result.errors.length - 20} 条错误`);
console.log(`\n回填后：明细 ${after.rows} 行（+${after.rows - before.rows}），最新一条 ${after.max}，水位 ${after.watermarks} 条（+${after.watermarks - before.watermarks}）`);
console.log('\n提示：页面上点"刷新"即可看到；后台采集下一轮（≤5 分钟）也会自动带上。');
store.close();
