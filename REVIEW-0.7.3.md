# dsh-egress-router 0.7.3 全面体检报告

体检时间：2026-10-21 09:10（本地）
体检对象：`dsh-egress-router@0.7.3`（仓库 `F:\projects_all\AI_projects\dsh-egress-router`）
运行环境：DSH 桌面版 0.2.1-rc.2 / Windows 11 / Node 24.21.0，宿主 pid 43488，GUI 56588
体检口径：功能、实现、可扩展性、DSH 兼容性、鲁棒性、UI 直观性六维；每条结论都带可复现证据。

---

## 0. 一句话结论

**能用了，也稳了，但「只能围着现有的 llm provider 转」这条天花板没破。**
这一版修掉了让页面看起来是空的目录识别错误之后，功能面没有已知阻塞缺陷；剩下的问题集中在
**可扩展性（5.5/10）** 与 **UI 的自我解释能力（6.5/10）**，以及若干「出错时不出声」的隐性风险。

## 1. 六维评分

| 维度 | 分数 | 一句话判断 |
| --- | --- | --- |
| 功能完整性 | 8.5 | 13 个 op 覆盖发现→探测→预检→应用→自检→回滚→补丁→机器人→自愈，闭环完整；缺「自定义目标」与批量操作 |
| 实现质量 | 8.0 | 分层清楚、原子写、手术式改写、有 API 快照；12 处静默 catch 与 509 行的 routes 是欠账 |
| 可扩展性 | 5.5 | 机器人、内置端点、受保护域名、发现器全部硬编码在代码里，加一个要改代码发版 |
| DSH 兼容性 | 8.0 | 契约三形状探测 + 降级 + hostContract/hostEnv 落盘；只声明一个宿主版本，客户端 loader 无探测 |
| 鲁棒性 | 7.0 | 应用即验证、失败回滚、单例接管、漂移熔断；缺监听 watchdog、无 process 级兜底、客户端有竞态 |
| UI 直观性 | 6.5 | 主题与文案已对齐 DSH，空态与加载态已修；缺 aria、缺禁用态、缺批量、语义有重叠 |

综合 ≈ 7.4 / 10（按功能 25%、实现 20%、兼容 15%、鲁棒 15%、扩展 15%、UI 10% 加权）。

## 2. 运行面体检（实测，不是推断）

| 项 | 结果 |
| --- | --- |
| 安装版本 | 0.7.3，与仓库逐字节一致 |
| `?op=state` | 200，`profileOk=true`，`profileDir=D:\dsh-data\home\profiles\desktop` |
| 契约 | `exact`，`hostEnv=win32/v24.21.0` |
| 路由 | `llm:gemini:8792/clash`、`llm:openrouter:8791/clash` |
| 监听 | 两条均 `ok=true`；`/__health` 均 200 且 `viaProxy=true` |
| 发现 | 9 条：moonshot / gemini / openrouter / telegram + 5 条受保护域名 |
| 补丁 | `telegram-proxy: applied` |
| 漂移 | 0；暂停 0；备份 10 份；历史 10 条 |
| 指标 | `llm:gemini`、`llm:openrouter` 均有计数与 TTFB 分位 |

结论：**当前没有阻塞性缺陷**，下面全部是「下一个版本该补的」。

---

## 3. 问题清单

严重度：P0 会阻塞使用或造成数据损坏；P1 功能缺口或明确隐患；P2 体验与工程债。

### 3.1 可扩展性（本轮最大短板）

**E1（P1）机器人只有 Telegram，且写死在代码里**
证据：`lib/bots.js:73` `export const BOT_TARGETS = { telegram: {...} }`，`:93` `botTarget()` 只查这张表。
影响：接入 WhatsApp / 飞书 / Slack 之类只能改代码 + 发版，用户无法自助。
修法：把 `BOT_TARGETS` 落成 `patches/definitions.json` 的同级数据文件（`bots.json`），插件启动时合并内置表与用户文件；`BOT_TARGETS` 只保留内置兜底。

**E2（P1）内置端点表只有 4 个 provider**
证据：`lib/patcher.js:76` `DEFAULT_ORIGINS`（openrouter / gemini / moonshot / deepseek）。
影响：回环死局兜底只对这四个生效；新 provider 还得手填原始地址。
修法：`DEFAULT_ORIGINS` 从 `cordis.patch.yml` 的 provider `baseURL` 反推（首次应用时记录），内置表退化为「从未记录过」时的最后兜底。

**E3（P2）受保护域名写死在发现层**
证据：`lib/discovery/index.js` 的 `GUARDED` 列表（platform.deepseek.com、api.deepseek.com、registry.npmjs.org、awesome-dsh-plugin.com、dsh-plugin-catalog）。
影响：用户想保护自己的域名没有入口。
修法：`config.guarded` 覆盖内置列表，UI 只展示不可改。

