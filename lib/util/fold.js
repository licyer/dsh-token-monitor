/**
 * 日志折叠器：把 DSH 会话日志（多帧 zstd JSONL）折叠成 usage_requests 行。
 *
 * 设计要点（完整说明见 docs/FOLD-DESIGN.md）：
 *
 * - **日志版本识别**：一个会话目录里可能长期并存多版本日志（旧版本不删），命名遵循 DSH 的
 *   canonical 契约 `session.jsonl[.zstd]`（v0）/ `session.vN.jsonl[.zstd]`（N≥1）。
 *   取**版本号最大**者作为唯一数据源——与官方 resolveGenerationInDirectory 同规则，
 *   代码里不写死任何版本号，将来 v4/v5 自动跟随。
 * - **位置与身份解耦**：水位（log_path/offset/seq）只决定"从哪继续读"；
 *   "要不要入库"由 ① 内容键 `sessionId:time:turn.step`（主键 + INSERT OR IGNORE）
 *   ② 全读闸 `该会话库内 MAX(created_at)` 决定。因此换文件（日志版本升级会把整段历史
 *   重写进新文件）、水位丢失、日志被重写，都不会重复计数——最坏只是重读一遍。
 * - **帧不可切分**：读取按"至少凑满一帧"自适应放宽窗口；每轮有软上限，没读到文件尾
 *   就标 `pending`，下轮无视 mtime 继续，避免尾部永远读不到；单帧超硬上限则上报。
 * - **失效可见**：读不出 header、目录里有疑似日志但名字不认识、有事件却产不出用量行，
 *   全部进健康统计供数据来源卡告警——禁止静默返回 0（这正是一次真实故障的根因）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dayOf } from './store.js';

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

/** 会话日志 canonical 文件名（与 DSH parseSessionFormatLogFilename 同规则）：v0 无版本段。 */
const GENERATION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/;
/** 疑似会话日志（用于"有文件但名字不认识"的健康告警；官方若改命名可由此发现）。 */
const LOG_LIKE_RE = /session.*\.jsonl/i;
/** 官方迁移/写入的临时文件（`session.migration.<token>.jsonl.zstd.tmp`）：不算异常。 */
const TEMP_LOG_RE = /\.tmp$/i;

/** header 读取窗口：4KB 起，切不出完整首帧就放大（实测首帧 ~160B）。 */
const HEADER_WINDOW_MIN = 4096;
const HEADER_WINDOW_MAX = 4 * 1024 * 1024;
/** 帧读取窗口：512KB 起；单帧硬上限（超过视为无法解析并上报）。 */
const FRAME_WINDOW_MIN = 512 * 1024;
const FRAME_WINDOW_MAX = 64 * 1024 * 1024;
/** 每轮每文件的软上限（字节）：避免在宿主事件循环上做超长同步解压。 */
const READ_ROUND_BYTES = 16 * 1024 * 1024;

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
 * 按帧头精确切分 zstd 多帧文件。返回 Buffer 片段数组；**只返回完整帧**，
 * 尾部不完整帧被丢弃（调用方据此决定"要不要再读多一点"）。
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

/* ------------------------------ 日志版本识别 ------------------------------ */

/**
 * 解析日志文件名的版本号。
 * @returns 版本号（v0 = 0）；名字不是 canonical 时返回 null。
 */
export function parseGeneration(filename) {
  const m = GENERATION_LOG_RE.exec(filename);
  if (!m) return null;
  return m[1] === undefined ? 0 : Number(m[1]);
}

/**
 * 在会话目录里选出权威日志：**版本号最大**的 canonical 文件（官方同规则）。
 * 低版本文件是历史快照（迁移会整段重写进新版本，且旧版本不删），只读最高版本即可拿到全量。
 * @returns { path, generation, name } 或 null（目录里没有 canonical 日志）
 */
export function chooseGenerationLog(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const generation = parseGeneration(name);
    if (generation === null) continue;
    if (!best || generation > best.generation) {
      best = { path: path.join(dir, name), generation, name };
    }
  }
  return best;
}

/**
 * 目录里"像会话日志但不是 canonical 名"的文件。
 * 用途：官方改了命名规则（或用户手工改名/留了备份）时，新数据会静默读不到——
 * 这条告警让它在页面上可见。官方写入中的临时文件（.tmp）按预期存在，不算异常。
 */
function listNonCanonicalLogs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => LOG_LIKE_RE.test(n) && !TEMP_LOG_RE.test(n) && parseGeneration(n) === null);
}

/* ------------------------------ 读取层 ------------------------------ */

