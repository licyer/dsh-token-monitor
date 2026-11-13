import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelName } from '../lib/util/model-name.js';

test('去掉 vendor 前缀后按显式别名归一', () => {
  // Command Code 转手的 V4.1 Flash 实为 deepseek-flash
  assert.equal(normalizeModelName('deepseek/deepseek-v4.1-flash'), 'deepseek-flash');
  assert.equal(normalizeModelName('deepseek-v4.1-flash'), 'deepseek-flash');
  // Kimi 官方 id 是 k3
  assert.equal(normalizeModelName('moonshotai/Kimi-K3'), 'k3');
  assert.equal(normalizeModelName('Kimi-K3'), 'k3');
  assert.equal(normalizeModelName('k3'), 'k3');
});

test('不合并名字相近但不同款的模型', () => {
  // deepseek-flash 与 deepseek-v4-flash 是两个不同模型
  assert.equal(normalizeModelName('deepseek-flash'), 'deepseek-flash');
  assert.equal(normalizeModelName('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.notEqual(normalizeModelName('deepseek-flash'), normalizeModelName('deepseek-v4-flash'));
  // kimi-for-coding 是官方独立模型，不能并进 k3
  assert.equal(normalizeModelName('kimi-for-coding'), 'kimi-for-coding');
  // k3-256k 是 256k 上下文档，保留独立
  assert.equal(normalizeModelName('k3-256k'), 'k3-256k');
});

test('只去最后一层前缀；无前缀/无别名的原样返回', () => {
  assert.equal(normalizeModelName('vendor/sub/model-x'), 'model-x');
  assert.equal(normalizeModelName('kimi-k2.7-code'), 'kimi-k2.7-code');
  assert.equal(normalizeModelName('unknown'), 'unknown');
  assert.equal(normalizeModelName(''), '');
  assert.equal(normalizeModelName(undefined), undefined);
  assert.equal(normalizeModelName(null), null);
});