**E4（P1）没有「自定义目标」入口**
证据：`lib/routes.js:514` 的 `apply` 流程要求 `itemId` 能在 `cordis.patch.yml` 里找到对应 provider（`planApply` 的 `provider_not_found`）。
影响：一个把地址写死在代码里的插件（除 Telegram 外）只能手工改文件；「我已经知道该走哪个代理」的场景没有路。
修法：新增 `?op=routes` 的 CRUD：`{id, target, listenPort, proxy, origin?}`，允许创建「仅中转」路由（不改任何 baseURL），UI 提供「手动添加目标」表单；`apply` 仍走发现项，两条路径分开。

**E5（P2）没有插件扩展点**
影响：下游没法注册新的发现器/补丁类型，只能 fork。
修法：`ctx.provide('egress.discovery', ...)` + 启动时收集；先只做「追加发现器」这一种。

### 3.2 鲁棒性

**R1（P1）中转监听没有 watchdog**
证据：`lib/manager.js` 只在 `start` 时处理 `server.on('error')`；`sync` 失败只记状态（`lib/manager.js:47-54`）。
影响：端口被系统回收、server 异常关闭后，`status` 仍显示旧的 ok，只有下一次 apply 才会重建。
修法：每个 server 加 `close`/`error` 监听，异常退出时把该路由标 `down` 并按指数退避重建（上限 3 次），重建结果写 history。

**R2（P1）22 处静默 `catch {}`**
证据：实测 `catch {}` 空块共 22 处——`lib/index.js` 8、`lib/patcher.js` 4、`lib/store.js` 4、`lib/patches.js` 2、`lib/reconcile.js` 2、`lib/routes.js` 2。
影响：磁盘满、权限、YAML 异常全部无声消失，出问题时没有线索。
修法：统一 `safe(fn, onError)` 包装，把错误写进 `state.lastError` 与 history；至少 `log()` 一条。

**R3（P1）客户端请求有竞态、无取消**
证据：`client/client.js:508` `refreshAll()` 并发调用（挂载、应用后、回滚后都会触发），无请求序号、无 `AbortController`；`useEffect` 只 1 处、`useMemo/useCallback` 为 0。
影响：慢响应后到会覆盖新数据，出现「刚应用完又显示未路由」。
修法：模块级 `seq`，只接受最新一次响应；卸载时 abort；`refreshAll` 加 200ms 去抖。

**R4（P2）漂移熔断可被低频改写绕过**
证据：`lib/reconcile.js` 的暂停窗口按「60 秒内 3 次」计数。
影响：外部每 61 秒改一次就永远不会暂停，日志无限增长。
修法：计数改成滑窗 + 指数退避（第 3 次暂停 10 分钟，第 5 次 1 小时）。

**R5（P2）状态文件无并发写保护、无上限**
证据：`lib/store.js:112-114` 是 `写 tmp → rename`（原子，好），但没有锁；`routes`、`metrics` 无条数上限（history 50、backups 20 有）。
影响：极端情况下最后写入者覆盖；metrics 的 id 只增不减。
修法：`rename` 前 `flock` 语义（Windows 用 `wx` + 重试），metrics 只保留最近 50 个路由键。

**R6（P2）无 process 级兜底**
证据：`lib/*.js` 无 `process.on('unhandledRejection' | 'uncaughtException')`。
影响：宿主会兜，但插件侧丢上下文。
修法：记录一次 `lastError` + `history`，不吞掉退出。

### 3.3 UI 直观性

**U1（P1）busy 时按钮不禁用**
证据：`client/client.js` 全文只有 1 处 `disabled:`（共 6 个 `key:`）。
影响：应用/回滚可被连点两次，产生两条冲突的写入与两条 history。
修法：`busy` 状态下所有写按钮 `disabled` + `aria-busy`。

**U2（P1）零可访问性**
证据：`aria-*` 出现 0 次，`role:` 0 次。
影响：键盘与读屏用户无法操作；也违反 DSH 自身组件的惯例（宿主控件都有 role）。
修法：表格行 `role="row"`、按钮 `aria-label`、错误条 `role="alert"`、focus ring 用 `--dsw-focus-ring-color`。

**U3（P1）两枚文案键写好了却没接线**
证据：`client/client.js` 共 116 个文案键，`botBot` 与 `botLaunchHint` 未被 `t()` 引用。
影响：0.7.2 承诺的「启动前生效要设操作系统环境变量」提示，实际从未显示。
修法：`applyBot` 成功后追加 `botLaunchHint`；`botBot` 要么用于标题，要么删掉。

**U4（P2）批量与空态**
- 多行时要逐个点「应用」，没有「全部应用」「全部撤销」。
- 空态（正常空）只有「点扫描试试」，没说明「扫描只覆盖模型 provider 与已识别的机器人通道」。

**U5（P2）语义重叠**
「已路由」与「运行中 :8792」两枚徽章表达同一件事的两半，用户需要自己拼。

### 3.4 实现质量

**I1（P2）`lib/routes.js` 509 行、13 个 op 的校验与业务耦合**
修法：拆 `lib/http/state.js`、`apply.js`、`patch.js`、`bot.js`，路由只做分发与鉴权。

