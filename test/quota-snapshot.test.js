import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, BILLING_TYPES, PERIODS, mapError, validate, assertValid,
} from '../lib/util/quota-snapshot.js';

/** 一份合法的 quota 型快照（各处测试的基线）。 */
const quotaSnapshot = () => ({
  providerId: 'glm-code-plan',
  billingType: 'quota',
  status: STATUS.OK,
  quota: {
    plan: 'Pro',
    timeWindows: [
      { period: '5h', usedPct: 12, resetAt: 1767000000000 },
      { period: '7d', usedPct: 31 },
    ],
    extraQuotas: [{ label: '额外额度（结转）', amount: 12.34, currency: 'CNY' }],
  },
});

/** 一份合法的 balance 型快照。 */
const balanceSnapshot = () => ({
  providerId: 'deepseek-account',
  billingType: 'balance',
  status: STATUS.OK,
  balance: {
    amount: 49.59,
    currency: 'CNY',
    accounts: [
      { label: '人民币账户', amount: 49.59, currency: 'CNY', recharged: 40, granted: 9.59, spent: 123.45 },
    ],
    alertThreshold: 2,
    spending: { thisMonth: 1.23, total: 45.6, currency: 'CNY' },
  },
});

test('合法的 quota 型快照通过校验', () => {
  const result = validate(quotaSnapshot());
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(assertValid(quotaSnapshot()).providerId, 'glm-code-plan');
});

test('合法的 balance 型快照通过校验', () => {
  const result = validate(balanceSnapshot());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('非成功状态不带数据也通过', () => {
  for (const status of Object.values(STATUS).filter((s) => s !== STATUS.OK)) {
    const result = validate({ providerId: 'x', billingType: 'quota', status });
    assert.deepEqual(result, { ok: true, errors: [] }, `status=${status} 应通过`);
  }
});

test('必填字段缺失被拒', () => {
  assert.equal(validate({ billingType: 'quota', status: 1 }).ok, false);
  assert.equal(validate({ providerId: 'x', status: 1 }).ok, false);
  assert.equal(validate({ providerId: 'x', billingType: 'quota' }).ok, false);
  assert.equal(validate(null).ok, false);
});

test('billingType 与 status 只接受枚举范围', () => {
  assert.equal(validate({ providerId: 'x', billingType: 'credits', status: 1 }).ok, false);
  assert.equal(validate({ providerId: 'x', billingType: 'quota', status: 0 }).ok, false);
  assert.equal(validate({ providerId: 'x', billingType: 'quota', status: 8 }).ok, false);
  assert.equal(validate({ providerId: 'x', billingType: 'quota', status: 1.5 }).ok, false);
});

test('period 必须是受控枚举', () => {
  const snap = quotaSnapshot();
  snap.quota.timeWindows[0].period = '3h';
  const { ok, errors } = validate(snap);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('period')));
  assert.deepEqual(PERIODS, ['5h', '7d', '30d', 'month']);
});

test('usedPct 越界被拒', () => {
  for (const bad of [-1, 101, Number.NaN, '12', null]) {
    const snap = quotaSnapshot();
    snap.quota.timeWindows[0].usedPct = bad;
    assert.equal(validate(snap).ok, false, `usedPct=${String(bad)} 应被拒`);
  }
});

test('timeWindows 不能为空', () => {
  const snap = quotaSnapshot();
  snap.quota.timeWindows = [];
  assert.equal(validate(snap).ok, false);
  snap.quota.timeWindows = undefined;
  assert.equal(validate(snap).ok, false);
});

test('可选数值字段类型错误被拒', () => {
  const snap = quotaSnapshot();
  snap.quota.timeWindows[0].resetAt = '2026-11-03';
  assert.equal(validate(snap).ok, false);
});

test('timeWindows[].scope 只接受受控枚举', () => {
  const snap = quotaSnapshot();
  snap.quota.timeWindows.push({ period: 'month', usedPct: 0, scope: 'code' });
  assert.equal(validate(snap).ok, true, 'code 合法');
  snap.quota.timeWindows[1].scope = 'total';
  assert.equal(validate(snap).ok, true, 'total 合法');
  snap.quota.timeWindows[1].scope = 'programming';
  const r = validate(snap);
  assert.equal(r.ok, false, '未知名被拒');
  assert.ok(r.errors.some((e) => e.includes('scope')), r.errors.join('; '));
});

