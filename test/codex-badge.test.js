import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { FETCHERS } from '../lib/util/fetch-quotas.js';

// Load actual production declarations, not a duplicated implementation.
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
function productionFunction(name, context = {}) {
  const start = client.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = client.indexOf('\n\t\t}', start);
  assert.ok(end > start);
  return runInNewContext(`(${client.slice(start, end + 5)})`, context);
}
const usedPctOf = productionFunction('usedPctOf');
const badgeState = productionFunction('badgeTextState', { BADGE_WEEKLY_ERR_PCT: 10, usedPctOf });
const quotaText = productionFunction('quotaText');
const shortHeadline = productionFunction('shortHeadline');
const allProviders = productionFunction('AllProviders', {
  h: (tag, props, ...children) => ({ tag, props, children }),
  S: { dot: () => ({}) },
  locServer: (value) => value,
});

// Feed real fetcher output into each production rendering/alert function.
test('Codex official used-percent survives every display and alert path, including past reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-monitor-badge-'));
  const authPath = join(directory, 'auth.json');
  const originalFetch = globalThis.fetch;
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'fixture-token', account_id: 'fixture-account' } }));
  try {
    for (const [five, week, expectedState] of [[39, 89, 'none'], [96, 30, 'err'], [39, 90, 'err'], [39, 95, 'err'], [39, 100, 'err']]) {
      for (const reset of [1, 9999999999]) {
        globalThis.fetch = async () => new Response(JSON.stringify({ rate_limit: {
          primary_window: { limit_window_seconds: 18000, used_percent: five, reset_at: reset },
          secondary_window: { limit_window_seconds: 604800, used_percent: week, reset_at: reset },
        } }));
        const provider = await FETCHERS['chatgpt-codex']({}, { authPath });
        const headline = `5h ${five}% · 7d ${week}%`;
        assert.equal(provider.headline, headline);
        assert.ok(!('stats' in provider));
        assert.equal(quotaText(provider, Date.now()), null);
        assert.equal(shortHeadline(provider.headline), `5h ${five}%`);
        assert.equal(badgeState(provider), expectedState);
        const rows = allProviders({ providers: [provider] });
        assert.equal(rows[0].children[2].children[0], headline);
        assert.equal(provider.metrics[0].value, `${five}%`);
        assert.equal(provider.metrics[1].value, `${week}%`);
        assert.equal(provider.metrics[1].resetAt, reset * 1000);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    assert.equal(resolve(authPath), join(resolve(directory), 'auth.json'));
    await rm(directory, { recursive: true, force: true });
  }
});
