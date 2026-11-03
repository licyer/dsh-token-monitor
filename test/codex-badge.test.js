import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FETCHERS } from '../lib/util/fetch-quotas.js';
import { STATUS, validate } from '../lib/util/quota-snapshot.js';

const winOf = (result, period) => (result.quota && result.quota.timeWindows || []).find((w) => w.period === period);

// 说明：v2 改造后本文件只校验「抓取结果的结构与事实」；
// 徽标判色/文案的断言待前端切到 v2（阶段 C）后恢复。
test('Codex official used-percent survives fetch and contract, including past reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-monitor-badge-'));
  const authPath = join(directory, 'auth.json');
  const originalFetch = globalThis.fetch;
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'fixture-token', account_id: 'fixture-account' } }));
  try {
    for (const [five, week] of [[39, 89], [96, 30], [39, 90], [39, 95], [39, 100]]) {
      for (const reset of [1, 9999999999]) {
        globalThis.fetch = async () => new Response(JSON.stringify({ rate_limit: {
          primary_window: { limit_window_seconds: 18000, used_percent: five, reset_at: reset },
          secondary_window: { limit_window_seconds: 604800, used_percent: week, reset_at: reset },
        } }));
        const provider = await FETCHERS['chatgpt-codex']({}, { authPath });
        assert.equal(validate(provider).ok, true, JSON.stringify(validate(provider).errors));
        assert.equal(provider.status, STATUS.OK);
        assert.equal(provider.providerId, 'chatgpt-codex');
        assert.equal(provider.billingType, 'quota');
        // 官方 used_percent 原样保留，不做 100-x 反转
        assert.equal(winOf(provider, '5h').usedPct, five);
        assert.equal(winOf(provider, '7d').usedPct, week);
        assert.equal(winOf(provider, '5h').resetAt, reset * 1000);
        assert.ok(!('stats' in provider));
        assert.ok(!('metrics' in provider));
        assert.ok(!('headline' in provider));
      }
    }
    // 过去的重置时刻保留原始值（不自行推算用量归零）
    globalThis.fetch = async () => new Response(JSON.stringify({ rate_limit: {
      primary_window: { limit_window_seconds: 18000, used_percent: 39, reset_at: 1 },
    } }));
    const past = await FETCHERS['chatgpt-codex']({}, { authPath });
    assert.equal(winOf(past, '5h').resetAt, 1000);
  } finally {
    globalThis.fetch = originalFetch;
    assert.equal(resolve(authPath), join(resolve(directory), 'auth.json'));
    await rm(directory, { recursive: true, force: true });
  }
});
