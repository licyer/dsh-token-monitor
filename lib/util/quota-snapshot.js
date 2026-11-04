/**
 * 余量快照 v2：统一契约、状态码与校验。
 *
 * 设计文档：docs/quota-snapshot-v2.md
 *
 * 各提供方的 fetchXxx 自行解析原始响应，直接产出本契约要求的结构；
 * 中心只做两件事：validate() 校验 + 聚合排序，不含任何提供方专属逻辑。
 *
 * 约定：
 *  - status === OK 时，billingType 对应的容器必须有数据；
 *  - status !== OK 时，quota / balance 必须为空（不能"有数据但状态是错的"）；
 *  - message 只能是白名单文案，原始错误走日志。
 */

/** 状态码。1 = 成功（拿到数据）；2-7 为非成功状态。 */
export const STATUS = Object.freeze({
  OK: 1,                 // 成功：拿到了有效额度/余额
  NO_CREDENTIAL: 2,      // 未配置凭证：无 key / 认证文件读不到 / 配置无效
  UNSUPPORTED: 3,        // 未适配：插件没有该提供方的抓取器
  UNAUTHORIZED: 4,       // 凭证被拒：401/403、key 无效或过期
  REQUEST_FAILED: 5,     // 请求失败：网络异常、超时、5xx、响应无法解析
  NO_DATA: 6,            // 无有效额度数据：请求成功但字段没识别到 / 窗口全缺失
  NO_PLAN: 7,            // 无生效套餐：账号可查通，但没有生效订阅
});

/** 计费类型枚举。 */
export const BILLING_TYPES = Object.freeze(['quota', 'balance']);

/** 时间窗周期枚举（受控，不引入自由字符串）。 */
export const PERIODS = Object.freeze(['5h', '7d', '30d', 'month']);

/** 时间窗作用域枚举：total = 主额度（默认，参与徽标选窗）；code = 编程专项（只进明细）。 */
export const WINDOW_SCOPES = Object.freeze(['total', 'code']);

/** 错误类型 → 状态码。抓取器报"发生了什么"，由这里翻译成状态码。 */
const ERROR_STATUS = Object.freeze({
  'no-credential': STATUS.NO_CREDENTIAL,
  unsupported: STATUS.UNSUPPORTED,
  unauthorized: STATUS.UNAUTHORIZED,
  network: STATUS.REQUEST_FAILED,
  timeout: STATUS.REQUEST_FAILED,
  http: STATUS.REQUEST_FAILED,
  unrecognized: STATUS.NO_DATA,
  'no-plan': STATUS.NO_PLAN,
});

/**
 * 错误类型映射为状态码。
 * @param {string} kind 抓取器报告的失败类型
 * @returns {number} 状态码；未知类型按"请求失败"处理
 */
