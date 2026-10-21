# 兼容性

## 支持矩阵（宿主 × 平台）

| 宿主版本 | 平台 | 状态 | 依据 |
| --- | --- | --- | --- |
| 0.2.1-rc.2 | Windows 11 25H2 / Node 24.15.0 | **compatible（真机）** | 实测：监听、外科式改写、回滚、兼容补丁、机器人代理、指标、设置页、诊断包。见本页末「实测记录」 |
| 0.2.1-rc.2 | Ubuntu 22.04+ / Node 20、24 | CI only | 每个 PR 跑完整测试、语法门禁、打包门禁与**安装冒烟**（`npm run install-smoke`） |
| 0.2.1-rc.2 | macOS 13+（arm64 / x64）/ Node 20、24 | CI only | 同上。未做真机桌面联调，只证明代码路径与打包产物在 macOS 上可用 |
| 0.2.0-rc.2 | Windows / Linux / macOS | unknown | 未实测。0.4.x 才加入兼容补丁机制 |
| 0.3.x 及以后 | 全平台 | unknown | 未实测。宿主 rc 升级可能改插件契约，请按下面清单复核 |

`package.json` 的 `dsh.compatibility.dsh` 是**区间**，`dshReleases` 只记录**已实测**的版本。
宿主换版本时，`dshReleases` 里没有的版本按 unknown 对待——不假装兼容。

## CI 覆盖（每次 push / PR）

| 作业 | 平台 | Node | 覆盖什么 |
| --- | --- | --- | --- |
| `test` | ubuntu-latest、windows-latest、macos-latest | 20、24 | `npm run check`（语法）、完整测试、`check:package`（产物白名单与体积） |
| `install-smoke` | 同上 | 20、24 | **打包 → 干净 consumer 安装 tgz → 用假 ctx 启动已安装副本**，断言 `apiVersion`、26 个 state 键、`schemaOk`、`profileOk`、发现器读到 profile、`client/client.js` 与 `cordis.patch.yml` 确实在包里 |

`install-smoke` 是唯一覆盖「包内容」的检查：`exports["./client"]` 缺失、`files` 白名单漏文件、
profileRoot 少上溯一层，这三类事故它都会红，而源码树测试不会。

真机与 CI 的差别（必须诚实说明）：CI 只以**本机回环 + 假宿主上下文**启动插件，
没有 Electron 宿主、没有真实 `webServer` 服务、没有设置页渲染；客户端只在 `preview/harness.html`
里做过渲染核对。

## 平台与运行环境

同一份代码在 Windows / Linux / macOS 上运行，差异集中在四处，且都有测试或脚本固定：

| 差异 | 处理 | 固定手段 |
| --- | --- | --- |
| 安装布局（hoisted vs pnpm `.pnpm/<pkg>@<ver>`） | `findProfileRoot()` 从插件目录向上找「`package.json` 里带 `dsh.profile`」的目录，并回退到「dependencies 里有本插件」的目录，不数 `..` | `test/host-contract.test.mjs`、`install-smoke` |
| Windows 文件名禁用字符（`:`、`.`、`\`） | 备份文件名把 `:`、`.` 换成 `-`；备份落在 `storages/egress-router/backups/` | `test/platform.test.mjs` |
| 换行（CRLF vs LF） | 状态文件与补丁备份一律 LF；`.env` 只按行精确匹配自己写过的行 | `test/platform.test.mjs`、`test/reliability.test.mjs` |
| `npm` 可执行形态（Windows `.cmd` 不能直接 `execFileSync`） | 安装冒烟优先用 `node <npm-cli.js>`，找不到才退回 `npm` + `shell` | `scripts/install-smoke.mjs`（三平台 CI 实跑） |

运行环境随契约一起写进状态，报兼容性问题时请附上：

```json
"hostContract": { "webServer": "exact", "ok": true, "at": "2026-10-21T12:00:00.000Z" },
"hostEnv": { "platform": "win32", "arch": "x64", "node": "v24.15.0", "at": "2026-10-21T12:00:00.000Z" }
```

## 本插件依赖的宿主契约

1. `hostCtx.webServer.register({ kind: 'exact', path, handler })` —— 注册设置页用的 HTTP 端点。
2. `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(...))` —— 注册设置标签页。
3. `package.json` 的 `dsh.client`（`platform` / `immediately` / `inject`）与 `exports["./client"]` —— 让宿主扫描并加载客户端 bundle。
4. `ctx.on('dispose', fn)` —— 宿主销毁插件时的收尾钩子。

这些都没有公开文档，而且变过（0.1.1 就因为槽位写法不对，标签页静默消失）。
`test/contract.test.mjs` 与 `test/contract/api-surface.json` 把「状态键、错误码、loader、槽位、exports」固化成快照：
宿主或我们自己改动其中之一，测试先红，而不是用户在设置页看到一个空面板。

## 0.7.0 的应对：探测，而不是猜版本号

- **webServer 形状**：依次尝试 `{kind:'exact'}` → `{path, handler}` → 位置参数；记录到 `state.hostContract` 与历史（`host-contract`）。
- **槽位**：`slots.inject` 不存在但 `slots.register` 存在时，直接按槽位名注册（兼容模式），并在控制台说明。
- **降级**：三种形状都不被接受时，插件仍然加载（监听与状态照常工作），只是设置页拿不到 API；日志里有一行 `API is unavailable`。

## 升级宿主时的检查清单

1. 启动后看 `state.json` 的 `hostContract.webServer` 是否为 `exact`；不是就说明契约变了。
2. 打开「出口路由」标签页，确认 `?op=state` 返回 200，且 `schemaOk: true`。
3. `npm run check`、`npm test`、`npm run check:package`、`npm run install-smoke` 全绿。
4. `test/contract/api-surface.json` 若需要改动，说明对外契约变了：同步更新 README 的接口表并升 `apiVersion`（破坏性）或只追加（兼容）。
5. 把实测结果补进 `dshReleases` 与本页矩阵，再发布；发布步骤见 `docs/RELEASE.md`。

## 前向兼容的约定

- `state.schemaVersion` 描述**状态文档的对外形状**，与 `version`（内部迁移计数）分开。
- 迁移只增不删：新字段缺失按默认值补齐，旧字段保留但不读。
- API 只增键不改键；错误码（`port_in_use`、`loopback_target`、`unknown_patch` 等）视为稳定契约。
- 状态文档由 `lib/schema.js` 按 v9 校验；`?op=state` 的 `schemaOk` / `schemaErrors` 把「文件坏了」变成可见结果，校验器只报告、不修复。

## 实测记录

| 日期 | 环境 | 结论 |
| --- | --- | --- |
| 2026-10-21 | Windows 11 家庭版 10.0.26300、Node 24.15.0、DSH 0.2.1-rc.2 | 26 键 state、两条路由（gemini 8792/clash、openrouter 8791/clash）、`schemaOk=true`、诊断包脱敏、上游探测可用 |
| 2026-10-21 | ubuntu-latest / macos-latest（GitHub Actions） | 测试与安装冒烟通过；未做桌面联调 |

新平台接入时：先跑 `npm run install-smoke`（证明包能装、能启动），再在真机上开设置页确认标签页与按钮，最后把结果补进上表。
