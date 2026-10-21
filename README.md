# dsh-egress-router

给 DSH 里**单个外连目标**开一个本机端口，请求经它中转；没开端口的目标继续直连。

DSH 的传输策略是「每个进程只有一个答案」（`@deepseek-ai/dsh-http-proxy` 的设计），
所以设了 `HTTPS_PROXY` 就是全进程走代理——代理一挂，账号、插件市场、pnpm 全挂。
本插件把「走代理」从进程级降到目标级：只有你点名的那几个域名经中转，其余照旧直连。

```
DSH 插件 ──baseURL──▶ 127.0.0.1:8791 ──CONNECT/TLS──▶ 上游代理(可选) ──▶ 目标
                        （每目标一个端口，独立开关）
```

## 组成

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：启动已配置的监听端口，挂载 `/plugins/egress-router` 接口，注册设置页 |
| `lib/manager.js` | 端口生命周期（start/stop/sync），每个路由一个监听器，绑定 127.0.0.1 |
| `lib/relay.js` | 转发核心：CONNECT 隧道 + 可选 TLS，keep-alive 复用连接；`/__health` 探活 |
| `lib/discovery/index.js` | 只读发现：从 `cordis.patch.yml`、`.env`、已装 bundle 默认配置里找工作区外的外连目标 |
| `lib/patcher.js` | 改配置：预览 diff → 备份 → 原子写 → YAML 校验，失败自动回滚 |
| `lib/routes.js` | 设置页用的 JSON 接口（`?op=state|discover|probe|apply|rollback`） |
| `client/client.js` | 设置页「出口路由」标签页 |

## 安装（本地私有）

```powershell
cd C:\Users\<你>\.dsh\profiles\desktop
pnpm add file:F:\projects_all\AI_projects\dsh-egress-router
```

然后在 `package.json` 的 `dsh.profile.bundles` 里加上 `dsh-egress-router`，重启 DSH。

## 用法

设置 → 插件 → **出口路由**：

1. 点「扫描」：列出模型 provider、Telegram、以及配置里出现的其它 https 目标（标「待确认」的需自己判断）。
2. 点「检查」：同一目标分别试直连和经代理，告诉你哪个通、耗时多少。
3. 填端口（建议 8791 起，插件会提示占用），点「应用」：自动改写该 provider 的 `baseURL` 到
   `http://127.0.0.1:<端口><原路径>`，并立即起监听。
4. 改错了点「回滚上次改动」：从备份恢复 `cordis.patch.yml` 并停掉对应端口。

配置也可以手写在 `cordis.patch.yml`：

```yaml
- id: egress-router
  name: dsh-egress-router
  config:
    proxies:
      clash: http://127.0.0.1:7897
    routes:
      - id: llm:gemini
        target: generativelanguage.googleapis.com:443
        listenPort: 8791
        proxy: clash
      - id: im:telegram
        target: api.telegram.org:443
        listenPort: 8792
        proxy: clash
```

## 安全边界

- 只监听 `127.0.0.1`，不对外开端口。
- `platform.deepseek.com`、`api.deepseek.com`、`registry.npmjs.org`、插件市场目录源等**受保护目标**在 UI 里只展示不建议改——它们是账号、装插件、看市场的命脉，走中转只会扩大故障面。
- 每次改配置前备份到 `$DSH_HOME/storages/egress-router/backups/`，写入后重新 parse 校验，失败自动还原。
- 中转进程挂了只影响开了端口的目标；直连目标不受影响（这正是相对全局代理的改进）。

## 已知限制

- 改不了**别的插件进程内部**的请求（比如 `@xmanrui/dsh-im` 的 HTTP 客户端用的是环境代理）；这类目标需要插件自己暴露端点，或继续用插件自带的代理配置。
- 只支持 HTTP/1.1 转发，不支持 HTTP/2 明文升级、SOCKS、PAC。
- 上游代理目前只支持 `http://host:port` 形式（CONNECT 隧道）。

## 卸载

```powershell
cd C:\Users\<你>\.dsh\profiles\desktop
pnpm remove dsh-egress-router
```

并从 `dsh.profile.bundles` 删掉，重启。已改写的 `baseURL` 请先用「回滚」恢复，或手工改回原地址。

## 0.2.0 的行为约定（重要）

- **写入是持久的**：点「应用」会同时改 provider 的 `baseURL` 和插件自己的 `routes`，
  重启 DSH 后监听自动重建，不需要再手动改文件。
- **写入需要同源**：只有设置页里的请求（`Sec-Fetch-Site: same-origin`，或 `Origin` 与 `Host` 一致）
  才能 `apply`/`rollback`；本机脚本直接调接口会得到 `403 unauthorized`。
- **失败不改配置**：端口被占、监听起不来、写入校验失败时，会撤掉监听并把文件恢复原样，
  返回非 2xx 与原因。
- **只有 `llm:*` 可改写**：`im:telegram`、`cfg:*` 这类没有可改 `baseURL` 的目标只做提示，
  需要在对应插件里改（例如 `dsh-im` 的 Telegram 代理用 `pnpm patch`）。
## 开发