export function mapError(kind) {
  return ERROR_STATUS[kind] || STATUS.REQUEST_FAILED;
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 校验时间窗数组。
 * @returns {string[]} 错误列表（空数组表示通过）
 */
function validateWindows(windows, errors) {
  if (!Array.isArray(windows) || windows.length === 0) {
    errors.push('quota.timeWindows 必须是非空数组');
    return;
  }
  windows.forEach((w, i) => {
    const at = `quota.timeWindows[${i}]`;
    if (!w || typeof w !== 'object') { errors.push(`${at} 必须是对象`); return; }
    if (!PERIODS.includes(w.period)) {
      errors.push(`${at}.period 必须是 ${PERIODS.join(' | ')} 之一，实际 ${JSON.stringify(w.period)}`);
    }
    if (!isFiniteNumber(w.usedPct)) {
      errors.push(`${at}.usedPct 必须是数字`);
    } else if (w.usedPct < 0 || w.usedPct > 100) {
      errors.push(`${at}.usedPct 必须在 0–100 之间，实际 ${w.usedPct}`);
    }
    for (const key of ['used', 'limit', 'resetAt', 'resetInSec']) {
      if (w[key] !== undefined && !isFiniteNumber(w[key])) {
        errors.push(`${at}.${key} 若存在必须是数字`);
      }
    }
    // scope：同一 period 下可能有多个额度（如 Kimi 的「月总额度」+「月编程额度」）。
    // total（默认）= 主额度，参与徽标选窗；code = 编程专项，只在弹层明细展示。
    if (w.scope !== undefined && !WINDOW_SCOPES.includes(w.scope)) {
      errors.push(`${at}.scope 若存在必须是 ${WINDOW_SCOPES.join(' | ')} 之一，实际 ${JSON.stringify(w.scope)}`);
    }
  });
}

/** 校验附加额度数组（可选字段，存在则逐项检查）。 */
function validateExtraQuotas(extra, errors) {
  if (extra === undefined) return;
  if (!Array.isArray(extra)) { errors.push('quota.extraQuotas 必须是数组'); return; }
  extra.forEach((q, i) => {
    const at = `quota.extraQuotas[${i}]`;
    if (!q || typeof q !== 'object') { errors.push(`${at} 必须是对象`); return; }
    if (!isNonEmptyString(q.label)) errors.push(`${at}.label 必须是非空字符串`);
    if (!isFiniteNumber(q.amount)) errors.push(`${at}.amount 必须是数字`);
    if (!isNonEmptyString(q.currency)) errors.push(`${at}.currency 必须是非空字符串`);
    // progress：可选的消费进度（如 Kimi 加油包的「周期消费 / 月上限」），有则前端画进度条。
    if (q.progress !== undefined) {
      const p = q.progress;
      if (!p || typeof p !== 'object') {
        errors.push(`${at}.progress 若存在必须是对象`);
      } else {
        if (!isFiniteNumber(p.used)) errors.push(`${at}.progress.used 必须是数字`);
        // limit 为 null 表示"无上限"（如加油包关闭了月消费上限）：不画进度条，只显示已消费
        if (p.limit !== null && (!isFiniteNumber(p.limit) || p.limit <= 0)) {
          errors.push(`${at}.progress.limit 必须是正数或 null（无上限）`);
        }
        if (p.currency !== undefined && !isNonEmptyString(p.currency)) {
          errors.push(`${at}.progress.currency 若存在必须是非空字符串`);
        }
      }
    }
  });
}

/** 校验余额账户数组（可选字段）。 */
function validateAccounts(accounts, errors) {
  if (accounts === undefined) return;
  if (!Array.isArray(accounts)) { errors.push('balance.accounts 必须是数组'); return; }
  accounts.forEach((a, i) => {
    const at = `balance.accounts[${i}]`;
    if (!a || typeof a !== 'object') { errors.push(`${at} 必须是对象`); return; }
    if (!isNonEmptyString(a.label)) errors.push(`${at}.label 必须是非空字符串`);
    if (!isFiniteNumber(a.amount)) errors.push(`${at}.amount 必须是数字`);
    if (!isNonEmptyString(a.currency)) errors.push(`${at}.currency 必须是非空字符串`);
    for (const key of ['recharged', 'granted', 'spent']) {
      if (a[key] !== undefined && !isFiniteNumber(a[key])) {
        errors.push(`${at}.${key} 若存在必须是数字`);
      }
    }
  });
}

/**
 * 校验一份余量快照是否符合契约。
 * @param {object} snapshot 抓取器产出的快照
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, errors: ['快照必须是对象'] };
  }
  if (!isNonEmptyString(snapshot.providerId)) errors.push('providerId 必须是非空字符串');
  if (!BILLING_TYPES.includes(snapshot.billingType)) {
    errors.push(`billingType 必须是 ${BILLING_TYPES.join(' | ')} 之一，实际 ${JSON.stringify(snapshot.billingType)}`);
  }
  if (!Number.isInteger(snapshot.status) || snapshot.status < 1 || snapshot.status > 7) {
    errors.push(`status 必须是 1–7 的整数，实际 ${JSON.stringify(snapshot.status)}`);
  }
  if (snapshot.message !== undefined && snapshot.message !== null && typeof snapshot.message !== 'string') {
    errors.push('message 若存在必须是字符串');
  }

  const hasQuota = snapshot.quota !== undefined && snapshot.quota !== null;
  const hasBalance = snapshot.balance !== undefined && snapshot.balance !== null;

  // 与 billingType 一致：只允许出现对应容器
  if (hasQuota && hasBalance) errors.push('quota 与 balance 不能同时存在，必须与 billingType 一致');

  if (snapshot.status === STATUS.OK) {
    if (snapshot.billingType === 'quota') {
      if (!hasQuota) errors.push('status=OK 且 billingType=quota 时必须有 quota');
      else {
        if (snapshot.quota.plan !== undefined && typeof snapshot.quota.plan !== 'string') {
          errors.push('quota.plan 若存在必须是字符串');
        }
        validateWindows(snapshot.quota.timeWindows, errors);
        validateExtraQuotas(snapshot.quota.extraQuotas, errors);
      }
      if (hasBalance) errors.push('billingType=quota 时不允许有 balance');
    } else if (snapshot.billingType === 'balance') {
      if (!hasBalance) errors.push('status=OK 且 billingType=balance 时必须有 balance');
      else {
        const b = snapshot.balance;
        if (!isFiniteNumber(b.amount)) errors.push('balance.amount 必须是数字');
        if (!isNonEmptyString(b.currency)) errors.push('balance.currency 必须是非空字符串');
        if (b.alertThreshold !== undefined && !isFiniteNumber(b.alertThreshold)) {
          errors.push('balance.alertThreshold 若存在必须是数字');
        }
        if (b.spending !== undefined) {
          if (!b.spending || typeof b.spending !== 'object') errors.push('balance.spending 必须是对象');
          else {
            for (const key of ['thisMonth', 'total']) {
              if (b.spending[key] !== undefined && !isFiniteNumber(b.spending[key])) {
                errors.push(`balance.spending.${key} 若存在必须是数字`);
              }
            }
            if (b.spending.currency !== undefined && !isNonEmptyString(b.spending.currency)) {
              errors.push('balance.spending.currency 若存在必须是非空字符串');
            }
          }
        }
        validateAccounts(b.accounts, errors);
      }
      if (hasQuota) errors.push('billingType=balance 时不允许有 quota');
    }
  } else {
    // 非成功状态不得携带数据
    if (hasQuota) errors.push('status≠OK 时不允许有 quota');
    if (hasBalance) errors.push('status≠OK 时不允许有 balance');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 校验并在失败时抛错（测试与开发断言用）。
 * @param {object} snapshot
 * @returns {object} 原样返回快照
 */
export function assertValid(snapshot) {
  const { ok, errors } = validate(snapshot);
  if (!ok) throw new Error(`快照不符合契约：${errors.join('；')}`);
  return snapshot;
}
