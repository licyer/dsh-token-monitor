<div align="center">

# dsh-token-monitor

[![release](https://img.shields.io/github/v/release/licyer/dsh-token-monitor.svg)](https://github.com/licyer/dsh-token-monitor/releases)
<a href="https://www.npmjs.com/package/dsh-token-monitor" target="_blank" rel="noopener noreferrer"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-token-monitor.svg"></a>
[![license](https://img.shields.io/npm/l/dsh-token-monitor.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-0.1.2--rc.1-326ce5)](https://github.com/deepseek-ai/deepseek-harness)

[安装](#安装) · [功能](#功能) · [插件配置](#插件配置) · [供应商适配](#供应商适配) · [常见问题](#常见问题) · [设计](#设计) · [开发](#开发)

</div>

DeepSeek Harness（DSH）Web 界面的大模型**余量与用量监控**插件：会话头部实时余量徽标 + 主区"用量"页签，本地 SQLite 记录每次调用的 token 与费用。

<p align="center">
  <img src="docs/images/usage-overview.png" alt="用量页签总览" width="100%">
</p>

## 安装

> [!NOTE]
> 需要 **Node.js ≥ 22**（依赖内置 `node:sqlite`）。仅支持 DSH Web 端（`platform: web`）。
> 实测环境：DSH **0.1.2-rc.1**（0.1.1 的旧接口差异做了兼容回退；更高版本未验证）。

### 从 npm（推荐）

```sh
dsh plugin --profile web add dsh-token-monitor
```

### 从 GitHub

```sh
dsh plugin --profile web add github:licyer/dsh-token-monitor
```

安装即自动注册（写入 profile 的 `package.json` bundles 与依赖），重启 `dsh web` 生效，无需手动改配置。

## 功能

| 能力 | 说明 |
| --- | --- |
| 余量徽标 | 会话头部显示当前模型供应商余量（`k3 · 5h 剩 82%`），点击弹详情层 |
| 用量页签 | 与"对话 / 轨迹"并列：token 用量、估算费用、趋势、排行、请求明细 |
| 自动采集 | 自动采集 DSH 会话日志，后台定时 + 手动刷新 |
| 历史导入 | 可导入 cc-switch 历史记录，重复导入不产生重复数据 |
| 跨设备同步 | DSH 用量支持导出/导入 JSON 快照（明细 + 聚合），不同设备记录合并到一台设备，幂等不重复 |
| 语言跟随 | 界面文案跟随 DSH 中文 / 英文切换 |

### 余量监控

徽标显示当前模型供应商的余量：

1. **订阅制**供应商（如 Kimi For Coding）：显示滚动窗口与周额度百分比
2. **按量付费**供应商（如 DeepSeek 官方）：显示账户余额

点击徽标弹出详情层：当前提供方指标、本会话 token 用量（可切换会话）、全部提供方折叠区、cc-switch 数据同步提示条、更新时间与刷新。

![余量徽标与详情弹层](docs/images/quota-popover.png)

### 用量页签

顶部筛选（客户端 / 供应商 / 模型级联，供应商按厂商归并）+ 时间窗（当天 / 昨天 / 7 / 30 / 90 天 / 全部），统计卡显示总消耗、请求次数、预估费用、平均 TTFT、新增输入、缓存命中、输出、缓存命中率。

- **使用趋势**：渐变面积图，左轴 token 构成，右轴切换预估费用 / 请求次数；当天为分钟级刻度（2~60 分钟自适应 ≥12 桶，补桶不跨天），悬浮提示显示桶区间（如 `15:00~15:30`）

![使用趋势](docs/images/usage-trend.png)

- **供应商消耗统计**：X 轴供应商、柱内按模型堆叠，右柱费用 / 次数可切换

![供应商消耗统计](docs/images/provider-bars.png)

- **年度消耗热力图**：GitHub 日历风，近 12 个整月，色深 = 当日 token，首尾按周补齐

![年度消耗热力图](docs/images/heatmap.png)

- **使用排行**：模型 / 供应商 / 客户端三维度聚合，默认按总消耗降序

![使用排行](docs/images/usage-rank.png)

- **请求记录**：分页明细表（时间倒序），页码跳转、每页条数可调（10/20/50/100）

![请求记录](docs/images/usage-records.png)

- **跨设备同步**：底部"数据来源"提供导出 / 导入按钮，把不同设备的使用记录合并到一台设备，重复导入无副作用）

![跨设备同步](docs/images/usage-sync.png)

## 插件配置

配置文件：`$DSH_HOME/storages/token-monitor/config.json`。

设置入口：DSH 设置面板（左下角齿轮）→ **Token Monitor** 页，表单保存后即时写回该文件。三个设置项：默认时间窗 / 余量轮询间隔（秒）/ 请求记录保留时间（天）；下方另附**已适配供应商清单**（哪些提供方已适配、开发者是否用真实凭证验证过）。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `defaultDays` | `1` | 用量页签默认时间窗天数；`0` = 全部 |
| `pollMs` | `60` | 头部余量轮询间隔（单位秒，`5`–`86400`）。设置页与 `config.json` 均存秒，需要毫秒时由前端单独 ×1000 |
| `retentionDays` | `60` | 请求记录保留天数（超过此时长的记录会被定期清理，不影响聚合统计；设置页提供 30/60/90） |

## 供应商适配

| 提供方 | 类型 | 适配说明 | 验证状态 |
| --- | --- | --- | --- |
| `kimi-coding` | 订阅额度 | 5h / 7d / 权益等级（百分比与重置倒计时） | ✅ 已验证 |
| `moonshotai-cn` | 按量余额 | 可用余额（CNY）+ 现金/代金券明细 | ✅ 已验证 |
| `deepseek` | 按量余额 | 账户余额（按币种账户显示） | ✅ 已验证 |
| `opencode-go` | 订阅额度 | 5h / 7d / 30d（百分比与重置倒计时） | ✅ 已验证 |
| `openrouter` | 按量余额 | 积分余额（1 积分 = $1）+ 本月/总消耗 | ✅ 已验证 |
| `minimax` / `minimax-cn` | 订阅额度 | 5h / 7d 用量百分比（剩余%） | ⚠️ 待真实 key 验证 |
| `zai` / `zai-coding-cn` | 订阅额度 | 5h / 7d 用量百分比（窗口自动识别，含重置时间） | ⚠️ 待真实 key 验证 |
| — | — | 未适配 | — |

> **验证状态说明**：✅ = 长期运行、真实响应结构已验证；⚠️ = 已实现并通过 mock 测试，但**未用真实 key 校准**（响应结构以参考实现为准，若有出入请发抓取返回的 `raw` 原文校准）。

## 常见问题

<details>
<summary><strong>徽标没显示或"查询失败"？</strong></summary>

A: 徽标 / 弹层对提供方的提示分两种（统一文案，不显示具体错误）：

**显示"未配置 API Key"** = 该供应商的凭证没配（DSH credentials：`~/.dsh/.credentials.yaml`，或环境变量如 `DEEPSEEK_API_KEY` / `KIMI_CODING_API_KEY`）——配置凭证后自动恢复。

**显示"查询失败"** = 凭证已配置但余量接口查询失败，按条排查：

1. **接口请求失败**：网络不通、超时，或端点返回错误状态（4xx 鉴权失败、5xx 服务端异常）
2. **端点漂移**：供应商 API 地址变更（常见 404），在插件配置里用 `providers.<id>.url` 覆盖
3. **响应无法解析**：接口返回 200 但字段结构异常（额度字段缺失 / 格式不对），无法提取余量

> 注意：若显示"插件未适配该提供方"，则是该提供方尚未适配，与以上无关。

</details>

<details>
<summary><strong>用量页签没数据？</strong></summary>

A: 用量来自会话日志采集：确认 `$DSH_HOME/sessions` 下有会话日志，点顶部"刷新"（先采集再查询）；CC 数据需在"数据来源"手动导入。

</details>

<details>
<summary><strong>费用准不准？</strong></summary>

A: 按 pi-ai 本地刊例价估算，仅供参考、非实际账单；订阅制不产生真实扣费。未定价模型计入 token 不计入费用。

</details>

## 设计

用量数据本地存储：会话日志增量采集进 SQLite（`token-monitor.db`），页面查询纯读库秒开，采集由后台定时器 / 手动刷新 / 打开页签时触发。存储与同步设计详见 [设计文档](docs/DESIGN.md)。

## 开发

```sh
git clone https://github.com/licyer/dsh-token-monitor.git
dsh plugin --profile web add link:/path/to/dsh-token-monitor   # 本地路径挂载
```

- 改前端（`lib/client.js`）：HMR 热替换，刷新即生效
- 改服务端（`lib/index.js` / `lib/util/`）：需重启 `dsh web` 进程

## 许可证

[MIT](LICENSE) © 2026 licyer
