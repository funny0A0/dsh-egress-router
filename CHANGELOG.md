# Changelog

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
