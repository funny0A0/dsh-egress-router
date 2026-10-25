# Changelog

## 0.13.0

第三方供应商的「只写模型、不写端点」问题：导入的 provider 只有 `models` 与 `apiKeyEnv` 时，页面原来只能显示 `—`，所有端口/代理/应用控件都不渲染。转发路径没动，改的是「从哪里知道端点」。

- **端点解析链**：新增 `lib/provider-catalog.js`。顺序为 配置字面值 → 本插件记录（路由 `originBaseURL`/备份）→ `config.providerDefaults` → 宿主 pi-ai 目录 → 内置 17 项公共端点。`readProviderCatalog()` 在 Electron 之外也能读 `app.asar`：按 asar 头（偏移 16 起 JSON、偏移 12 记长度）直接取条目，因此 `dsh web` 与 CI 与桌面版解析同一份数据。
- **发现结果带来源**：`?op=discover` 的行新增 `endpointSource`（`config`/`ledger`/`providerDefaults`/`catalog`/`builtin`）与 `configuredBaseURL`；命中后 3–5 的 provider 现在有 `target`，端口/代理/预检/应用/测试全部可用。
- **应用可补写字段**：`planApply` 不再对无 `baseURL` 的 provider 报 `no_base_url`；它用同一条解析链得到种子地址，`commitApply` 通过外科写入补上 `baseURL`，缺 `api` 时一并补上，备份账本记录 `insertApi`，回滚按备份文件字节还原。
- **回环恢复更强**：`knownOriginTarget` 在账本为空时可以用宿主目录/声明的默认端点重建地址，不再只有 4 个内置 provider。
- **诊断可见**：`?op=diagnose` 增加 `config.providerDefaults` 与 `catalog: { builtin, dirs, first }`，反馈问题能看出用了哪份目录。
- **界面**：命中解析链的行显示「端点来自内置目录 / 内置默认 / 配置默认」徽章，并提示「应用时会把这行 baseURL 写进配置」；中英双语。
- **测试**：新增 `test/provider-catalog.test.mjs`（8 条）：目录解析、优先级、发现行来源、补写 `baseURL`+`api` 且注释保留、回滚字节还原、回环恢复、无目录时的声明兜底。全套 116 条 / 22 套件。

## 0.12.0

发布准备：把「能跑」收紧到「哪里都能跑」。

- **写操作串行化**：`apply`/`rollback`/`routes`/`batch`/`patch`/`bot`/`reconcile` 在一个进程内排队，两次点击或一次重试不再交错读写 `state.json` 与 `cordis.patch.yml`；读操作仍并发。
- **中转空闲超时**：目标接受连接后长时间不响应时，按 `route.timeoutMs`（默认 90 s）断开上游；客户端提前断开时同步释放上游请求，避免 socket 泄漏。
- **门禁统一 npm 解析**：新增 `scripts/npm-run.mjs`，`check:package` 与 `install-smoke` 共用；在 Windows `.cmd`、Node 解压包（`lib/node_modules/npm`）、corepack 布局下都能跑。
- **新增跨平台用例** `test/cross-platform.test.mjs`（5 条）：CRLF 配置保持 CRLF、含空格与中文的 profile 路径可 apply/rollback、IPv6 目标接受而 `[::1]` 拒绝、两次并发 apply 不互相覆盖、门禁能在解压布局里找到 npm。
- 删除从未被生产路径调用的 `safe()`（0.8.0 留下的死 API）。
- 测试 runner 打印汇总行（`files=21 pass=108 fail=0`），发布说明可以直接引用。
- Linux 实机验证：WSL Ubuntu 26.04 + Node 22.23.4 跑通完整测试与语法门禁。
## 0.11.0

把「哪些域名不能碰、哪个 provider 的真实地址是什么、发现器怎么判断用途、机器人代理记在哪」从硬编码搬到配置与独立文件。转发路径没动。

### `config.guarded`：追加受保护域名

- 内置 5 条（`platform.deepseek.com`、`api.deepseek.com`、`registry.npmjs.org`、`awesome-dsh-plugin.com`、`dsh-plugin-catalog`）保留，现在可以把自建 SSO、内部 registry 之类追加进来。
- 写法宽松：可以给 host，也可以给 URL（自动归一成 host）；匹配包含子域名，`evil-sso.example.test` 不会误中 `sso.example.test`。
- 受保护行仍只在页面列出、不给「应用」；`source` 注明来自内置还是配置。

### `config.origins`：声明 provider 的真实端点

- 回环恢复原来的兜底只有 4 个内置 provider。现在可以在配置里声明任意 provider 的公网地址，账本为空时也能把 `baseURL` 从 `127.0.0.1:<port>` 救回来。
- 优先级：路由记录 → 备份账本 → `config.origins` → 内置端点；声明值必须是 http(s) 绝对地址，回环值被拒。

### `config.discovery`：声明式发现规则

- `rules[]` 的 `match` 支持 `id`（尾部 `*` 前缀）、`kind`、`host`、`hostSuffix`、`urlIncludes`，多条件 AND，同一行第一条命中即停止。
- 可覆盖 `kind` / `name` / `patchable` / `guarded` / `confidence` / `note`；`ignore[]` 直接隐藏某些 host。
- `?op=discover` 返回 `rulesApplied` 与 `guardedHosts`，被改写的行带 `rule: <id>`；`patchable` 的默认推断只在规则没表态时生效（之前统一按 `kind === "llm"` 赋值，会把规则的 `patchable: false` 覆盖掉）。

### 机器人映射移到 `bots.json`（state v10）

