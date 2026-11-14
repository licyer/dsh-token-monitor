import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VENDORS, PROVIDERS, CLIENTS, MODELS,
  canonicalProvider, canonicalModel, vendorOfProvider, vendorOfModel, providerOfModel,
  labelOfProvider, labelOfVendor, labelOfModel, labelOfClient,
  colorOfVendor,
  priceKeyOf, resolveLabel, project,
} from '../lib/util/mapping-registry.js';

/* ------------------------------ 归一 ------------------------------ */

test('提供方归一：旧写法归并到规范 id', () => {
  assert.equal(canonicalProvider('deepseek-official'), 'deepseek');
  assert.equal(canonicalProvider('zai-coding-cn'), 'glm-code-plan');
  // 大小写 / 空白不敏感
  assert.equal(canonicalProvider('  DeepSeek '), 'deepseek');
  assert.equal(canonicalProvider('KIMI-CODING'), 'kimi-coding');
});

test('提供方归一：未知原样返回，不猜', () => {
  assert.equal(canonicalProvider('some-new-provider'), 'some-new-provider');
  assert.equal(canonicalProvider(''), 'unknown');
  assert.equal(canonicalProvider(null), 'unknown');
  assert.equal(canonicalProvider(undefined), 'unknown');
});

test('模型归一：别名与 vendor 前缀', () => {
  assert.equal(canonicalModel('moonshotai/Kimi-K3').id, 'k3');
  assert.equal(canonicalModel('Kimi-K3').id, 'k3');
  assert.equal(canonicalModel('deepseek/deepseek-v4.1-flash').id, 'deepseek-flash');
  assert.equal(canonicalModel('  DEEPSEEK-FLASH  ').id, 'deepseek-flash');
  // 前缀推导：未登记的写法去掉前缀后命中
  assert.equal(canonicalModel('openrouter/k3').id, 'k3');
});

test('模型归一：名字相近但不是同一款，绝不合并', () => {
  const flash = canonicalModel('deepseek-flash');
  const v4flash = canonicalModel('deepseek-v4-flash');
  assert.notEqual(flash.id, v4flash.id);

  assert.equal(canonicalModel('kimi-for-coding').id, 'kimi-for-coding');
  assert.notEqual(canonicalModel('kimi-for-coding').id, 'k3');

  assert.equal(canonicalModel('k3-256k').id, 'k3-256k');
  assert.notEqual(canonicalModel('k3-256k').id, 'k3');

  assert.equal(canonicalModel('k3.1-pro').id, 'k3.1-pro');
  assert.notEqual(canonicalModel('k3.1-pro').id, 'k3');
});

test('模型归一：未登记返回原名 + known=false，但仍推断厂商', () => {
  const c = canonicalModel('qwen3.8-max');
  assert.equal(c.known, false);
  assert.equal(c.id, 'qwen3.8-max');
  assert.equal(c.display, 'qwen3.8-max');
  assert.equal(c.vendor, 'qwen');

  const weird = canonicalModel('foo/bar-model-9000');
  assert.equal(weird.known, false);
  assert.equal(weird.id, 'foo/bar-model-9000');
  assert.equal(weird.vendor, undefined);
});

test('模型归一：空值安全', () => {
  for (const v of ['', null, undefined, '   ']) {
    const c = canonicalModel(v);
    assert.equal(c.known, false);
    assert.equal(c.id, 'unknown');
  }
});

/* ------------------------------ 归属 ------------------------------ */

test('provider → vendor', () => {
  assert.equal(vendorOfProvider('deepseek-account'), 'deepseek');
  assert.equal(vendorOfProvider('deepseek-official'), 'deepseek');
  assert.equal(vendorOfProvider('moonshotai-cn'), 'kimi');
  assert.equal(vendorOfProvider('zai-coding-cn'), 'zhipu');
  assert.equal(vendorOfProvider('chatgpt-codex'), 'openai');
  // 未登记的提供方：把自身当厂商（红线：不并入 unknown、不改名）
  assert.equal(vendorOfProvider('不存在的'), '不存在的');
  assert.equal(vendorOfProvider(''), 'unknown');
});

test('model → vendor（表内优先，其次前缀推断）', () => {
  assert.equal(vendorOfModel('k3'), 'kimi');
  assert.equal(vendorOfModel('moonshotai/Kimi-K3'), 'kimi');
  assert.equal(vendorOfModel('deepseek-flash'), 'deepseek');
  assert.equal(vendorOfModel('glm-5.3'), 'zhipu');
  assert.equal(vendorOfModel('claude-haiku-5-5'), 'anthropic');
  assert.equal(vendorOfModel('mimo-v2.6-pro'), 'xiaomi');
  assert.equal(vendorOfModel('完全陌生的名字'), 'unknown');
});

test('model → provider（默认归属，用于补缺）', () => {
  assert.equal(providerOfModel('k3'), 'kimi-coding');
  assert.equal(providerOfModel('deepseek-flash'), 'deepseek');
  assert.equal(providerOfModel('未登记的模型'), undefined);
});

/* ------------------------------ 展示 ------------------------------ */