/** 从 offset 起最多读 want 字节（短读重试）；返回缓冲区与实际读到的字节数。 */
function readWindow(fd, offset, want) {
  const buf = Buffer.allocUnsafe(want);
  let got = 0;
  while (got < want) {
    const n = fs.readSync(fd, buf, got, want - got, offset + got);
    if (n <= 0) break; // 文件被截断：按已读到的部分处理
    got += n;
  }
  return { buf, got };
}

/**
 * 读 header（只取首帧第一行）。
 * 自适应窗口：切不出完整首帧就放大窗口，直到成功、到文件尾、或到硬上限。
 * 不用固定窗口——固定窗口遇到"首帧被撑大"会静默返回 null，等于整个会话消失。
 * @returns { header, error } —— header 为 null 时 error 说明原因（供健康告警）
 */
function readHeader(fd, fileSize) {
  let want = Math.min(HEADER_WINDOW_MIN, fileSize);
  for (;;) {
    const { buf, got } = readWindow(fd, 0, want);
    const frames = splitZstdFrames(buf.subarray(0, got));
    if (frames.length > 0) {
      try {
        const first = zlib.zstdDecompressSync(frames[0]).toString('utf8').split('\n')[0];
        const row = JSON.parse(first);
        if (row && row.type === 'session' && row.id) return { header: row, error: null };
        return { header: null, error: '首帧第一行不是会话 header' };
      } catch (error) {
        return { header: null, error: `首帧解压/解析失败：${error.message}` };
      }
    }
    if (got >= fileSize) return { header: null, error: '整份文件切不出完整帧' };
    if (want >= fileSize || want >= HEADER_WINDOW_MAX) return { header: null, error: '首帧超过读取上限' };
    want = Math.min(fileSize, want * 4);
  }
}

/**
 * 从 startOffset 起读一批完整帧；**至少凑满一帧**（不足则放大窗口），
 * 直到软上限或文件尾。帧不可切分：如果为了凑一帧必须超出软上限，就超出。
 * @returns { frames, nextOffset, atEnd, oversize }
 *   atEnd    = 已读到文件当时的大小（尾部残缺帧留给下轮，等它写完整）
 *   oversize = 单帧超过硬上限，无法解析（不推进水位，由健康告警暴露）
 */
function readFrameBatch(fd, fileSize, startOffset, softCapBytes) {
  const remaining = fileSize - startOffset;
  if (remaining <= 0) return { frames: [], nextOffset: startOffset, atEnd: true, oversize: false };
  let want = Math.max(FRAME_WINDOW_MIN, Math.min(softCapBytes, remaining));
  for (;;) {
    const { buf, got } = readWindow(fd, startOffset, want);
    const frames = splitZstdFrames(buf.subarray(0, got));
    if (frames.length > 0) {
      let consumed = 0;
      for (const frame of frames) consumed += frame.length;
      return { frames, nextOffset: startOffset + consumed, atEnd: startOffset + got >= fileSize, oversize: false };
    }
    if (startOffset + got >= fileSize) {
      // 文件尾只剩残缺帧：不推进水位、不报错，等下一轮（文件写完）再读
      return { frames: [], nextOffset: startOffset, atEnd: true, oversize: false };
    }
    if (want >= remaining || want >= FRAME_WINDOW_MAX) {
      return { frames: [], nextOffset: startOffset, atEnd: false, oversize: true };
    }
    want = Math.min(remaining, want * 2);
  }
}

/* ------------------------------ 折叠 ------------------------------ */

/** 进程内跨扫描的 step 计时缓存：sessionId → Map<'turn:step', { start, firstChunk }>。 */
const stepTimingCache = new Map();

/**
 * 事件身份（内容键）：跨版本稳定、与 seq/文件无关。
 * 实测迁移逐条保真（时间、turn/step、provider/model、四个 token 桶全同），
 * 因此"新文件里迁移过来的历史"与"库里已折叠的行"算出同一个键 → INSERT OR IGNORE 天然去重。
 * 刻意**不把 usage 数值写进键**：万一将来某次迁移修正了数值，宁可保留已入库的旧值，
 * 也不要因为数值变化而多插一条（重复计数比数值陈旧危险得多）。
 * 极端情况（无 turn/step 的异常行）退化为 time + seq，仍保证同一文件内唯一。
 */
function contentRecordId(sessionId, event, seq) {
  const data = event.data || {};
  if (typeof data.turn === 'number' && typeof data.step === 'number') {
    return `${sessionId}:${event.time}:${data.turn}.${data.step}`;
  }
  return `${sessionId}:${event.time}:s${seq === null ? 'x' : seq}`;
}

