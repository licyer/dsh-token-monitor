import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FETCHERS } from '../lib/util/fetch-quotas.js';

const SECRET = 'fixture-access-secret';
const ACCOUNT = 'fixture-account-secret';
const fetchQuota = FETCHERS['chatgpt-codex'];
const window = (seconds, pct = 0, reset = 1793426261) => ({ limit_window_seconds: seconds, used_percent: pct, reset_at: reset });
const usage = () => ({ plan_type: 'plus', rate_limit: { primary_window: window(18000, 39), secondary_window: window(604800, 95) }, private: SECRET });
const jwt = (claims) => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

// All tests call the registered production fetcher and real fetchJson; only IO boundary fetch is mocked.
test('registered production Codex fetcher', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'token-monitor-codex-'));
  const authPath = join(directory, 'auth.json');
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.CODEX_AS_API_AUTH_PATH;
  let calls = [];
  let body = usage();
  let status = 200;
  const auth = async (tokens = { access_token: SECRET, account_id: ACCOUNT }) => writeFile(authPath, JSON.stringify({ tokens }));
  const run = async (config = { authPath }) => {
    const before = await readFile(authPath, 'utf8').catch(() => null);
    const result = await fetchQuota({}, config);
    assert.equal(await readFile(authPath, 'utf8').catch(() => null), before);
    const json = JSON.stringify(result);
    assert.ok(!json.includes(SECRET));
    assert.ok(!json.includes(ACCOUNT));
    assert.ok(!('raw' in result));
    return result;
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(body), { status });
  };
  try {
    await t.test('normal metrics, whitelist, exact endpoint, redirects forbidden', async () => {
      await auth();
      const result = await run();
      assert.equal(result.ok, true);
      assert.equal(result.headline, '5h 39% · 7d 95%');
      assert.equal(result.metrics[1].pct, 95);
      assert.equal(result.metrics[0].resetAt, 1793426261000);
      assert.ok(!('stats' in result));
      assert.match(result.metrics[0].detail, /本地时间 \d{4}-\d\d-\d\d \d\d:\d\d 重置/);
      assert.equal(calls.at(-1).url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(calls.at(-1).options.redirect, 'error');
      assert.equal(calls.at(-1).options.headers.authorization, `Bearer ${SECRET}`);
      assert.equal(calls.at(-1).options.headers['ChatGPT-Account-Id'], ACCOUNT);
    });
    await t.test('auth missing, malformed, invalid fields, no network', async () => {
      const before = calls.length;
      assert.equal((await run({ authPath: join(directory, 'missing') })).configured, false);
      assert.equal((await run({ authPath: '' })).configured, false);
      assert.equal((await run({ authPath: 42 })).configured, false);
      await writeFile(authPath, '{bad');
      assert.equal((await run()).ok, false);
      for (const tokens of [null, {}, { access_token: SECRET }, { access_token: SECRET, account_id: 'bad\nheader' }]) {
        await auth(tokens);
        assert.equal((await run()).ok, false);
      }
      assert.equal(calls.length, before);
    });
    await t.test('JWT account fallback and expiration, explicit and env paths', async () => {
      await auth({ access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT }, exp: 9999999999 }) });
      process.env.CODEX_AS_API_AUTH_PATH = authPath;
      assert.equal((await run({})).ok, true);
      assert.equal(calls.at(-1).options.headers['ChatGPT-Account-Id'], ACCOUNT);
      process.env.CODEX_AS_API_AUTH_PATH = join(directory, 'missing');
      assert.equal((await run()).ok, true);
      await auth({ access_token: jwt({ exp: 1 }), account_id: ACCOUNT });
      const before = calls.length;
      assert.match((await run()).error, /已过期/);
      assert.equal(calls.length, before);
    });
    await t.test('401/403 and error bodies cannot reflect secrets', async () => {
      await auth();
      for (const code of [401, 403, 400, 302]) {
        status = code;
        body = { token: SECRET, account: ACCOUNT };
        const result = await run();
        assert.equal(result.ok, false);
        if ([401, 403].includes(code)) assert.match(result.error, /重新登录/);
      }
      status = 200;
    });
    await t.test('actual seconds determine labels even when windows swapped; zeros retained', async () => {
      body = { rate_limit: { primary_window: window(604800, 0), secondary_window: window(18000, 0, 0) } };
      const result = await run();
      assert.equal(result.headline, '5h 0% · 7d 0%');
      assert.equal(result.metrics[0].resetAt, undefined);
      assert.equal(result.metrics[0].detail, '重置时间未提供');
    });
    await t.test('missing/invalid percent and unknown windows are not fabricated', async () => {
      for (const pct of [null, '', true, -1, 101, '25']) {
        body = { rate_limit: { primary_window: window(18000, pct), secondary_window: window(604800, 0) } };
        assert.equal((await run()).headline, '7d 0%');
      }
      for (const primary of [null, {}, window(60, 5)]) {
        body = { rate_limit: { primary_window: primary } };
        assert.equal((await run()).ok, false);
      }
      body = usage();
      body.rate_limit.secondary_window = null;
      assert.equal((await run()).headline, '5h 39%');
    });
    await t.test('HTTP 200 null/non-JSON and invalid reset dates are safe', async () => {
      body = null;
      assert.equal((await run()).ok, false);
      for (const reset of [null, '', 'invalid', -1, 0, 1e300]) {
        body = { rate_limit: { primary_window: window(18000, 39, reset) } };
        const result = await run();
        assert.equal(result.headline, '5h 39%');
        assert.equal(result.metrics[0].resetAt, undefined);
        assert.equal(result.metrics[0].detail, '重置时间未提供');
      }
      const mockFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('<html>not JSON</html>');
      try { assert.equal((await run()).ok, false); }
      finally { globalThis.fetch = mockFetch; }
    });
    await t.test('reject arbitrary endpoint before credential reads or network', async () => {
      const before = calls.length;
      assert.equal((await run({ authPath, url: 'https://attacker.invalid' })).ok, false);
      assert.equal((await run({ authPath, baseUrl: 'http://localhost' })).ok, false);
      assert.equal(calls.length, before);
    });
    await t.test('redirect/network exception has fixed safe output', async () => {
      globalThis.fetch = async () => { throw new Error(`redirect blocked ${SECRET} ${ACCOUNT}`); };
      assert.match((await run()).error, /不允许重定向/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.CODEX_AS_API_AUTH_PATH;
    else process.env.CODEX_AS_API_AUTH_PATH = originalEnv;
    // Verify the exact generated target before recursive cleanup.
    assert.equal(resolve(authPath), join(resolve(directory), 'auth.json'));
    await rm(directory, { recursive: true, force: true });
  }
});
