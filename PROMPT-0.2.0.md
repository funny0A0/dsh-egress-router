# 提示词：dsh-egress-router 0.2.0 正确性与安全修复

> 用法：把本文件整份贴给执行者（人或 AI）。先读 `REVIEW-0.1.5.md`，再按「工作方式」先出设计稿、回答 3–5 个问题，得到确认后再改代码。

---

## 角色

你是 DSH（DeepSeek Harness 桌面版）插件的维护者。目标是把已安装可用的 `dsh-egress-router` 从 0.1.5 修到 **0.2.0**：让配置写入可持久、回滚一致、本地 API 不可被任意进程滥用。你只改必要的地方，不重构架构，不引入新依赖。

## 项目位置与运行环境

- 源码仓库：`F:\projects_all\AI_projects\dsh-egress-router`
- 已安装副本：`C:\Users\86139\.dsh\profiles\desktop\node_modules\dsh-egress-router`（实测以仓库打包后 `pnpm add <tgz>` 覆盖）
- 目标 profile：`C:\Users\86139\.dsh\profiles\desktop`（配置文件 `cordis.patch.yml`、`package.json`）
- 宿主：桌面版 DSH 0.2.1-rc.2，Windows 11，Node 24；GUI 地址形如 `http://127.0.0.1:<随机端口>`
- 现有测试：`node test/run-all.mjs`（自写 runner，因为 `node --test` 在沙箱里 worker `spawn EPERM`），当前 9 条全过
- 打包安装：`pnpm pack` → 在 profile 目录 `pnpm add <tgz>` → **完全退出并重启 DSH**（旧进程会占着端口）

## 必须先知道的事实（已核实，别再重新验证）

1. 插件是 host 侧插件（`lib/index.js` 导出 `apply(ctx, config)`）+ 客户端 bundle（`client/client.js`）。客户端的 `exports["./client"]` 与 `dsh.client.immediately` 是**能否被 shell 扫描到**的关键，缺了就不会出现在设置里（0.1.2 已修，勿回退）。
2. 设置页通过 `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id, order, label }, Component))` 注册；不要用 `ctx.slots.settings.register(...)`（不存在）。
3. API 是 host 的 `webServer.register({ kind: 'exact', path: '/plugins/egress-router', handler })`，同一个 URL 靠 `?op=` 分发：`state` / `discover` / `probe` / `apply` / `rollback`。
4. 插件配置来自 `cordis.patch.yml` 中的条目 `- id: egress-router`，含 `proxies`（如 `clash: http://127.0.0.1:7897`）与 `routes[]`（`{ id, target, listenPort, proxy, tls? }`）。
5. provider 的真实配置在同一个文件里：`- id: llm-pi-ai` → `config.providers.<key>.baseURL`。apply 的唯一目的就是把 `<key>` 的 `baseURL` 改成本机 `http://127.0.0.1:<listenPort><原 path>`。
6. 已知硬缺陷（本任务要修）：`apply` 只写 `baseURL`、**不写 `routes`**（重启后监听不启动，provider 指向死端口）；`rollback` 不卸载监听；API 无鉴权；写文件在起监听之前。

## 任务范围（0.2.0，四项）

### R1 持久化路由（对应 D1）

- `apply` 成功后，`cordis.patch.yml` 必须同时包含：该 provider 的新 `baseURL`，以及 `egress-router.config.routes` 中对应路由（按 `id` 合并/替换，`enabled: true`）。
- 写盘后重新 `yaml.load` 校验；校验失败 → 恢复备份并让请求失败。
- 重启 DSH 后：`manager.sync(config.routes)` 自动拉起监听，不需要人工干预。
- 幂等：连续两次 apply 同一项、同一端口，文件内容稳定（不产生重复路由、不重复备份堆积）。

### R2 回滚一致性（对应 D2）

- `rollback` 必须同时：恢复 `cordis.patch.yml` 备份、从 `config.routes` 移除被回滚的路由、`manager.sync` 关闭对应监听。
- 回滚后 UI 状态里不再出现该路由的「运行中」。
- 回滚不存在的记录 → 明确的 4xx 错误（不是 500）。

### R3 本地 API 鉴权（对应 D3）

- 写操作（`apply`、`rollback`）必须拒绝“非本页”的调用。
- 最低要求：校验 `Origin`/`Sec-Fetch-Site`（同源、非 `null`）与 `content-type: application/json`；无浏览器上下文的本机脚本应被拒。
- 读操作（`state`、`discover`）可以放宽，但不得泄露凭证（当前不涉及）。
- 拒绝时返回 401/403 + 固定错误体 `{ error: 'unauthorized', reason }`。
- 客户端要能在被拒时显示人话提示，而不是白屏。

### R4 写入顺序与失败回滚（对应 D4）

- 顺序改为：校验参数（端口范围 1024–65535、未被占用）→ 起监听 → 写文件 → 成功返回；任一步失败：停监听、恢复文件、返回非 2xx 且带原因。
- `manager.sync` 的失败不能只记在 `status[].ok=false` 里；apply 必须把它变成失败响应。
- 配置文件在失败时必须**逐字节不变**。

## 硬约束

