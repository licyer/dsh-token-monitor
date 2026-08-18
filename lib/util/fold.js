/**
 * 日志折叠器：把 DSH 会话日志（多帧 zstd JSONL）折叠成 usage_requests 行。
 *
 * - zstd 分帧按帧头精确解析（魔数 + 帧头描述符 + 块遍历），不做魔数全文件扫描；
 *   尾部残缺帧（活跃写入中）整体跳过，等下轮水位推进再读。
 * - 增量：只折叠 seq > 水位的事件；写入 + rollup upsert + 水位推进同一事务。
 * - TTFT：step/start → 该 step 首个 assistant/chunk 的时间差；跨扫描边界的 step
 *   靠进程内缓存（重启后跨界的个别行 ttft_ms 为 NULL，可接受）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dayOf } from './store.js';

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

/**
 * 供应商名归一化：DSH 路由名 → 统一展示名（pi-ai 目录风格）。
 * 实测 DeepSeek 的 DSH 路由名为 deepseek-official，而 cc-switch 导入反查得
 * deepseek——同一供应商两套名字会让 rollup 分组/排行表出现两行，这里归一。
 * Kimi 两套恰好一致（kimi-coding），无需映射。
 */
const PROVIDER_NORM = {
  'deepseek-official': 'deepseek',
};

/** 归一化供应商名；无映射时原样返回。 */
export function normalizeProvider(provider) {
  return PROVIDER_NORM[provider] || provider;
}

/**
 * 按帧头精确切分 zstd 多帧文件。返回 Buffer 片段数组；尾部不完整帧被丢弃。
 * 帧结构：魔数(4) + 帧头(变长) + 数据块序列 + 可选校验和(4)。
 */
export function splitZstdFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const magic = buf.readUInt32LE(off);
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      // 可跳帧：魔数(4) + 尺寸(4) + 载荷
      if (off + 8 > buf.length) break;
      const size = buf.readUInt32LE(off + 4);
      if (off + 8 + size > buf.length) break;
      off += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) break; // 非帧数据：停止（尾部脏数据）

    let pos = off + 4;
    if (pos >= buf.length) break;
    const descriptor = buf.readUInt8(pos);
    pos += 1;
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksumFlag = (descriptor >> 2) & 1;
    const didFlag = descriptor & 3;

    if (!singleSegment) pos += 1; // Window_Descriptor
    pos += [0, 1, 2, 4][didFlag]; // Dictionary_ID
    // Frame_Content_Size 字段长度
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : (1 << fcsFlag); // 1→2, 2→4, 3→8
    pos += fcsBytes;
    if (pos > buf.length) break;

    // 遍历数据块直到 Last_Block
    let ok = true;
    for (;;) {
      if (pos + 3 > buf.length) { ok = false; break; }
      const header = buf.readUIntLE(pos, 3);
      pos += 3;
      const lastBlock = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      if (blockType === 3) { ok = false; break; } // 保留类型：损坏
      pos += blockType === 1 ? 1 : blockSize; // RLE 盘上只占 1 字节
      if (pos > buf.length) { ok = false; break; }
      if (lastBlock) break;
    }
    if (!ok) break;
    if (checksumFlag) {
      if (pos + 4 > buf.length) break;
      pos += 4;
    }
    frames.push(buf.subarray(off, pos));
    off = pos;
  }
  return frames;
}

/** 逐行解析一个会话日志文件，返回 { header, events }。尾部残缺帧在此被容忍。 */
export function readSessionLog(filePath) {
  const buf = fs.readFileSync(filePath);
  const frames = splitZstdFrames(buf);
  let header = null;
  const events = [];
  for (const frame of frames) {
    let text;
    try {
      text = zlib.zstdDecompressSync(frame).toString('utf8');
    } catch {
      break; // 无法解压的帧：视为尾部损坏，停止
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // 容忍不完整行
      }
      if (!row || typeof row !== 'object') continue;
      if (row.type === 'session' && row.id) {
        header = row; // 首行 header：字段在顶层，无 seq
        continue;
      }
      events.push(row);
    }
  }
  return { header, events };
}

/** 进程内跨扫描的 step 计时缓存：sessionId → Map<'turn:step', { start, firstChunk }>。 */
const stepTimingCache = new Map();

/**
 * 折叠一个会话日志文件。返回 { imported, skipped, sessionId, skippedUnchanged }。
 */
