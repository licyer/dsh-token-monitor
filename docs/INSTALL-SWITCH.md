# 安装与切换指南

dsh-token-monitor 支持三种安装来源（npm / GitHub / 本地路径），可随时切换。本文档覆盖：安装方式、三种切换场景、**link 版卸载的坑与彻底清理**。

## 1. 安装方式

| 来源 | 命令 | 依赖形态 | 适用 |
|---|---|---|---|
| npm（正式） | `dsh plugin --profile web add dsh-token-monitor@latest` | `"dsh-token-monitor": "0.1.x"` | 日常使用、发布验证 |
| GitHub | `dsh plugin --profile web add github:licyer/dsh-token-monitor` | `github:...` | 直接从仓库装 |
| **本地（开发）** | `dsh plugin --profile web add E:\VsCodeProjects\dsh-token-monitor` | `"dsh-token-monitor": "link:E:/..."` | 改代码调试（热循环） |

> 所有来源**都会自动挂载**（本地项目 `package.json` 声明了 `dsh.bundle.patch`，reconcile 会把它加进 `dsh.profile.bundles`）。装完**重启 `dsh web`**。

## 2. 场景一：npm 版 → 本地版（进入开发模式）

```sh
# 1. 卸掉当前 npm 版（npm 版 remove 是干净的，见 §5）
dsh plugin --profile web remove dsh-token-monitor

# 2. 装本地路径（pnpm 自动 link）
dsh plugin --profile web add E:\VsCodeProjects\dsh-token-monitor
```

- `node_modules/dsh-token-monitor` 变成 **junction → 本地项目目录**
- 开发热循环：改 `lib/client.js` → 刷新页面即生效（hmr）；改 `lib/index.js` / `lib/util/` → 重启 `dsh web`
- 验证：`~/.dsh/profiles/web/package.json` 的 `dependencies` 显示 `"dsh-token-monitor": "link:E:/..."`

## 3. 场景二：本地版 → npm 版（回到正式）

```sh
# 1. 卸本地 link（⚠️ 必须按 §5 清理，否则删不干净）
dsh plugin --profile web remove dsh-token-monitor

# 2. 装 npm 目标版本（精确版本最可控）
dsh plugin --profile web add dsh-token-monitor@0.1.1
# 或最新：dsh plugin --profile web add dsh-token-monitor@latest
```

## 4. 场景三：npm 版内部切换版本

```sh
# 指定版本（降级/锁版）
dsh plugin --profile web add dsh-token-monitor@0.1.0

# 升级到范围内最新（用 update，别用 add——add 可能因已装而复用旧状态）
dsh plugin --profile web update dsh-token-monitor
```

> 提示：`@latest` 依赖镜像的 `dist-tags.latest` 同步；镜像滞后时用**精确版本**（`@0.1.1`）绕过。

## 5. ⚠️ link 版 remove 的坑：详细清理步骤

**现象**：`dsh plugin --profile web remove dsh-token-monitor` 输出 `Already up to date`，但：
- `dependencies` 里的 `link:` 条目**可能还在**
- `node_modules` 里的 **junction 还在**
- `dsh.profile.bundles` 里的 `dsh-token-monitor` **不移出**（reconcile 认为依赖仍在、仍是 bundle）

### 彻底清理（推荐：让 reconcile 自愈）

```sh
# ① 删除 node_modules 里的 junction（rmdir 只删链接、不删本地项目）
cmd /c "rmdir C:\Users\licy\.dsh\profiles\web\node_modules\dsh-token-monitor"

# ② 若 package.json 的 dependencies 还有 link 条目，手动删掉（编辑 JSON）
#    目标状态："dependencies": {}（或只剩其他依赖）

# ③ 跑一次 dsh plugin 命令触发 reconcile —— 此时依赖已不在、包不可解析，
#    reconcile 会把 dsh-token-monitor 从 bundles 自动移出
dsh plugin --profile web install

# ④ 验证三处干净（§6）
```

### 完全手动（reconcile 不愿跑时的兜底）

```sh
# ① 删 junction（同上）
cmd /c "rmdir C:\Users\licy\.dsh\profiles\web\node_modules\dsh-token-monitor"

# ② 编辑 ~/.dsh/profiles/web/package.json：
#    - dependencies 里删除 "dsh-token-monitor" 条目
#    - dsh.profile.bundles 里删除 "dsh-token-monitor" 条目
#    （最终 bundles 只剩 @deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app）

# ③ 可选：删除 pnpm-lock.yaml（link 残留引用）
del C:\Users\licy\.dsh\profiles\web\pnpm-lock.yaml
```

## 6. 卸载/切换后的验证清单

1. **三处无残留**：
   - `~/.dsh/profiles/web/package.json`：`dependencies` 无 `dsh-token-monitor`、`bundles` 无 `dsh-token-monitor`
   - `~/.dsh/profiles/web/node_modules/dsh-token-monitor`：不存在
2. **重启 `dsh web` 无报错**：不应出现 `cannot resolve profile bundle "dsh-token-monitor"` 之类的 fail-loud 错误
3. **页面无插件痕迹**：会话头部无余量徽标、主区无"用量"页签
4. （可选残留）`~/.dsh/profiles/web/pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 行**无害**，可留可删

## 7. 常见问题

**Q：装完看不到插件？**
A：确认 `dsh.profile.bundles` 里有 `dsh-token-monitor`（自动挂载成功标志）；重启 `dsh web`。

**Q：`@latest` 装到旧版本？**
A：镜像 `dist-tags.latest` 滞后，改用精确版本 `@0.1.1` 或指定官方源。

**Q：本地改代码不生效？**
A：`client.js` 刷新页面；`index.js`/`lib/util/` 重启 `dsh web`。确认当前是 link 模式（`dependencies` 是 `link:` 而非 `0.1.1`）。