- `state.json` 不再存 `bots{}`，改存同目录 `bots.json`（`{ version: 1, updatedAt, bots }`）。重装插件、重置状态不会连带丢机器人代理。
- 旧状态首次读取时自动迁移一次并从 `state.json` 删除该字段，迁移失败会写 `bots-migrate` 到审计。
- `lib/schema.js` 的 `STATE_VERSION` 升到 10，`TOP_LEVEL` 去掉 `bots`；旧文件仍按版本链迁移。

### 测试与文档

- 新增 `test/config-surface.test.mjs` 9 条：guarded 归一/子域匹配/伪后缀、受保护行与 provider 标记、规则改名与 veto、ignore、`applyRules` 五种 match、origins 兜底、`bots.json` 读写、v9→v10 迁移、v10 校验。
- 全套 103 条 / 20 套件；契约快照 `stateVersion` 升 10（`?op=state` 仍是 26 键，`bots` 行改由 `bots.json` 提供）。
- README 新增四节配置说明（`guarded` / `origins` / `discovery` / `bots.json`）与 0.11.0 版本行；README.en 同步版本与测试数。
## 0.10.0

两条新能力，一个真 bug。转发路径没动。

### 「仅中转」路由（`relay:` 前缀）

- 之前只能服务「有 baseURL 的 provider」：插件改写配置、把调用方指到本机端口。CLI、别的插件、webhook 这类目标根本没有 baseURL，改不了。
- 现在 `?op=routes` 可以建一条 `relay:<name>` 路由：只开监听，不碰 `cordis.patch.yml`。调用方把地址换成 `http://127.0.0.1:<端口>`，请求经这里转发，可选走代理。
- 校验在 `lib/relay-routes.js`：名字合法、目标必须 `host:port`、拒绝私有/回环目标、端口 1024–65535；重发同 id 保留未传的 `proxy` / `tls` / 调优字段。
- 页面新增「本机中转（不改目标配置）」区块：目标 / 端口 / 代理 / 新建、复制地址、删除、运行状态。

### 路由 CRUD 与批量（`?op=routes`、`?op=batch`）

- `GET ?op=routes` 列出所有路由（带 `kind: provider | relay` 与监听状态）；`POST` 的 `action` 支持 `upsert` / `delete`。provider 行的删除走原有回滚（恢复 `baseURL`），relay 行只停监听。
- `POST ?op=batch` 最多 20 条 `apply` / `rollback`：**先全量预检**（重复端口、未知代理、非法 id/target、`unknown_route`），再顺序执行；运行时失败会在停下的位置**逆序补偿**已成功的步骤，并返回 `results` 与 `compensated`。
- 页面：目标行前有复选框，勾选后出现「批量应用 / 批量撤销 / 清除选择」。
- 契约快照新增三个错误码：`unknown_route` 404、`no_actions` 400、`loopback_target` 400。

### 修掉两个静默失败

- 客户端 `refreshSoon()` 的去抖定时器里调用的是**它自己**，于是安静刷新无限自递归、永远到不了宿主：应用/回滚后表格状态不更新，正是 0.5.3 想修的那个症状。现在调用 `refreshAll({ quiet: true })`。
- `callRaw` 失败时只抛 `message`，把 `error` 码与 `payload` 丢掉了；批量的 502 带着 `results`/`compensated`，页面现在能显示「停下后回退了几条」。

### 测试

- 新增 `test/routes-crud.test.mjs`（9 条）：relay 路由建/改/删、不碰配置文件、同端口重复应用幂等、私有目标与未知代理被拒、批量应用+撤销、预检挡重复端口、运行时失败补偿、写操作仍需页面意图。
- `test/client.test.mjs` 增 3 条静态断言（新 op 被调用、去抖不再自递归、错误码与 payload 保留）；`test/contract.test.mjs` 增加三个错误码与 `?op=routes` 列表断言。
- 全量 **94 条 / 19 套件**。

## 0.9.1

发布工程版本：不改用户可见的转发行为，只把「装上去能不能用」变成可重复的检查。

### 状态 schema 校验（`lib/schema.js`）

- 按 state v9 定义校验整个文档：顶层 18 个键必须存在，`routes[]` 的 `id` / `target(host:port)` / `listenPort`、`listeners[]` 的 `ok`、指标计数非负、`lastError` 形状、`hostContract`/`hostEnv` 可空等。
- `?op=state` 新增 `schemaOk` 与 `schemaErrors`（逐字段 `path / expected / actual`，最多 50 条）。**只报告不修复**：自动改写用户数据正是这次要暴露的失败模式。
- 校验器无依赖、可单测：`test/contract.test.mjs` 用真实状态断言通过，并断言坏行（`listenPort: 0`）会失败。

### API 与客户端契约快照（`test/contract/api-surface.json`）

- 快照锁定：`apiVersion`、`state` 的 26 个键、五个错误码的状态（`unknown_op` 404、`invalid_action` 400、`unknown_patch` 404、`provider_not_found` 400、`private_target` 400）、客户端 loader `window.__ModuleLoader__.load`、槽位 `settings.plugins.tab`、`exports`（`.` / `./client` / `./package.json`）与 `dsh.client`（platform/immediately/inject）。
- 宿主改名一个槽位、我们少一个 export，这个测试先红，而不是用户在设置页看到空面板。原 `test/api-surface.test.mjs` 已并入此测试，避免两处维护。

### 三平台安装冒烟（`scripts/install-smoke.mjs`）

- `npm run install-smoke`：`npm pack` → 建一个只有本包依赖的干净 consumer → `npm install` → 用假 `ctx` 启动**已安装副本** → 断言 `apiVersion`、键集合、`schemaOk`、`profileOk`、发现器读到 profile、`client/client.js` 与 `cordis.patch.yml` 确实在包里。
- 这是唯一覆盖「包内容」的检查：`exports["./client"]` 缺失、`files` 漏文件、profileRoot 少上溯一层，都会在这里失败。
- Windows 上 `execFileSync('npm.cmd')` 会 `EINVAL`，改为优先 `node <npm-cli.js>`，找不到才退回 `npm` + shell。