```powershell
node test\run-all.mjs
```

`node --test` 在 DSH 沙箱里会因 worker 进程 `spawn EPERM` 失败，所以用自带 runner（逐文件在进程内跑）。
测试覆盖：转发与 502 降级、发现规则、配置改写与回滚、插件装配、客户端 bundle 装配。

## 0.2.1 的配置形态（重要）

插件**不会**把自己的配置写进 `cordis.patch.yml`。路由存在
`$DSH_HOME/storages/egress-router/state.json`；配置里最多留一条覆盖项：

```yaml
- id: egress-router
  config:
    proxies:
      clash: http://127.0.0.1:7897
```

不要再写 `name: dsh-egress-router`：`bundles` 里已加载本插件，再写 `name` 会被当成第二个实例。

## 0.2.2 的行为变化（重要）

- **应用后自检**：点「应用」会先起监听，再用同一条代理链路连一次目标；连不上就自动回滚，
  界面显示 `apply_unverified` 的原因。代理没开时不会再「看起来成功、用起来失败」。
- **回滚会拒绝覆盖手改**：如果 apply 之后你自己编辑过 `cordis.patch.yml`，回滚返回
  `file_changed_since_backup`（HTTP 409），确认要覆盖时传 `force`。
- **只动一行**：`baseURL` 的改写保留文件里的注释、锚点与别名；写不进去时才退回整份重写。
- **探测只测你见过的目标**：`probe` 不再接受任意地址，私有地址和未扫描到的域名一律 400。
- **状态版本 4**：`state.json` 里 `backups` 带两个文件的 SHA-256，`routes`/`listeners`/`history`
  仍在同一文件里；旧版本状态会在首次读取时自动升级。

## 0.2.3 的修复（重要）

- **桌面版可以点「应用」了**：桌面 GUI 的页面源是 `dsh-app://app`，请求经 shell 转发后
  `Origin` 不等于本机 `Host`，0.2.2 的同源判定会误伤。现在写入只要求
  `POST` + `content-type: application/json`，并拒绝明确来自外来 `http(s)` Origin 的请求。
- **安全含义未变**：跨源 JSON 请求需要 CORS 预检，而本路由不返回任何 `Access-Control-*`，
  浏览器会在发出前拦截；本机进程本来就能直接改配置文件，头校验不是防它的手段。
## 0.2.4 的调整

- **自检更宽容**：应用后的探测超时 12s、最多重试 2 次（原 5s / 1 次）。代理节点只是慢时不会再被
  判成「目标连不上」而回滚。
- **失败原因可见**：失败提示后面会带上服务端返回的具体错误，便于区分「节点慢」「节点挂了」
  「目标域名错」。
- **前端等待 90s**：写请求不再在 20s 就报超时，避免服务端还在验证时前端先放弃。
## 0.5.6 的变化

provider 的 `baseURL` 停在回环端口、而本地没有原始地址记录时，按内置的已知端点兜底
（openrouter / gemini / moonshot / deepseek），不再卡在「请手动恢复」。

## 0.5.5 的变化

监视器改为每轮读取 `state.routes`，撤销过的路由不会再被写回配置；同一 provider 在 60 秒内
修复 3 次后自动暂停 10 分钟（`reconcile-paused`），避免和宿主互抢。

## 0.5.0 的变化

聊天机器人（Telegram）不再只能点「检查」：这一行有代理下拉和「用这个代理」，背后是
`lib/bots.js` 的「补丁 + 环境变量」组合，选择会存进 `state.bots` 并在下次启动时自动恢复。

0.4.4 — 每行代理选择器：直连 / clash 可选，选项来自 `config.proxies`，显式直连会清空代理。0.5.0 — 机器人代理接管：Telegram 行可选代理并自动应用补丁，状态 v7。
0.5.1 — 配置自愈：`cordis.patch.yml` 与运行路由漂移时自动修复，页面显示黄条。
0.5.2 — 热重载接管：宿主重载插件时新实例先拆掉旧实例，不再出现「无路由」的 404。
0.5.3 — 应用/回滚后同时刷新状态与发现列表，不再需要手动「扫描」。
0.5.4 — 回环恢复：撤销后重应用自动取回真实端点，悬空回环行标记「中转已撤销」。
0.5.5 — 监视器读实时路由 + 熔断，已删除的路由不会被写回。
0.5.6 — 内置端点兜底（openrouter/gemini/moonshot/deepseek），缺失端点也能重建。
0.6.0 — 舒适度：bot 代理写 `.env`、空响应可读、原始地址可补、暂停落盘可见、文案接线。
0.7.0 — 发布准备：宿主契约探测与兼容模式、API 快照测试、产物门禁、CI、发布/回滚文档、包元数据。
0.5.0 — 机器人代理接管：Telegram 行可选代理并自动应用补丁，状态 v7。
0.5.1 — 配置自愈：检测并修复「配置文件指向旧端口」的漂移，启动与运行期都会校正。
0.5.2 — 热重载接管：新实例先关旧实例再注册，修复设置页 404 空体（接口不可用）。
0.5.3 — 应用/回滚后自动刷新行数据（含挂载时），不必再手动点「扫描」。
0.5.4 — 撤销不再把 provider 留在一个已移除的中转上：记录原始端点、撤销后自动回填、悬空行标「中转已撤销」。