export function foldSessionFile(store, pricing, filePath, logger) {
  const stat = fs.statSync(filePath);
  const mtimeMs = Math.round(stat.mtimeMs);

  const { header, events } = readSessionLog(filePath);
  if (!header) return { imported: 0, skipped: 0, sessionId: null, skippedUnchanged: false, error: 'no-header' };
  const sessionId = header.id;

  const watermark = store.getWatermark(sessionId);
  if (watermark && mtimeMs <= watermark.file_mtime_ms) {
    return { imported: 0, skipped: 0, sessionId, skippedUnchanged: true };
  }
  const lastSeq = watermark ? watermark.last_seq : -1;

  let timing = stepTimingCache.get(sessionId);
  if (!timing) {
    timing = new Map();
    stepTimingCache.set(sessionId, timing);
  }

  let route = null; // { provider, model } —— 最近一个 request/context
  let title = watermark ? watermark.title : null;
  let maxSeq = lastSeq;
  const rows = [];

  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : (typeof event.seq0 === 'number' ? event.seq0 : null);
    if (seq !== null && seq > maxSeq) maxSeq = seq; // 打包行只取 seq0，保守低估无妨（见设计 §2.1）

    // 状态游标（路由/计时/标题）不按水位跳过——增量折叠时这些事件在水位之下，
    // 但新行的归属要靠它们；只有"产出行"的 assistant/message 受水位闸控。
    switch (event.type) {
      case 'request/context':
        if (event.data && event.data.provider) {
          route = { provider: normalizeProvider(event.data.provider), model: event.data.model || 'unknown' };
        }
        break;
      case 'step/start':
        if (event.data) timing.set(`${event.data.turn}:${event.data.step}`, { start: event.time, firstChunk: null });
        break;
      case 'assistant/chunk': {
        if (!event.data) break;
        const key = `${event.data.turn}:${event.data.step}`;
        const t = timing.get(key);
        if (t && t.firstChunk === null) t.firstChunk = event.time;
        break;
      }
      case 'session/title':
        if (event.data && typeof event.data.title === 'string' && event.data.title) title = event.data.title;
        break;
      case 'assistant/message': {
        if (seq === null || seq <= lastSeq) break; // 水位闸：已折叠的不重复产行
        const usage = event.data && event.data.usage;
        if (!usage) break;
        // 计费闸（CC 教训）：任一计费维度 > 0 即入库
        const input = usage.inputTokens || 0;
        const output = usage.outputTokens || 0;
        const cacheRead = usage.cacheReadTokens || 0;
        const cacheWrite = usage.cacheWriteTokens || 0;
        if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) break;

        const key = `${event.data.turn}:${event.data.step}`;
        const t = timing.get(key);
        const ttftMs = t && t.firstChunk !== null && t.start ? Math.max(0, t.firstChunk - t.start) : null;

        const provider = route ? route.provider : 'unknown';
        const model = route ? route.model : 'unknown';
        rows.push({
          recordId: `${sessionId}:${seq}`,
          source: 'dsh-logs',
          client: 'dsh',
          provider,
          model,
          sessionId,
          input,
          output,
          cacheRead,
          cacheWrite,
          costNano: pricing.costNano(provider, model, { input, output, cacheRead, cacheWrite }),
          ttftMs,
          day: dayOf(event.time),
          createdAt: event.time,
        });
        break;
      }
      default:
        break;
    }
  }

  let imported = 0;
  let skipped = 0;
  store.transaction(() => {
    for (const row of rows) {
      if (store.recordUsage(row)) imported += 1;
      else skipped += 1;
    }
    store.putWatermark({ sessionId, logPath: filePath, lastSeq: maxSeq, fileMtimeMs: mtimeMs, title });
  });

  return { imported, skipped, sessionId, skippedUnchanged: false };
}

/** 扫描全部会话日志并折叠。返回聚合结果。 */
export function foldAllSessions(store, pricing, dshHome, logger) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  const result = { imported: 0, skipped: 0, filesScanned: 0, errors: [] };
  if (!fs.existsSync(sessionsRoot)) return result;

  const seenSessionIds = new Set();
  for (const projectDir of fs.readdirSync(sessionsRoot)) {
    const projectPath = path.join(sessionsRoot, projectDir);
    let projectStat;
    try {
      projectStat = fs.statSync(projectPath);
    } catch { continue; }
    if (!projectStat.isDirectory()) continue;
    for (const sessionDir of fs.readdirSync(projectPath)) {
      const logPath = path.join(projectPath, sessionDir, 'session.jsonl.zstd');
      if (!fs.existsSync(logPath)) continue;
      result.filesScanned += 1;
      try {
        const r = foldSessionFile(store, pricing, logPath, logger);
        if (r.sessionId) seenSessionIds.add(r.sessionId);
        result.imported += r.imported;
        result.skipped += r.skipped;
      } catch (error) {
        result.errors.push(`${sessionDir}: ${error.message}`);
        logger?.warn?.(`token-monitor: 折叠 ${sessionDir} 失败：${error.message}`);
      }
    }
  }

  // 日志文件消失的会话：清掉水位行（已折叠数据保留）
  for (const row of store.db.prepare('SELECT session_id, log_path FROM fold_watermarks').all()) {
    if (!fs.existsSync(row.log_path)) store.removeWatermark(row.session_id);
  }

  return result;
}