### CI 与文档

- CI 矩阵扩到 `ubuntu-latest` / `windows-latest` / `macos-latest` × Node 20/24，新增 `install-smoke` 作业（同矩阵）。
- 新增 `docs/RELEASE.md`：版本号单一来源、四项本地门禁、产物内容核对、三平台真机验收 7 条、提交打标、npm 发布与市场收录、回滚演练、发布后 24 小时清单、三平台差异速查。
- `docs/compatibility.md` 重写：宿主 × 平台矩阵（Windows 真机、Linux/macOS 仅 CI）、CI 作业表、四处平台差异与对应测试、契约清单指向快照测试、实测记录表。
- 测试 82 条 / 18 套件；`check` 24 文件 0 失败；产物 25 文件（含 docs/RELEASE.md）。

## 0.9.0

这一版解决三个「看不见」：重启就归零的流量、只能远程排查的现场、以及代理挂掉时要等应用失败才发现的上游。

### 指标跨重启累计（v9）

- `state.json` 升到 `version: 9`，新增 `metricsTotals`：按路由累计 `requests / bytesIn / bytesOut / errors`，并保留首次计数时间 `since`。
- 监听计数本来随 relay 重建归零，所以每分钟（以及退出时）把**增量**折进总量；`diffMetrics` 是纯函数，计数变小时视为「新一轮基線」而不是负增量，watchdog 重建不会吃掉已计总量。
- `?op=state` 的 `metrics[<id>].totals` 与顶层 `metricsTotals` 同时可用；设置页指标行追加「累计 N 次」。

### 诊断包 `?op=diagnose`

- 一键导出一个可直接发给别人的 JSON：版本、profile 是否识别正确、宿主契约、路由与监听、指标、漂移、暂停、补丁、机器人、最近 20 条审计、`lastError`。
- 服务端负责脱敏：代理 URL 的 userinfo 变成 `***`，机器人行只给 `envVar` 与 `configured`（不再带 `url`），备份路径只留文件名，历史截断到 20 条。设置页「诊断」按钮直接下载 `egress-router-diagnose-<时间>.json`。

### 自定义端点 `config.targets`

```yaml
- id: egress-router
  config:
    proxies:
      clash: http://127.0.0.1:7897
    targets:
      - { id: github, name: GitHub API, host: api.github.com, port: 443 }
```

- 这些端点会出现在「发现到的外连目标」里（徽章「自定义」），可以被 `?op=probe`、`?op=upstream` 检查，但**不可改写**（没有 provider 块，`apply` 返回 `not_patchable`）。
- `host` + `port`、`target: "host:port"`、`url` 三种写法都接受。

### 上游健康 `?op=upstream`

- 对每条活动路由，用该路由自己的代理做一次 TLS 探活（6s 超时），返回 `{ ok, results: [{ id, target, proxy, via, ok, ms, error }] }`。
- 设置页「上游」按钮：全通则提示「上游可达」，否则列出失败路由与错误。需要写意图（`POST` + JSON），避免被随便一个网页触发。

### 其他

- `?op=state` / `?op=diagnose` 增加 `apiVersion: 1`，键数 21 → 24（`+apiVersion`、`+metricsTotals`、`+metrics[*].totals`），`test/api-surface.test.mjs` 同步。
- 新套件 `test/insight.test.mjs`（7 条）：总量累加与 `since`、重复 flush 不重复计数、计数回退、custom 行与 probe、诊断脱敏、upstream 形状与写意图。
- 测试 75 → 82 条 + API 快照。
## 0.8.0

把「坏了但没人知道」的四处补上，并让设置页在宿主变化时不再静默消失。

### 可靠性

- **监听自愈（R1）**：监听器不再只被创建、不被观察。每个 relay 服务器都有 watchdog，`close` / `error` 都会把状态改成 `ok:false` 并按指数退避重建（`config.relay.recoveryBaseMs`，默认 1000ms；`config.relay.maxRecoveries`，默认 3 次），失败与恢复都进审计（`relay-down` / `relay-recover`）。主动 `stop` 走 `intentional` 集合，不会被误判成崩溃。
- **错误不再被吞掉（R2）**：22 处静默 `catch {}` 收敛为 `recordError(scope, err)` / `safe(scope, fn, fallback)`。最后一次失败写进 `state.lastError`（设置页可见），同一 scope 每分钟最多一条审计，`recordingError` 防止「写状态失败 → 记错误 → 再写状态」的递归。
- **熔断滑窗（R4）**：原来是「60 秒内 3 次」，只要两次改写间隔 61 秒就永不熔断。现在按 10 分钟滑窗计数，第 1/2/3 次触发分别停 10/30/60 分钟，次数持久化到 `state.reconcileOffenses`，重启不重置。

### 界面

- **刷新不再互相覆盖（R3）**：每次刷新带序号，旧响应直接丢弃；`AbortController` 取消上一轮；apply/rollback/端口检查等突发刷新合并为一次 150ms 去抖请求。
- **写操作互斥（U1）**：任一次写入进行中，所有写按钮 `disabled`，避免二次点击产生冲突写入与重复审计。
- **无障碍（U2）**：根节点 `role=region` + `aria-label` + `aria-busy` 与作用域内 `:focus-visible` 焦点环；标题是 `heading/aria-level=2`；结果区 `role=status aria-live=polite`；警告与漂移提示 `role=alert`。
- **文案接线（U3）**：`botLaunchHint` 真正显示在应用结果里（说明只在本会话生效、长期生效请设 OS 环境变量），删掉从未使用的 `botBot`。
- **宿主契约探测（C2）**：客户端不再假设 `window.__ModuleLoader__` 存在；缺失时打印明确错误而不是整个模块抛异常消失。