test('extraQuotas[].progress 可选，存在时校验 used/limit', () => {
  const snap = quotaSnapshot();
  // 合法
  snap.quota.extraQuotas = [{ label: '加油包', amount: 0, currency: 'CNY', progress: { used: 12, limit: 30, currency: 'CNY' } }];
  assert.equal(validate(snap).ok, true);
  // limit=null 表示"无上限"，合法
  snap.quota.extraQuotas[0].progress = { used: 5, limit: null, currency: 'CNY' };
  assert.equal(validate(snap).ok, true, 'limit=null 应允许（无上限）');
  // limit 必须为正或 null
  snap.quota.extraQuotas[0].progress.limit = 0;
  assert.equal(validate(snap).ok, false);
  // used 必须是数字
  snap.quota.extraQuotas[0].progress = { used: '12', limit: 30 };
  assert.equal(validate(snap).ok, false);
  // progress 必须是对象
  snap.quota.extraQuotas[0].progress = 30;
  assert.equal(validate(snap).ok, false);
});

test('status=OK 但缺数据被拒', () => {
  assert.equal(validate({ providerId: 'x', billingType: 'quota', status: STATUS.OK }).ok, false);
  assert.equal(validate({ providerId: 'x', billingType: 'balance', status: STATUS.OK }).ok, false);
});

test('非成功状态携带数据被拒', () => {
  const snap = quotaSnapshot();
  snap.status = STATUS.NO_CREDENTIAL;
  assert.equal(validate(snap).ok, false);

  const bal = balanceSnapshot();
  bal.status = STATUS.REQUEST_FAILED;
  assert.equal(validate(bal).ok, false);
});

test('quota 与 balance 不能同时存在，且必须与 billingType 一致', () => {
  const snap = quotaSnapshot();
  snap.balance = { amount: 1, currency: 'CNY' };
  assert.equal(validate(snap).ok, false);

  const wrong = balanceSnapshot();
  wrong.billingType = 'quota';
  assert.equal(validate(wrong).ok, false);
});

test('message 只允许字符串或空', () => {
  const withMessage = { providerId: 'x', billingType: 'quota', status: STATUS.UNAUTHORIZED, message: 'API 密钥无效' };
  assert.equal(validate(withMessage).ok, true);

  const badMessage = { providerId: 'x', billingType: 'quota', status: STATUS.UNAUTHORIZED, message: { a: 1 } };
  assert.equal(validate(badMessage).ok, false);
});

test('mapError 把错误类型翻译成状态码', () => {
  assert.equal(mapError('no-credential'), STATUS.NO_CREDENTIAL);
  assert.equal(mapError('unsupported'), STATUS.UNSUPPORTED);
  assert.equal(mapError('unauthorized'), STATUS.UNAUTHORIZED);
  assert.equal(mapError('network'), STATUS.REQUEST_FAILED);
  assert.equal(mapError('timeout'), STATUS.REQUEST_FAILED);
  assert.equal(mapError('http'), STATUS.REQUEST_FAILED);
  assert.equal(mapError('unrecognized'), STATUS.NO_DATA);
  assert.equal(mapError('no-plan'), STATUS.NO_PLAN);
  // 未知类型按请求失败处理，不能静默当成成功
  assert.equal(mapError('something-else'), STATUS.REQUEST_FAILED);
  assert.equal(mapError(undefined), STATUS.REQUEST_FAILED);
});

test('状态码取值固定（契约不可漂移）', () => {
  assert.deepEqual(STATUS, {
    OK: 1, NO_CREDENTIAL: 2, UNSUPPORTED: 3, UNAUTHORIZED: 4,
    REQUEST_FAILED: 5, NO_DATA: 6, NO_PLAN: 7,
  });
  assert.deepEqual(BILLING_TYPES, ['quota', 'balance']);
  assert.ok(Object.isFrozen(STATUS));
});

test('assertValid 失败时抛出带原因的错误', () => {
  assert.throws(
    () => assertValid({ providerId: '', billingType: 'quota', status: 1 }),
    /不符合契约/,
  );
});

test('links 可选：合法 http(s) 地址通过，非法协议/类型被拒', () => {
  const ok = balanceSnapshot();
  ok.links = {
    topUpUrl: 'https://platform.deepseek.com/top_up',
    usageUrl: 'https://platform.deepseek.com/usage',
  };
  assert.equal(validate(ok).ok, true);

  // 只给一个链接也合法
  const partial = balanceSnapshot();
  partial.links = { topUpUrl: 'https://platform.deepseek.com/top_up' };
  assert.equal(validate(partial).ok, true);

  // links 为 null 视同未提供
  const nullLinks = balanceSnapshot();
  nullLinks.links = null;
  assert.equal(validate(nullLinks).ok, true);

  // 非 http(s) 协议被拒（防止 javascript: 之类的注入）
  const badProtocol = balanceSnapshot();
  badProtocol.links = { topUpUrl: 'javascript:alert(1)' };
  const r1 = validate(badProtocol);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('links.topUpUrl')), r1.errors.join('；'));

  // links 必须是对象
  const badType = balanceSnapshot();
  badType.links = 'https://example.com';
  assert.equal(validate(badType).ok, false);
});