/** 该条消息首个流式块的时间（v3 把 chunk 流并入 assistant/message.data.stream）。 */
function firstStreamTime(data) {
  const stream = data && data.stream;
  if (!Array.isArray(stream) || !stream.length) return null;
  const t = stream[0] && stream[0].time;
  return typeof t === 'number' ? t : null;
}

/** 折叠结果的空壳（错误/跳过路径共用，保证字段形状一致）。 */
function emptyResult(generation, extra) {
  return Object.assign({
    imported: 0, skipped: 0, sessionId: null, generation, skippedUnchanged: false,
    events: 0, messageEvents: 0, gatedMessages: 0, noUsageMessages: 0, zeroUsageMessages: 0,
    usageRows: 0, pending: false, error: null, unreadable: null,
  }, extra);
}

/**
 * 折叠一个会话日志文件。
 * @returns { imported, skipped, sessionId, generation, skippedUnchanged, events,
 *            messageEvents, gatedMessages, noUsageMessages, zeroUsageMessages,
 *            usageRows, pending, error, unreadable }
 */
export function foldSessionFile(store, pricing, filePath, generation, logger) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return emptyResult(generation, { error: `stat: ${error.message}` });
  }
  const fileSize = stat.size;
  const mtimeMs = Math.round(stat.mtimeMs);

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    return emptyResult(generation, { error: `open: ${error.message}` });
  }

  try {
    const { header, error: headerError } = readHeader(fd, fileSize);
    if (!header) return emptyResult(generation, { error: headerError || 'no-header' });
    const sessionId = header.id;

    const wm = store.getWatermark(sessionId);
    const sameFile = !!(wm && wm.log_path === filePath);

    // mtime 短路：只在"上次已读到文件末尾"（pending=0）且文件没变时才允许跳过。
    // pending=1 表示上一轮因分批上限中途停下 → 必须继续，否则尾部永远读不到。
    if (sameFile && !wm.pending && mtimeMs <= wm.file_mtime_ms) {
      return emptyResult(generation, { sessionId, skippedUnchanged: true });
    }

    // 起点：同一文件续读用存下来的字节偏移；换文件（日志版本升级）或首次读则从头。
    // 自愈：偏移超出文件长度（文件被重写/截断）→ 回退从头整读。
    let startOffset = sameFile ? (wm.last_offset || 0) : 0;
    if (startOffset > fileSize) startOffset = 0;

    // 全读闸：从头整读时，用明细表里该会话已有的最大事件时间挡住"迁移过来的历史"。
    // 取自 usage_requests（而不是水位表）——水位丢了也照样挡得住，重复计数不可能发生。
    let gate = startOffset === 0 ? store.maxCreatedAt(sessionId) : null;
    // 同文件内的 seq 闸：仅当"续读"时有意义（从头整读时 seq 基准必然从 -1 起）
    let seqGate = sameFile && startOffset > 0 && typeof wm.last_seq === 'number' ? wm.last_seq : -1;

    let batch = readFrameBatch(fd, fileSize, startOffset, READ_ROUND_BYTES);
    // 自愈：偏移落在帧中间（文件被原地重写/截断）时，从该处切不出任何帧。
    // 回退到 0 重读一遍（带上全读闸，不会重复入库）。
    if (batch.oversize && startOffset > 0) {
      logger?.warn?.(`token-monitor: 会话 ${sessionId} 的水位偏移 ${startOffset} 处无有效帧，回退整读`);
      startOffset = 0;
      gate = store.maxCreatedAt(sessionId);
      seqGate = -1;
      batch = readFrameBatch(fd, fileSize, startOffset, READ_ROUND_BYTES);
    }

    let timing = stepTimingCache.get(sessionId);
    if (!timing) {
      timing = new Map();
      stepTimingCache.set(sessionId, timing);
    }

    let title = sameFile ? wm.title : null;
    let maxSeq = Math.max(seqGate, -1);
    let consumed = 0;
    let events = 0;
    let messageEvents = 0;     // assistant/message 条数（不管有没有 usage、有没有被闸挡）
    let gatedMessages = 0;     // 其中"通过了闸、本应成为新行"的条数（格式是否还认识的锚点）
    let noUsageMessages = 0;   // 通过闸但没有 usage 对象的条数（schema 变了会集中体现在这里）
    let zeroUsageMessages = 0; // 通过闸但四个 token 桶全 0 的条数
    let unreadable = null;
    const rows = [];

    // 路由游标：增量续读跳过了水位前的 request/context，
    // 改从数据库里该会话最近一条记录恢复（provider/model 一致口径）
    let route = null;
    if (startOffset > 0) {
      const last = store.db.prepare(
        'SELECT provider, model FROM usage_requests WHERE session_id = ? ORDER BY created_at DESC, record_id DESC LIMIT 1',
      ).get(sessionId);
      if (last) route = { provider: last.provider, model: last.model };
    }

    for (const frame of batch.frames) {
      let text;
      try {
        text = zlib.zstdDecompressSync(frame).toString('utf8');
      } catch (error) {
        // 损坏帧：不把水位推进到它之后（下轮重试），并上报；mtime 短路保证不会每轮重复解压
        unreadable = `帧解压失败 @${startOffset + consumed}：${error.message}`;
        break;
      }
      consumed += frame.length;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // 容忍不完整行
        }
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'session' && event.id) continue; // header 行（仅出现在首帧）
        events += 1;

        const seq = typeof event.seq === 'number' ? event.seq : (typeof event.seq0 === 'number' ? event.seq0 : null);
        if (seq !== null && seq > maxSeq) maxSeq = seq; // 打包行只取 seq0，保守低估无妨

        // 状态游标：只有"产出行"的 assistant/message 受两道闸控
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
            // 只出现在 v0（v3 起 chunk 流并入 assistant/message.data.stream）
            if (!event.data) break;
            const t = timing.get(`${event.data.turn}:${event.data.step}`);
            if (t && t.firstChunk === null) t.firstChunk = event.time;
            break;
          }
          case 'session/title':
            if (event.data && typeof event.data.title === 'string' && event.data.title) title = event.data.title;
            break;
          case 'assistant/message': {
            messageEvents += 1;
            // 先过两道闸，只把"本应成为新行"的消息计入健康统计——
            // 否则"整段被全读闸挡住"（换版本/水位丢失后重读）会被误报成"格式变了"。
            if (seq !== null && seqGate >= 0 && seq <= seqGate) break;
            if (gate !== null && !(event.time > gate)) break;
            gatedMessages += 1;
            const usage = event.data && event.data.usage;
            if (!usage) { noUsageMessages += 1; break; }
            // 计费闸（CC 教训）：任一计费维度 > 0 即入库
            const input = usage.inputTokens || 0;
            const output = usage.outputTokens || 0;
            const cacheRead = usage.cacheReadTokens || 0;
            const cacheWrite = usage.cacheWriteTokens || 0;
            if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) { zeroUsageMessages += 1; break; }

            // 消息自带 source（该条消息真实使用的 provider/model）——优先用它；
            // request/context 是低频事件（仅模型切换时写），route 游标在增量窗口内
            // 会退化为"数据库最后一条"而失真（曾把官方 deepseek 消息误记成 opencode-go）。
            const src = event.data && event.data.message && event.data.message.source;
            const provider = src && src.provider
              ? normalizeProvider(src.provider)
              : (route ? route.provider : 'unknown');
            const model = src && src.model ? src.model : (route ? route.model : 'unknown');

            // TTFT：v3 用消息内嵌流首个块的 time；v0 用 step/start → 首个 assistant/chunk
            const key = `${event.data.turn}:${event.data.step}`;
            const t = timing.get(key);
            let ttftMs = null;
            if (t && t.start) {
              const head = firstStreamTime(event.data);
              if (head !== null) ttftMs = Math.max(0, head - t.start);
              else if (t.firstChunk !== null && t.firstChunk !== undefined) ttftMs = Math.max(0, t.firstChunk - t.start);
            }

            rows.push({
              recordId: contentRecordId(sessionId, event, seq),
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
    }

    const nextOffset = startOffset + consumed;
    // pending：本轮因软上限中途停下（还有可解压的数据没读完）→ 下轮无视 mtime 继续。
    // 解码失败或单帧超限不算 pending（否则会每轮重复失败），由健康告警暴露。
    const pending = !batch.atEnd && !unreadable && !batch.oversize && nextOffset > startOffset;

    let imported = 0;
    let skipped = 0;
    store.transaction(() => {
      for (const row of rows) {
        if (store.recordUsage(row)) imported += 1;
        else skipped += 1;
      }
      store.putWatermark({
        sessionId,
        logPath: filePath,
        lastSeq: maxSeq,
        fileMtimeMs: mtimeMs,
        title,
        lastOffset: nextOffset,
        pending,
      });
    });

    if (batch.oversize) {
      unreadable = `单帧超过上限（>${Math.round(FRAME_WINDOW_MAX / 1048576)}MB）@${startOffset}`;
      logger?.warn?.(`token-monitor: 折叠 ${path.basename(filePath)} 遇到超大帧，已跳过并上报`);
    }

    return {
      imported, skipped, sessionId, generation, skippedUnchanged: false,
      events, messageEvents, gatedMessages, noUsageMessages, zeroUsageMessages,
      usageRows: rows.length, pending, error: null, unreadable,
    };
  } finally {
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

/* ------------------------------ 全量扫描 ------------------------------ */

/**
 * 扫描全部会话日志并折叠。返回 { imported, skipped, filesScanned, errors, health }。
 * health 是"失效可见"的载体：任何"文件在但读不出来/认不出/产不出行"都在这里暴露，
 * 由 /token-monitor/usage/sources 下发给数据来源卡告警，而不是静默显示 0。
 */
export function foldAllSessions(store, pricing, dshHome, logger) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  const result = {
    imported: 0,
    skipped: 0,
    filesScanned: 0,
    errors: [],
    health: {
      sessionsScanned: 0,   // 扫到的会话目录数
      withHeader: 0,        // 能读出 header 的会话数
      withUsage: 0,         // 产出了用量行的会话数
      generationCounts: {}, // 选中的版本分布（如 { '0': 7, '3': 3 }）
      pendingFiles: 0,      // 本轮没读完、下轮续读的文件数
      noHeader: [],         // 读不出 header（含原因）
      unreadable: [],       // 帧解压失败 / 单帧超限
      unrecognizedLogs: [], // 目录里有疑似日志但不是 canonical 名（官方改命名时靠它发现）
      emptyUsage: [],       // 有事件但产不出用量行（行 schema 可能变了）
    },
  };
  if (!fs.existsSync(sessionsRoot)) return result;

  for (const projectDir of fs.readdirSync(sessionsRoot)) {
    const projectPath = path.join(sessionsRoot, projectDir);
    let projectStat;
    try {
      projectStat = fs.statSync(projectPath);
    } catch { continue; }
    if (!projectStat.isDirectory()) continue;
    for (const sessionDir of fs.readdirSync(projectPath)) {
      const dirPath = path.join(projectPath, sessionDir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch { continue; }

      result.health.sessionsScanned += 1;
      const picked = chooseGenerationLog(dirPath);
      if (!picked) {
        const names = listNonCanonicalLogs(dirPath);
        if (names.length) result.health.unrecognizedLogs.push({ session: sessionDir, names });
        continue;
      }
      result.filesScanned += 1;
      result.health.generationCounts[picked.generation] = (result.health.generationCounts[picked.generation] || 0) + 1;

      try {
        const r = foldSessionFile(store, pricing, picked.path, picked.generation, logger);
        result.imported += r.imported;
        result.skipped += r.skipped;
        if (r.sessionId) result.health.withHeader += 1;
        if (r.pending) result.health.pendingFiles += 1;
        if (r.unreadable) result.health.unreadable.push({ session: r.sessionId || sessionDir, file: picked.name, reason: r.unreadable });
        if (r.error) {
          result.health.noHeader.push({ session: r.sessionId || sessionDir, file: picked.name, reason: r.error });
          result.errors.push(`${sessionDir}: ${r.error}`);
          logger?.warn?.(`token-monitor: 折叠 ${picked.name} 失败：${r.error}`);
        } else if (r.usageRows > 0) {
          result.health.withUsage += 1;
        } else if (!r.skippedUnchanged && r.gatedMessages > 0) {
          // 有"通过了闸、本应成为新行"的消息却一条都没入库：最可能是行 schema 变了
          // （静默 0 的第二种形态）。整段被闸挡住（换版本/水位丢失重读）时 gatedMessages=0，
          // 不会误报；只有几个 permission/sandbox 事件的空会话同样不会误报。
          result.health.emptyUsage.push({
            session: r.sessionId, generation: picked.generation,
            messages: r.messageEvents, gated: r.gatedMessages,
            noUsage: r.noUsageMessages, zeroUsage: r.zeroUsageMessages,
          });
          logger?.warn?.(
            `token-monitor: 会话 ${r.sessionId} 有 ${r.gatedMessages} 条新 assistant/message`
            + `（无 usage 字段 ${r.noUsageMessages} 条 / 全 0 ${r.zeroUsageMessages} 条）却 0 条用量行`
            + '——日志记录格式可能已变化',
          );
        }
      } catch (error) {
        result.errors.push(`${sessionDir}: ${error.message}`);
        logger?.warn?.(`token-monitor: 折叠 ${sessionDir} 失败：${error.message}`);
      }
    }
  }

  // 日志文件已消失的会话：清掉水位行（已折叠数据保留）
  for (const row of store.db.prepare('SELECT session_id, log_path FROM fold_watermarks').all()) {
    if (!fs.existsSync(row.log_path)) store.removeWatermark(row.session_id);
  }

  return result;
}