### API

- `?op=state` 新增 `lastError` 与 `clientContract`（loader 入口、槽位名、bundle 导出、`dsh.client` 声明），键数 19 → 21，`test/api-surface.test.mjs` 同步。
- 新增 `test/reliability.test.mjs`（5 条）：watchdog 重建、`recordError` 落盘与去重、滑窗与逐级暂停、`.env` 写保护、客户端 loader/序号/aria 静态断言。

## 0.7.3

修一个让整页看起来「空」的目录识别错误。

- `findProfileRoot` 以前把「目录里有 cordis.patch.yml」当作 profile 标记，而本插件自己的包里就带一个同名文件，于是向上查找在 `node_modules/dsh-egress-router` 就停了。
- 后果：发现层读不到 profile 的 `cordis.patch.yml`，外连目标永远显示 0 项；补丁检查去 `<插件目录>/node_modules/@xmanrui/dsh-im` 找包，报「未安装」。
- 现在只认 `package.json` 里的 `dsh.profile`；再加一路兜底：哪个目录 `dependencies` 里依赖本插件，哪个就是 profile。
- `?op=state` 新增 `profileOk`；为 false 时设置页顶部直接说明「插件找错目录了」，不再是静默的空列表（API 快照同步更新）。
- 顺手修掉常驻的「正在加载…」：`refreshAll()` 成功/失败后都会清掉这条提示。
- 测试：新增 profile 识别用例（插件自带 patch 不得被当成 profile；无 dsh.profile 时按依赖兜底），总 99 条。
## 0.7.2

**修正 0.7.0 引入的启动崩溃**：0.7.0/0.7.1 把 `DSH_TELEGRAM_PROXY` 写进 `$DSH_HOME/.env`，
而 DSH 启动器只允许「启动环境」设置这类变量，读到就拒绝启动——桌面版与 `dsh web` 同时无法启动。

- 不再写 `.env`：机器人代理只注入 `process.env`（当前会话生效）并记录在 `state.bots`，启动时由插件重新注入。
- 自动修复：启动时调用 `cleanupManagedEnv()`，删掉 0.7.0/0.7.1 写下的受管块与残留的 `DSH_TELEGRAM_PROXY=` 行，别的内容一字不动；`history` 记一条 `env-cleanup`。
- 设置页提示改为「本会话生效」，并说明启动前生效要设操作系统环境变量（附 Windows/Linux 命令），不要写进 `.env`。
- 文档同步：README / README.en / docs/install / docs/rollback / docs/compatibility 全部改写，删除「受管块」说法。
- 测试 108 条：bots 增加 3 条（应用后 `.env` 字节不变、毒块被清除且只清我们写的行、干净 `.env` 原样保留）。

## 0.7.1

跨平台与可读性：装得上、看得懂、坏了能定位。

- **profile 根目录上溯**：`findProfileRoot()` 从插件目录向上找「含 `cordis.patch.yml` 或 `dsh.profile`」的目录，替代数 `..` 的写法——hoisted 与 pnpm `.pnpm/<pkg>@<ver>` 两种布局、Windows 与 Linux 都能定位。
- **运行环境入库**：契约探测同时记录 `hostEnv`（platform / arch / node），报兼容性问题时不再靠猜。
- **契约降级可见**：宿主不接受任何注册形状时，设置页顶部显示红条与原因（中英双语），而不是静默 404。
- **安装文档**：新增 `docs/install.md`（前置条件、Windows / Linux 安装、自检、升级、卸载、安装期故障表）。
- **兼容矩阵补平台维度**：Windows 实测、Linux CI only，并写清三处平台差异（布局 / 文件名 / 换行）。
- **测试 105 条**：新增 `test/host-contract.test.mjs`（4 条：上溯定位、plain、positional、全不接受时降级）与 `test/platform.test.mjs`（3 条：备份文件名合法、状态文件 LF、受管 `.env` LF 且不重复）。
- **README 重写**：从按版本堆叠的变更记录改为可读文档（为什么、做什么、原理、安装、上手、界面、配置、API、故障排查、兼容、安全、限制、开发、版本表），中英两份同步。

## 0.7.0

发布准备：让「换一个宿主版本还敢不敢装」有可执行的答案。

- 宿主契约探测（H4）：`webServer.register` 三种形状依次尝试，结果写入 `state.hostContract` 与历史；客户端在缺少 `slots.inject` 时退回直接 `register`；全不接受时显式降级（插件仍加载，仅设置页无 API）。
- API 快照测试：`test/api-surface.test.mjs` 锁定 `?op=state` 的 18 个键与 6 个错误码。
- 发布门禁：`scripts/check-syntax.mjs`（19 个文件）、`scripts/check-package.mjs`（必备/禁入文件、2MB 体积上限）、`scripts/version.mjs`（版本号在 README 与 CHANGELOG 中都有记录）。
- CI：`.github/workflows/ci.yml`，Windows/Linux × Node 20/24 跑 check、test、打包门禁。
- 包元数据（H1）：去掉 `private`，补 `author` / `repository` / `homepage` / `bugs` / `publishConfig`。
- 文档：`docs/compatibility.md`（支持矩阵、契约、降级、升级清单）、`docs/rollback.md`（分类回滚、备份位置、卸载与验证）。
- 状态字段新增 `hostContract`（schemaVersion 仍为 1）。测试 98 条。

## 0.6.0

上一版体检列出的 P1 问题逐条收尾，界面与行为都能自解释：

