# 兼容性

## 支持矩阵

| 宿主版本 | 平台 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.2.1-rc.2 | Windows 11 / Node 24 | compatible | 实测：监听、配置改写、回滚、补丁、机器人、指标、设置页 |
| 0.2.1-rc.2 | Linux | CI only | 语法、105 条测试与打包门禁在 ubuntu-latest 上跑；未做真机桌面联调 |
| 0.2.0-rc.2 | Windows / Linux | unknown | 未实测。早期开发机装的是这一版，但 0.2.x 之后才加入 0.4.x 的补丁机制 |
| 0.3.x 及以后 | Windows / Linux | unknown | 未实测。宿主每次 rc 升级都可能改插件契约，请按下面的清单复核 |

`package.json` 的 `dsh.compatibility.dsh` 是 **区间**，`dshReleases` 只记录**已实测**的版本。
宿主换版本时，`dshReleases` 里没有的版本按 unknown 对待——不假装兼容。

## 平台与运行环境

同一份代码在 Windows 与 Linux 上运行，差异集中在三处，且都有测试固定：

| 差异 | 处理 | 测试 |
| --- | --- | --- |
| 安装布局（hoisted vs pnpm `.pnpm/<pkg>@<ver>`） | `findProfileRoot()` 从插件目录向上找「含 `cordis.patch.yml` 或 `dsh.profile` 的目录」，不数 `..` | `test/host-contract.test.mjs` |
| Windows 文件名禁用字符 | 备份文件名把 `:`、`.` 换成 `-` | `test/platform.test.mjs` |
| 换行 | 状态文件一律 LF（插件不再写 `.env`，0.7.2 起只清理自己写过的行） | `test/platform.test.mjs` |

运行环境会随契约一起写进状态：

```json
"hostContract": { "webServer": "exact", "ok": true, "at": "2026-10-21T12:00:00.000Z" },
"hostEnv": { "platform": "win32", "arch": "x64", "node": "v24.15.0", "at": "2026-10-21T12:00:00.000Z" }
```

报兼容性问题时请附这两个字段——它们说明「在什么宿主、什么平台上，哪一种注册形状被接受」。
## 本插件依赖的宿主契约

1. `hostCtx.webServer.register({ kind: 'exact', path, handler })` —— 注册设置页用的 HTTP 端点。
2. `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(...))` —— 注册设置标签页。
3. `package.json` 的 `dsh.client`（`platform` / `immediately` / `inject`）与 `exports["./client"]` —— 让宿主扫描并加载客户端 bundle。
4. `ctx.on('dispose', fn)` —— 宿主销毁插件时的收尾钩子。

这些都没有公开文档，而且变过（0.1.1 就因为槽位写法不对，标签页静默消失）。

## 0.7.0 的应对：探测，而不是猜版本号

- **webServer 形状**：依次尝试 `{kind:'exact'}` → `{path, handler}` → 位置参数；记录到 `state.hostContract` 与历史（`host-contract`）。
- **槽位**：`slots.inject` 不存在但 `slots.register` 存在时，直接按槽位名注册（兼容模式），并在控制台说明。
- **降级**：三种形状都不被接受时，插件仍然加载（监听与状态照常工作），只是设置页拿不到 API；`?op=state` 不可用即为该模式的特征，日志里有一行 `API is unavailable`。

## 升级宿主时的检查清单

1. 启动后看 `state.json` 的 `hostContract.webServer` 是否为 `exact`；不是就说明契约变了。
2. 打开「出口路由」标签页，确认 `?op=state` 返回 200。
3. `npm run check:package` 与 `npm test` 全绿。
4. `test/api-surface.test.mjs` 固化了 `?op=state` 的键集合与错误码；宿主改了响应形状它会先红。
5. 把实测结果补进 `dshReleases`，再发布。

## 前向兼容的约定

- `state.schemaVersion` 描述**状态文档的对外形状**，与 `version`（内部迁移计数）分开。
- 迁移只增不删：新字段缺失按默认值补齐，旧字段保留但不读。
- API 只增键不改键；错误码（`port_in_use`、`loopback_target`、`unknown_patch` 等）视为稳定契约。