**I2（P2）客户端单文件 1057 行、52 KB**
修法：拆 `client/panel/` 为 `rows.js`、`sections.js`、`i18n.js`；仍然零构建（纯 ESM）。

**I3（P2）状态无 schema 校验**
`migrate` 是手写 if，`schemaVersion=1` 只对外。建议用 `schemastery`（宿主已带）或自写 `validateState()`，在启动时校验并修复。

### 3.5 DSH 兼容性

**C1（P1）只声明一个宿主版本**
证据：`package.json` 的 `dshReleases` 只有 `"0.2.1-rc.2": "compatible"`。
修法：CI 真机跑 0.2.0-rc.2 / 0.2.1-rc.2 两档；结果写回矩阵；unknown 不允许发布。

**C2（P1）客户端 loader 无探测**
证据：`client/client.js` 首行直接调 `window.__ModuleLoader__.load`；宿主若换 ESM 装载器，整个 bundle 静默不执行。
修法：包一层 `if (window.__ModuleLoader__) ... else console.error(...)`，并在 host 侧 state 里暴露 `clientBundle:'legacy'` 供排查。

**C3（P2）`.env` 禁写规则没有固化成约束**
0.7.1 的启动崩溃根因是「往 `$DSH_HOME/.env` 写了启动器保留名」。现在代码不写了，但没有测试守住。
修法：加一条静态测试：`lib/**` 不得出现对 `.env` 的写操作（只允许 `cleanupManagedEnv` 的删除）。

**C4（P2）CI 只有语法 + 单测**
修法：加 `pnpm pack` → 装进临时 profile → import → `?op=state` 的冒烟 job。

---

## 4. 解决方案（按版本切，含工作量）

### 0.8.0 — 可靠性与直观性（约 1.5–2 人日）

| # | 内容 | 对应问题 | 验收 |
| --- | --- | --- | --- |
| 1 | 监听 watchdog + 指数退避重建 | R1 | 手工 kill 端口占用后 5 秒内 `status` 变 `down`，10 秒内恢复 |
| 2 | 统一错误记录：`safe()` + `lastError` + history | R2 | 制造只读目录，写入失败时 history 有一条原因 |
| 3 | 客户端请求序号 + abort + 去抖 | R3 | 并发 3 次 refresh 只采纳最后一次 |
| 4 | busy 禁用 + aria + focus ring | U1 U2 | 键盘可完成「扫描→找端口→应用」 |
| 5 | 接线 `botLaunchHint`、清理 `botBot` | U3 | 设置页出现「启动前生效要设 OS 环境变量」 |
| 6 | 熔断改滑窗 + 指数退避 | R4 | 61 秒一次改写也会在 5 次后暂停 |
| 7 | `.env` 写保护测试、客户端 loader 探测 | C2 C3 | 测试绿；无 `__ModuleLoader__` 时有明确报错 |

### 0.9.0 — 可扩展性（约 2–3 人日）

| # | 内容 | 对应问题 |
| --- | --- | --- |
| 1 | `?op=routes` CRUD + 「仅中转」路由（不改 baseURL） | E4 |
| 2 | 机器人定义外置为 `bots.json`（内置表兜底） | E1 |
| 3 | `config.guarded` / `config.origins` 覆盖内置表 | E2 E3 |
| 4 | 发现器扩展点 `ctx.provide('egress.discovery')` | E5 |
| 5 | UI：手动添加目标表单、批量应用/撤销、空态说明 | U4 U5 |

### 1.0.0 — 兼容与发布（约 2 人日）

| # | 内容 |
| --- | --- |
| 1 | 真机兼容矩阵（0.2.0-rc.2 / 0.2.1-rc.2 × Windows / Linux），结果写回 `dshReleases` |
| 2 | CI 增加「打包 → 安装 → 起插件 → 调 state」冒烟 job |
| 3 | API 快照扩到 client bundle 契约（loader 名、slot 名、tab 键） |
| 4 | 状态 schema 校验 + 迁移用例矩阵 |
| 5 | 发布清单：npm publish 前跑 `check:package` / `version` / 双语文档 |

## 5. 不做的事（明确排除）

- 不把插件做成通用代理（不做 SOCKS/PAC/HTTP2；不接管别的插件进程内的 HTTP 客户端）。
- 不自动改 `DSH_TELEGRAM_PROXY` 之外的启动器变量——0.7.1 的启动崩溃已证明代价。
- 不引入构建链（客户端保持零构建），不引入新运行时依赖（当前只有 js-yaml）。

## 6. 复现命令

```powershell
cd F:\projects_all\AI_projects\dsh-egress-router
node test\run-all.mjs          # 99 条
node scripts\check-syntax.mjs  # 21 文件
node scripts\check-package.mjs # 23 文件 / 78,480 B
$gui='http://127.0.0.1:56588'
Invoke-RestMethod "$gui/plugins/egress-router?op=state"     | ConvertTo-Json -Depth 4
Invoke-RestMethod "$gui/plugins/egress-router?op=discover"  | ConvertTo-Json -Depth 4
```