- bot 代理持久化（H5）：除 `process.env` 外再写 `$DSH_HOME/.env` 的托管块，宿主下次启动时读得到；清除时同时移除该块，不动用户的其它行。
- 客户端错误体（H6）：先读 `res.text()` 再解析，404 空体不再把 `Unexpected end of JSON input` 抛给用户，而是提示「插件接口返回空响应（HTTP 404）」。
- 缺失端点可补（H11）：`stale` 行多出「原始地址」输入框，填 `https://…` 后应用即可按新地址重建中转并记录 origin，不再是死局。
- 熔断可观测（H12）：暂停窗口写入 `state.reconcilePaused`，重启后仍生效，页面顶部显示「已暂停至 …」。
- 文案接线（H7）：无流量显示「暂无流量」，已路由行显示「直连 / 经 clash」，预检显示端口是否空闲。
- 状态 v8：新增 `schemaVersion`（状态文档的对外形状版本）与 `reconcilePaused`。
- 测试 97 条（新增 comfort 4 条：`.env` 托管块、暂停落盘与清除、显式 origin、客户端空响应）。
## 0.5.6

补上回环地址的兜底恢复：provider 被留在 `127.0.0.1:<port>`、本地又没有原始地址的记录时，
以前只能报「restore its baseURL by hand」并卡死；现在按内置的已知公网端点兜底。

- `lib/patcher.js` 新增 `DEFAULT_ORIGINS`（openrouter / gemini / moonshot / deepseek），
  `knownOriginTarget()` 在路由与备份都没有记录时使用它，于是发现层能给出正确的 target，
  「应用」可以直接重建路由。
- 测试 93 条（loopback-recovery 新增 1 条：无记录时仍能恢复 openrouter.ai:443）。
## 0.5.5

修掉「配置文件被反复改写」的两个来源。

- 监视器不再使用启动时的路由快照：每轮从 `state.routes` 重新读取。已经撤销的路由
  不会再被写回 `cordis.patch.yml`（此前撤销 openrouter 后仍被强制改回 127.0.0.1:8791）。
- 熔断：同一个 provider 在 60 秒内被修复 3 次后暂停 10 分钟，并在历史里记一条
  `reconcile-paused`。DSH 宿主自己也在写 `baseURL` 时，两边不会无限互抢。
- `findDrift`/`repairDrift` 的 `routes` 参数改为可选，缺省读实时状态；测试 92 条。
## 0.5.4

撤销之后再点应用，不再报 `refusing to route a private or loopback target`。

- 现象：撤销 OpenRouter 的配置后重新应用，报错 `refusing to route a private or loopback target: 127.0.0.1:8791`。
- 根因：撤销恢复的是「那一次应用之前的文件快照」。如果这个 provider 之前已经应用过，
  快照里的 `baseURL` 本身就是 `http://127.0.0.1:8791/...`；恢复后路由被移除，
  provider 于是指向一个没人监听的中转，发现层又把这个回环地址当成目标。
- 修法一：应用时把**首次应用前的真实地址**记进路由与账本（`originBaseURL`）。
- 修法二：撤销后若恢复出的仍是回环地址、而账本知道真实地址，就外科改写回真实地址，
  历史详情标注「back to the real endpoint」。
- 修法三：应用遇到回环目标时先查账本，能查到就自动换成真实目标（`openrouter.ai:443`），
  查不到才 400，并给出可操作的提示。
- 修法四：发现层对「指向已撤销中转」的行标 `stale`，界面显示「中转已撤销」徽章，目标列显示真实地址。
- 测试：新增 `test/loopback-recovery.test.mjs` 3 条（撤销跨过重复应用、账本记住真实端点、
  悬空回环行被标记）。
## 0.5.3

点「应用」之后界面不再说谎。

- 现象一：应用成功，行的「已路由 / 运行中」徽章和端口仍是旧值，要再点一次「扫描」才更新。
  原因：`apply` 之后只刷新了 `state`，而表格的行数据来自 `discover`。
- 现象二：打开设置页先看到「还没有发现目标」，看起来像配置丢了——同样因为挂载时只拉了 `state`。
- 修法：新增 `refreshAll()` 并行拉 `state` + `discover`；挂载、应用、回滚、机器人应用、
  补丁操作、端口检查、修复配置之后都走它（变更后的刷新是静默的，不覆盖当前提示）。
- 测试：`test/client.test.mjs` 新增一条——挂载时必须同时请求 `op=state` 与 `op=discover`。
## 0.5.2

修一个会把设置页弄成「接口不可用」的回归。

- 现象：安装新版本后，宿主热重载插件，设置页所有请求返回 404 空体，前端报
  `Failed to execute 'json' on 'Response': Unexpected end of JSON input`。
- 根因：0.4.1 的「第二个实例让位」策略假定旧实例还活着。宿主热重载是「先激活新实例、
  再拆旧上下文」，新实例看到旧实例还占着标记就直接返回，旧上下文随后被拆掉，
  进程里既没有监听归属、也没有 HTTP 路由。
- 修法：新实例改为**接管**——先 `dispose()` 旧实例（幂等，`stopping` 缓存），再注册自己的
  监听与路由，历史记 `replace-instance`。
- 测试：`test/hardening.test.mjs` 的重复激活用例改为接管语义（新实例注册成功、
  端口只归属一个实例、旧 `duplicate-instance` 不再出现）。
## 0.5.1

修掉一个会静默失效的问题：宿主自己会重写 `cordis.patch.yml`（改设置、切模型、重启时保存），
它不知道我们把 `baseURL` 指到了本机端口，于是又写回公共域名——监听还在新端口上，模型却去打旧端口，
表现就是「Gemini 端口报错」。