test('展示名：字符串与 { zh, en } 两种形态', () => {
  assert.equal(labelOfVendor('deepseek'), 'DeepSeek');
  assert.equal(labelOfVendor('zhipu', 'zh'), '智谱（GLM）');
  assert.equal(labelOfVendor('zhipu', 'en'), 'Zhipu (GLM)');
  assert.equal(labelOfVendor('未知厂商'), '未知厂商');

  // deepseek-account 在统计口径显示为 DeepSeek（displayAs），但提供方名保留完整
  assert.equal(labelOfProvider('deepseek-account'), 'DeepSeek');
  assert.equal(PROVIDERS['deepseek-account'].label, 'DeepSeek Account');

  assert.equal(labelOfModel('moonshotai/Kimi-K3'), 'Kimi K3');
  assert.equal(labelOfModel('qwen3.8-max'), 'qwen3.8-max');
  assert.equal(labelOfClient('dsh'), 'DSH');
  assert.equal(labelOfClient('新客户端'), '新客户端');
});

test('resolveLabel 兜底顺序', () => {
  assert.equal(resolveLabel('X'), 'X');
  assert.equal(resolveLabel({ zh: '中', en: 'EN' }, 'en'), 'EN');
  assert.equal(resolveLabel({ zh: '中', en: 'EN' }), '中');
  assert.equal(resolveLabel({ en: 'EN' }, 'zh'), 'EN');
  assert.equal(resolveLabel(null), '');
});

/* ------------------------------ 元数据 ------------------------------ */

test('厂商颜色', () => {
  assert.equal(colorOfVendor('deepseek'), '#3964fe');
  assert.equal(colorOfVendor('opencode'), null);   // 中转站不占色系
  assert.equal(colorOfVendor('不存在'), null);
});

test('取价键走规范 id', () => {
  assert.equal(priceKeyOf('moonshotai/Kimi-K3'), 'k3');
  assert.equal(priceKeyOf('deepseek/deepseek-v4.1-flash'), 'deepseek-flash');
  assert.equal(priceKeyOf('未登记'), '未登记');
});

/* ------------------------------ 投影 ------------------------------ */

test('project 输出完整投影', () => {
  const r = project('commandcode', 'moonshotai/Kimi-K3', 'zh');
  assert.equal(r.provider, 'commandcode');
  assert.equal(r.model, 'k3');
  assert.equal(r.providerLabel, 'Command Code');
  assert.equal(r.modelLabel, 'Kimi K3');
  // 统计分组用提供方厂商（中转站自己一根柱子）
  assert.equal(r.vendor, 'commandcode');
  assert.equal(r.vendorLabel, 'Command Code');
  // 配色用模型厂商（柱内模型沿用厂商色）
  assert.equal(r.modelVendor, 'kimi');
  assert.equal(r.modelVendorLabel, 'Kimi');
  assert.equal(r.known, true);

  const u = project('deepseek-official', 'weird-model', 'zh');
  assert.equal(u.provider, 'deepseek');
  assert.equal(u.model, 'weird-model');
  assert.equal(u.known, false);
  assert.equal(u.modelLabel, 'weird-model');
});

/* --------------------- 未登记也要正常显示（红线） --------------------- */

test('未登记的模型/提供方不会被隐藏或改写', () => {
  // 未登记模型：id 原样、display 原样，仍可投影
  const m = canonicalModel('brand-new-model-x');
  assert.equal(m.id, 'brand-new-model-x');
  assert.equal(m.display, 'brand-new-model-x');
  assert.equal(m.known, false);

  // 整条行投影仍可用，label 就是原值
  const r = project('brand-new-provider', 'brand-new-model-x', 'zh');
  assert.equal(r.provider, 'brand-new-provider');
  assert.equal(r.model, 'brand-new-model-x');
  assert.equal(r.providerLabel, 'brand-new-provider');
  assert.equal(r.modelLabel, 'brand-new-model-x');
  assert.equal(r.known, false);
});

/* ------------------------------ 表自洽 ------------------------------ */

test('表自洽：每个 provider 的 vendor 都在 VENDORS 里', () => {
  for (const [id, meta] of Object.entries(PROVIDERS)) {
    if (meta.aliasOf) {
      assert.ok(PROVIDERS[meta.aliasOf], `${id} 的 aliasOf 指向不存在的 ${meta.aliasOf}`);
      continue;
    }
    assert.ok(VENDORS[meta.vendor], `${id} 的 vendor ${meta.vendor} 未在 VENDORS 登记`);
  }
});

test('表自洽：每个 model 的 vendor / provider 都合法', () => {
  for (const [id, meta] of Object.entries(MODELS)) {
    assert.ok(meta.display, `${id} 缺 display`);
    if (meta.vendor) assert.ok(VENDORS[meta.vendor], `${id} 的 vendor ${meta.vendor} 未登记`);
    if (meta.provider) assert.ok(PROVIDERS[meta.provider], `${id} 的 provider ${meta.provider} 未登记`);
    for (const alias of meta.aliases || []) {
      assert.equal(canonicalModel(alias).id, id, `别名 ${alias} 未归一到 ${id}`);
    }
  }
});

test('表自洽：颜色只给厂商，中转站不占色系', () => {
  for (const [id, meta] of Object.entries(VENDORS)) {
    if (meta.kind === 'reseller') {
      assert.equal(meta.color, null, `中转站 ${id} 不该有独立颜色`);
    }
  }
});

test('客户端展示名形态正常', () => {
  for (const [id, label] of Object.entries(CLIENTS)) {
    assert.ok(typeof label === 'string' || (label && typeof label === 'object'), `${id} 展示名类型异常`);
  }
});