- 不新增运行时依赖（`js-yaml` 已有；schemastery 从 host 注入可用）。
- 不改 `.env`，不动全局代理，不做“除某域名外全部走代理”这类 NO_PROXY 技巧。
- 不把 `platform.deepseek.com`、`api.deepseek.com`、`registry.npmjs.org`、`awesome-dsh-plugin.com` 纳入路由（发现逻辑里的 GUARDED 保持有效）。
- 监听地址只能是 `127.0.0.1`；不得监听 `0.0.0.0`。
- 不破坏已有路由（用户当前有一条 `llm:gemini → generativelanguage.googleapis.com:443:8792 via clash`，升级后必须照常工作）。
- 文件写入必须原子（临时文件 + rename），失败要回滚；备份目录保持 `$DSH_HOME/storages/egress-router/backups`。
- 代码风格与现有文件一致：ESM、2 空格、单引号、无分号依赖、注释只写“为什么”。

## 数据与契约

`state.json`（建议升到 version 2）：

```json
{
  "version": 2,
  "discoveredAt": "2026-10-19T…",
  "discovered": { "items": [], "warnings": [] },
  "backups": [ { "at": "…", "file": "…", "backup": "…", "routeId": "llm:gemini", "before": "…", "after": "…", "listenPort": 8792 } ],
  "history": [ { "at": "…", "op": "apply", "routeId": "llm:gemini", "ok": true, "detail": "…" } ]
}
```

API 响应约定：
- 成功：`200` + JSON
- 参数错误：`400 { error, message }`
- 未授权：`401/403 { error: 'unauthorized' }`
- 目标不存在：`404`
- 服务端异常：`500 { error, message }`
- `apply` 成功体至少含：`{ diff, routes, status, backup }`

## UI 要求（与修复配套的最小改动）

- 「应用」按钮在请求失败时显示真实原因（端口占用、未授权、provider 不存在），并保持表格可继续操作。
- 不可 patch 的条目（`im:telegram`、`cfg:*`）隐藏或禁用「应用」，改为「仅提示」。
- 应用成功后，该行状态立即反映 `status[]`（运行中 + 端口）。
- 不要求重做布局；0.1.5 的三行式行布局保持。

## 测试要求

沿用 `test/run-all.mjs`，新增至少 4 条，且**必须在临时目录 fixture 上跑**（不得触碰真实 profile）：

1. `apply` 后文件里同时有 `baseURL` 与 `routes`；再次 `load` 配置能还原出同一路由。
2. `rollback` 后：文件恢复原文、`config.routes` 不含该路由、端口已释放。
3. 未授权请求（无 Origin/伪造 Origin）对 `apply`/`rollback` 返回 401/403，且文件未被修改。
4. 端口占用时 `apply` 返回非 2xx，文件字节与调用前一致。

另外：保留现有 9 条全绿；新增测试要能在无网络环境下跑（不要依赖真实 7897）。

## 交付物

1. 代码变更（`lib/*.js`、`client/client.js`、必要时 `cordis.patch.yml`）。
2. `REVIEW-0.1.5.md` 里 D1–D4 的修复说明（可追加到 `CHANGELOG.md` 0.2.0 段）。
3. 版本号 0.2.0，`package.json` 的 `files` 仍包含 `client/`、`lib/`、`cordis.patch.yml`。
4. 一段「升级步骤 + 回滚步骤」的操作说明（重启前备份、如何 `pnpm remove`、如何恢复 `cordis.patch.yml`）。
5. 一段自检记录：`node test/run-all.mjs` 输出、`pnpm pack` 产物、安装后 `?op=state` 的响应摘要。

## 验收标准

1. 全新 profile：`扫描 → 应用 → 重启 DSH → 不改文件`，监听自动恢复，provider 可用。
2. `rollback` 后端口关闭、文件逐字节还原、UI 无「运行中」残留。
3. 无浏览器上下文的本地脚本调用 `apply`/`rollback` 被拒。
4. 端口被占用时配置零变更、错误可见。
5. 现有 9 条 + 新增 4 条测试全过；打包安装后设置页可见、真实 Gemini 请求 200。

## 不要做

- 不要把 relay 改成独立后台进程（会带回窗口/自启/误报问题）。
- 不要引入 i18n 框架、UI 组件库、状态管理库。
- 不要在 apply 里顺手改 `.env` 或其它插件的 `node_modules`。
- 不要为了“顺手”重排 `cordis.patch.yml` 的键顺序或删除用户注释（D5 是 0.3.0 的事，本版至少不要让它更糟）。
- 不要在没有测试覆盖的情况下改 `lib/relay.js` 的转发路径。

## 工作方式

1. 先读 `REVIEW-0.1.5.md` 与 `lib/routes.js`、`lib/patcher.js`、`lib/manager.js`、`lib/store.js`。
2. 输出一页设计稿：改动点、数据流、失败路径、测试计划。
3. 提 3–5 个待确认问题（例如：鉴权用 Origin 校验还是 host 会话；回滚是否要保留历史记录；`state.json` 是否直接升 version 2）。
4. 得到确认后按 R4 → R1 → R2 → R3 的顺序实现（先保证失败时不破坏配置）。
5. 每完成一项就跑一次 `node test/run-all.mjs`，最后统一 `pnpm pack` + 安装 + 重启验证。
6. 汇报时给：改了什么、为什么、测试输出、剩余风险。

## 附：常用命令

```powershell
cd F:\projects_all\AI_projects\dsh-egress-router
node test/run-all.mjs
pnpm pack
cd C:\Users\86139\.dsh\profiles\desktop
pnpm add "F:\projects_all\AI_projects\dsh-egress-router\dsh-egress-router-0.2.0.tgz"
# 完全退出 DSH 后重启，然后：
Invoke-RestMethod 'http://127.0.0.1:<gui-port>/plugins/egress-router?op=state'
Invoke-RestMethod 'http://127.0.0.1:8792/__health'
```