- 新增 `lib/reconcile.js`：对比配置文件里的 `baseURL` 与运行中的路由，只修自己改过的 provider。
- 启动时修一次；运行期用 `fs.watch` 盯着配置文件，宿主一改写就修回来（写入后 1.5 秒冷却，避免自己触发自己）。
- 修复走外科改写（只动 `baseURL` 一行）、写前备份、写后重新解析并逐项校验，失败自动还原备份。
- 审计：`reconcile` 记录包含 `provider: 改前 -> 改后 (原因)`。
- API：`?op=reconcile`（同源 POST）、`?op=state` 增加 `drift` / `missing`。
- 界面：顶部黄色提示条列出不一致项，配「修复配置」按钮；一致时不显示。
- 测试 86 条（新增 reconcile 9 条：检测、外科修复、备份、审计、幂等、缺失 provider、停用路由）。
## 0.5.0

聊天机器人不再只有一句「需手动处理」。Telegram 这一行现在和模型行一样可操作：
选一个代理，点「用这个代理」，插件负责把补丁放到位并把环境变量写进当前进程。

- 新增 `lib/bots.js`：机器人目标声明为「补丁 + 环境变量」的一对（telegram-proxy + `DSH_TELEGRAM_PROXY`）。
- `?op=bot`（POST `{ id, proxy }`，空串表示回到补丁内置默认）：先确保补丁在位，再设置环境变量，并写入 `state.bots`。
- 启动恢复：`restoreBots()` 在机器人建连之前把已配置的代理重新注入本进程，重装插件不会悄悄退回默认。
- 界面：机器人行显示「补丁状态 · 当前代理」，可下拉换代理；中英双语。
- 状态 v7：新增 `bots` 字段（`id -> { proxy, url, updatedAt }`）。
- 安全：机器人行同样只接受 POST + `application/json`；`isTrustedWrite` 补上「带外来 Origin 却无 Host 头」的拒绝分支。
- 测试 77 条：新增 7 条（补丁 pending/applied、环境变量写入、未知代理不落盘、清除、未知 bot 404、启动恢复、API 与跨源 403）。
## 0.4.4

每行可以自己选代理了：以前代理只能靠 `cordis.patch.yml` 里的默认值决定，界面没有任何入口，
于是新加的路由一律直连（例如 openrouter 直连时 Claude/GPT 会被地区限制挡住）。

- 每行新增代理下拉：`直连` + `config.proxies` 里的每个名字（当前是 `clash`）。选项运行时从配置读出，新增代理无需改插件。
- 语义分三种：选了具体代理 → 写入 `proxy`；选 `直连` → 显式清空；**完全不传**该字段 → 保留原值（重新应用不会把在线路由悄悄降级成直连）。
- 修掉一个真 bug：`planApply()` 的默认参数 `proxy = null` 把「没传」和「显式清空」混为一谈，导致不带 proxy 的重新应用会把已存代理清掉。
- 测试新增 3 条：服务器侧 set / clear / keep 三种语义，客户端渲染出 `select` 且选项为「直连」与 `clash`。总计 70 条通过。
## 0.4.3

端口选择：以前新增一条路由时，端口输入框要么空着（应用直接报 `port 8792 is already in use`），
要么只能自己猜一个。现在可以一键向宿主要一个真正能绑定的端口。

- 新增只读接口 `?op=suggest&itemId=<id>`：从 8791–8888 里挑第一个 **没被本插件其它路由占用、且当前能 bind** 的端口；
  如果这一行已经有端口（配置文件或运行中的监听），原样返回它，重新应用不会把在线路由挪走。
- 端口输入框旁新增「找端口」按钮；应用/预检时如果端口为空，会先自动要一个再继续，并在提示里说明填了哪个。
- 应用失败为 `port_in_use` 时不再只报错，而是自动换成新的空闲端口并提示「再点一次应用」。
- 服务端 `?op=ports` 保留（批量检查），`?op=suggest` 与它共用同一套占用判定。
- 测试：新增 suggest 用例（跳过本插件已占端口、返回端口必须真的能 bind、已有端口原样复用）；总计 68 条通过。
## 0.4.2

界面可读性修复：先前的样式引用了一批**并不存在**的设计 token，取不到值时就落回固定的浅色十六进制颜色，
于是其中一种主题下按钮文字几乎看不见。这次按 DSH 主题包里真实存在的 token 重写。

- 对照 `app.asar` 的别名块逐个核对：`--dsw-alias-label-primary` / `-secondary` / `-tertiary`、
  `--dsw-alias-border-l1..l4`、`--dsw-alias-bg-layer-1/2`、`--dsw-alias-button-elevated-fill`、
  `--dsw-alias-button-primary-fill`、`--dsw-alias-label-primary-foreground`、`--dsw-radius-xs/sm/md/lg`
  （真实值 4/8/12/16，之前用 6/8/12 是猜的）。
- 移除不存在的 `--dsw-alias-label`、`--dsw-alias-hairline`、`--dsw-alias-accent`、`--dsw-font-family-mono`；
  颜色回退改为 `inherit`，不再写死浅色。
- 次要按钮照搬 DSH `.chip` 的几何：高 28px、`.5px` 边框 `border-l4`、`radius-sm`、13px `label-primary` 文字、
  透明底；主按钮用 `button-primary-fill` + `label-primary-foreground`（深色主题下自动变成白底黑字）。
- 输入框改用 `button-elevated-fill` + `border-l4`，与设置页表单一致。
- 徽章文字用 `color-mix(... 55%, label-primary)`，保证白色与深色底上都够清楚。
- `preview/harness.html` 改为加载**真实的明暗两套 token 值**，可截图核对：
  `preview/harness-light.png`、`preview/harness-dark.png`。

## 0.4.1