## 0.3.0 的变化（可观测与开关）

- **每条路由的实时指标**：请求数、上/下行字节、失败数、状态码分布、首字节延迟 p50/p95，
  直接显示在设置页每行下面（跟着 `?op=state` 一起返回）。
- **真实测试按钮**：点「测试」会让 relay 真发一次 `HEAD`（默认 `/`，可在高级里改），
  返回 HTTP 状态与耗时；以前只能测到 TLS 握手。
- **HTTP 层探活**：应用后的自检现在会读 HTTP 状态码，`connect ok` 但随即被重置的连接
  不会再被当成成功。
- **预检（Plan）**：`?op=plan` 只算 diff、端口占用与警告，不写任何文件；设置页里「应用」
  之前先看 diff 再决定。
- **端口批量预检**：`?op=ports&port=...&port=...` 一次返回哪些端口可绑，避免逐个试。
- **连接参数可调**：每条路由可设 `maxSockets`（1–64）、`timeoutMs`（1s–10min）、
  `connectTimeoutMs`（1s–2min）；默认 6 / 90s / 12s，超出范围返回 `invalid_tuning`。
- **界面中英双语**：按浏览器语言自动选 zh/en。

## 兼容性与契约探测（0.7.0）

宿主没有公开的插件契约，而且变过。这一版不再靠版本号猜：

- 注册端点时依次尝试 `{kind:"exact"}` → `{path, handler}` → 位置参数，并把结果记进 `state.hostContract` 与历史。
- 槽位没有 `inject` 时退回按名字 `register`，控制台会说明处于兼容模式。
- 全部形状都不被接受时插件仍然加载（监听与状态照常），只是设置页没有 API——这是**显式降级**，不是静默 404。
- `?op=state` 的键集合与错误码由 `test/api-surface.test.mjs` 固化，宿主改形状会先让测试红。

矩阵与升级检查清单见 [docs/compatibility.md](docs/compatibility.md)。

## 发布

```powershell
npm run check          # 所有模块 node --check
npm test               # 97 条测试
npm run check:package  # npm pack 产物门禁：必备文件 / 禁入文件 / 体积
npm version             # 校验 package.json 的版本在 README 与 CHANGELOG 里都有记录
npm publish --provenance --access public
git tag v<version> && git push --tags
```

发布前还要做：把实测的宿主版本补进 `dsh.compatibility.dshReleases`；确认 `repository` / `homepage` 与真实仓库一致；在 `awesome-dsh-plugin.com/plugins.json` 与 `dsh-plugin-catalog` 两个市场登记。回滚步骤见 [docs/rollback.md](docs/rollback.md)。

## 版本

0.1.0 — 首个可用版本：发现、探测、逐目标端口、带备份的配置改写与回滚、设置页。
0.2.0 — 正确性修复：路由持久化（重启自动重建）、回滚卸载监听、写入同源鉴权、失败不改配置。
0.2.1 — 单实例化：路由移入插件状态、配置里只留 id 覆盖、代理不被清空、同端口幂等、按项撤销。
0.2.2 — 加固：状态版本化、单事务落盘、回滚防覆盖、探测收敛、连接复用、TLS 超时、应用即验证。
0.2.3 — 修复桌面版设置页被 403 挡住，应用/回滚恢复可用。
0.2.4 — 放宽自检预算（12s/2 次重试）并显示真实失败原因。
0.3.0 — 可观测与开关：实时指标、真实测试、HTTP 层探活、预检 diff、端口批量检查、连接参数可调、中英双语。
0.4.0 — 声明式兼容补丁：锚点唯一性校验、原文件备份、启动时按账本自修复。
0.4.1 — 单实例守卫、重复审计行合并、退出时落盘指标、设置页改用 DSH 设计 token 跟随主题。
0.4.2 — 修正设计 token 名称与取值（明暗主题下按钮/输入框文字均可读），补真实明暗两套界面截图。
0.4.3 — 端口一键检索：新增「找端口」与 `?op=suggest`，应用/预检自动补端口，`port_in_use` 自动换端口。
0.4.4 — 每行代理选择器：直连 / clash 可选，选项来自 `config.proxies`，显式直连会清空代理。

## 0.4.0 兼容补丁

有些插件把外连地址写死在代码里（例如 `dsh-im` 的 Telegram 传输只从进程环境变量取代理），
只改配置无法让它走代理。0.4.0 把这类修改变成声明式补丁：

- 补丁定义在 `patches/definitions.json`，声明包名、支持的版本前缀、文件、锚点与替换文本。
- 应用时要求锚点在文件里**恰好出现一次**，替换是原子的，原始文件备份在
  `storages/egress-router/patches/<id>.bak`。
- 重装或升级把补丁冲掉后，下次启动会按状态里的账本自动修复（只修复你自己应用过的补丁）。
- 设置页「兼容补丁」可以应用、复原、重新检查；由 `pnpm patch` 提供的补丁会显示为只读。