统一检查 0.3.0/0.4.0 后的三项修复，加上设置页视觉对齐：

- **单实例守卫**：`dsh.profile.bundles` 与手工配置条目同时激活本插件时，第二个实例记一条
  `duplicate-instance` 后直接退出，不再抢端口、不再留下 `ok:false` 的幽灵行。
- **审计去重**：同一 `op` + 同一结果在 60 秒内重复出现只保留一条（此前一次启动写了 10 条
  `start … (down)`）。
- **退出落盘指标**：`dispose` 时把内存计数器写入 `state.metrics`，重启后设置页不再从 0 开始。
- **测试文案**：真实测试没拿到 HTTP 状态时显示「已连上但没收到 HTTP 响应」，不再显示 `HTTP —`。
- **界面主题化**：所有样式改用 DSH 的设计 token（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-font-*`），
  跟随浅色/深色主题；按钮统一 28px 高，主按钮、输入框、徽章分层，不再硬编码颜色。
- 测试：67 条全绿（hardening 新增 3 条：审计去重、重复激活退让、退出落盘）。

## 0.1.0

- 首个可用版本：目标发现（配置/`.env`/bundle 默认配置）、直连与代理双路探测、
  逐目标本机端口、改写 `baseURL` 前预览 diff 并备份、失败自动回滚、设置页「出口路由」。
- 转发核心：HTTP CONNECT 隧道 + 可选 TLS、keep-alive 连接复用、`/__health` 探活、
  上游不可达时返回 `502 relay_forward_failed` 且不影响直连目标。

## 0.2.0

正确性与安全修复（对应 REVIEW-0.1.5 的 D1–D4）：

- **路由持久化（D1）**：`apply` 现在同时写 provider 的 `baseURL` 与 `egress-router.config.routes`，
  重启 DSH 后监听自动重建；插件条目缺失时自动创建。写入后重新解析校验两处内容。
- **回滚一致性（D2）**：`rollback` 恢复文件、按 `routeId` 卸载对应监听，状态里不再残留「运行中」。
- **写入鉴权（D3）**：`apply`/`rollback` 只接受同源浏览器请求（`Sec-Fetch-Site: same-origin`
  或 `Origin` 与 `Host` 一致）+ `content-type: application/json`，否则 403；方法必须是 POST。
- **安全写入顺序（D4）**：先校验端口与起监听，再写文件；任一步失败会停监听、恢复文件、
  返回非 2xx，配置文件逐字节不变。
- 错误语义：用户错误 400/409/413/415，找不到 404，服务端异常 500，响应含 `{ error, message }`。
- 保留用户文件开头的注释块；`state.json` 升到 version 2，记录 `history`（最近 50 条）与
  `discovered` 缓存。
- 设置页：不可改写的条目（`im:*`、`cfg:*`、`pkg:*`）不再显示「应用」，显示「需手动处理」；
  失败时展示服务端原因；新增「最近操作」列表。
- 测试：新增 `test/write-safety.test.mjs`（6 条），覆盖持久化、重启重建、回滚卸载、未授权拒绝、
  端口占用零改动、未知 provider 返回 400；全套 18 条通过。


## 0.2.1

架构收口：插件不再把自己插进用户的 `cordis.patch.yml`，路由改由插件自己的状态持有。

- **单实例（P0-1）**：删掉「写 `egress-router.config.routes`」这一路。此前 profile 的
  `bundles` 里已有本插件，配置里再带 `name: dsh-egress-router` 会被当作第二个实例，
  出现两个监听、回滚后留下孤儿端口。现在配置里只需 `- id: egress-router` 做配置覆盖。
- **路由状态化（P0-1 配套）**：路由存 `$DSH_HOME/storages/egress-router/state.json`
  （version 3，含 `routes` / `listeners` / `history` / `backups`）。启动时从状态重建监听；
  首次启动若状态为空而配置里仍有 `routes`，自动迁移一次作为种子。
- **代理不被静默清空（P0-2）**：`apply` 不传 `proxy` 时保留既有代理；只有显式传值才覆盖。
  以前 UI 传 `proxy: null` 会把 `clash` 抹掉，重启后目标变成直连。
- **同端口重新应用（P0-3）**：自己已占用的端口不再判 `port_in_use`；重复点「应用」是幂等的。
- **状态如实呈现（P1-1）**：`state` 同时返回在跑监听与持久化监听，设置页显示真实端口。
- **生效提示（P1-2）**：`apply`/`rollback` 返回 `restartRequired: true`，UI 明说「重启 DSH 后生效」。
- **按项回滚（P1-4）**：已路由的行多了「撤销」，按 `routeId` 精确回滚并停掉该监听。
- **受保护域名折叠（P2-1）**：`platform.deepseek.com` 等不再逐行铺开，折叠成一行数量与名单。
- 测试：23 条（patcher 7 / write-safety 9 / relay 2 / discovery 2 / client 2 / plugin 1）。

## 0.2.2

健壮性与安全加固（对应 REVIEW-0.2.1 的 R1–R16）：

- **状态版本（R1）**：`state.json` 升到 version 4，`writeState` 始终写入当前版本号；
  `readState` 向前迁移并回写，旧文件不会再被当成新格式（此前 0.2.1 写入仍是 `version: 2`）。
- **单一事务（R2）**：apply 的路由、监听与审计合并为一次落盘（`saveRoutesAndListeners`），
  失败路径也写一次，崩溃不会留下「baseURL 指向没人监听的端口」。
- **回滚防覆盖（R3）**：备份记录 `sha256Before/sha256After`；若文件在 apply 之后被手动改过，
  `rollback` 返回 `409 file_changed_since_backup`，需显式 `force: true` 才覆盖。
- **探测面收敛（R4/R10）**：`probe` 与写操作同源鉴权；拒绝私有/环回目标（`private_target`）、
  只接受扫描结果里出现过的目标（`unknown_target`）；未命名代理时回落到 `defaultProxy`（首个代理），
  代理名不存在返回 `400 unknown_proxy`。
- **不再残留幽灵状态（R5）**：起监听失败的路由在路由消失时一并清除状态。
- **外科式写入（R6）**：只替换 provider 块里的 `baseURL` 行，保留注释、锚点与别名；
  无法识别时才整份重写（响应里 `format` 区分 `surgical` / `rewritten`）。
- **连接复用（R7）**：正常结束后不再销毁上游请求，keep-alive 真正生效（两个请求只开一次 CONNECT）。
- **TLS 握手超时（R8）**：隧道通了但 TLS 卡住时按 `timeoutMs` 失败（`tls_handshake_timeout`），
  不再等系统默认的两分钟。
- **应用即验证（R9）**：apply 后由 relay 侧探活，目标不可达则回滚并返回 `502 apply_unverified`。
- **备份账本（R14）**：备份文件与账本同步裁剪（各 20 份），不再无限增长。
- 测试：40 条（新增 `test/hardening.test.mjs` 17 条）。

## 0.2.3

修复桌面版设置页无法应用（0.2.2 的鉴权过严）：

- **问题**：桌面 GUI 的文档源是 `dsh-app://app`，设置页的 `fetch('/plugins/egress-router')`
  经 shell 转发到本机路由后，`Origin` 是自定义 scheme（或缺失），永远不会等于请求的 `Host`，
  于是 0.2.2 的 `Origin === Host` 判定把**真实设置页**也挡成 `403 unauthorized`。
- **修复**：写入与探测的 CSRF 边界改为「POST + `content-type: application/json`」，
  并额外拒绝明确来自外来 `http(s)` Origin 的请求；接受缺失 Origin、`null`、
  `dsh-app://`、`file:` 与同源/本机回环来源。
- **为什么仍然安全**：跨源带 `application/json` 的 `fetch` 会先发 CORS 预检，本路由从不回
  `Access-Control-*`，浏览器在发送前就拦下；HTML 表单无法伪造该 content-type。本机原生进程
  本来就能直接改文件，头校验从未能防住它。
- 测试：41 条（write-safety 改为「外来 Origin 被拒」，hardening 新增「接受 `dsh-app://app`」）。

## 0.2.4

降低「慢节点被误判成目标不可达」的概率：

- **验证预算放宽**：apply 后的自检从 `5s / 1 次` 改为 `12s / 最多 3 次`（`lib/probe.js` 与
  `lib/routes.js` 的调用参数同步）。代理节点在 1–6 秒间波动时不再动辄回滚。
- **错误可见**：应用失败时设置页会把服务端的具体原因（如
  `Client network socket disconnected...`）显示出来，而不是只给一句固定文案。
- **写请求超时**：设置页的 `fetch` 从 20s 提到 90s，避免服务端仍在验证时前端先报超时。
- 测试：42 条（新增「验证参数为 12s + 2 次重试」一条）。

## 0.3.0

可观测与可配置（对应 0.3.0 需求）：

- **每路由指标**：relay 侧统计 `requests`/`bytesIn`/`bytesOut`/`errors`/`statuses`/`ttfb`，
  `?op=state` 返回 `p50`/`p95`/`samples`（保留最近 200 个样本，重启后计数继续累积在
  `state.json` 的 `metrics` 里）。
- **真实测试**：新增 `?op=test`，经运行中的监听发一次 `HEAD`（`path` 可传），返回状态码与毫秒数。
- **HTTP 层探活**：`probeOnce({ http: true })` 在 TLS 之后读一次状态行；应用自检改用它，
  连接被重置的目标不再被判成可达。
- **预检**：新增 `?op=plan`，返回 diff、端口感与警告，不落任何写入。
- **端口批量预检**：新增 `?op=ports`，返回 `{ ports: { "8792": true } }`。
- **连接参数**：路由支持 `maxSockets`/`timeoutMs`/`connectTimeoutMs`，越界返回 400 `invalid_tuning`。
- **前端**：指标行、预检 diff、「测试」按钮、批量端口检查、高级参数输入、中英双语。
- **状态版本 5**：`metrics` 与路由同文件；旧状态自动升级。
- 测试：新增 `test/observability.test.mjs`（10 条），全套 52 条通过。

## 0.4.0

声明式兼容补丁（0.4.0 主题：把「改别的插件」变成可声明、可修复、可撤销的能力）：

- `patches/definitions.json`：每个补丁声明 `package` / `versions` / `file` / `find` / `replace` / `marker`。
  内置 `telegram-proxy`（`@xmanrui/dsh-im` 5.x 的 Telegram 传输绑定本地代理）。
- `lib/patches.js`：`inspect`（只看磁盘状态）、`applyPatch`（单锚点、原子替换、保留原始备份与 sha256）、
  `revertPatch`（按备份逐字节还原）、`repairAll`（启动时只修复账本里记录过的补丁）。
  锚点出现 0 次返回 `anchor_missing`、多于 1 次返回 `anchor_ambiguous`，一律不改。
- API：`GET ?op=patches`、`POST ?op=patch {id, action: apply|revert|verify}`，与 apply 同样的同源校验。
- 设置页新增「兼容补丁」区块：状态徽章、应用、复原、重新检查；由 pnpm patch 提供的补丁显示为只读。
- 状态版本 6：新增 `patches` 账本；旧状态自动升级。
- 重装/升级把补丁冲掉时，下次启动自动修复并写一条 `patch-repair` 历史。
- 测试：新增 `test/patches.test.mjs`（12 条），全套 64 条通过。

