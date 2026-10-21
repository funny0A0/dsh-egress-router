# dsh-egress-router 0.2.1 代码评审报告

- 评审对象：`dsh-egress-router@0.2.1`（已安装于 `C:\Users\86139\.dsh\profiles\desktop`）
- 基线：宿主 `@deepseek-ai/dsh` **0.2.1-rc.2**，Node v24.15.0，Windows 11
- 方法：源码逐文件通读 + 生产宿主实测（宿主 pid 29860，22:30:50 启动，GUI 49553）
- 规模：`lib/` 8 个文件（2.1–10.5 KB），`client/client.js` 11.5 KB，`test/` 7 文件 23 用例

## 一、运行状态结论

| 检查项 | 结果 | 判定 |
|---|---|---|
| 监听 | 仅 `127.0.0.1:8792`，属宿主进程，8793 孤儿消失 | 通过（单实例生效） |
| `/__health` | `{"ok":true,"secure":true,"viaProxy":true}` | 通过 |
| `state.json` | `routes` 由配置种子迁移，`listeners.ok:true`，history 有 `start llm:gemini:8792` | 通过 |
| 越权写入 | 无 Origin 的 `POST ?op=apply` → 403 | 通过 |
| Gemini 端到端 | 经 8792 调 `gemini-3.8-flash` → 200 / 3.4 s | 通过 |
| Telegram | 补丁标记在位，`getMe` 200/732 ms，pending=0，但游标停在 05:17、无 149.154.x 连接 | 通道可达，未观察到活跃轮询（需发消息确认） |
| `state.json` 版本 | 磁盘上仍是 `"version": 2`，代码常量已是 3 | **缺陷 R1** |

## 二、缺陷清单

严重度：**P0** = 会破坏真实配置或引入安全暴露；**P1** = 行为错误但有规避路径；**P2** = 质量与可维护性。

### R1 · P0 · schema 版本从不升级

- 位置：`lib/store.js:44-50`（`writeState`），常量在 `lib/store.js:21`
- 证据：`fs.writeFileSync(tmp, JSON.stringify({ ...EMPTY, ...next }, null, 2))`；`updateState` 传入的旧 state 携带 `version: 2`，展开时覆盖 `EMPTY.version`。生产 `state.json` 实测仍为 2。
- 影响：任何以版本号为条件的迁移永远不会执行，0.3 改结构时无法安全迁移。
- 修法：`{ ...next, version: EMPTY.version }`；`readState` 对 `version < EMPTY.version` 显式迁移并立即写回。
- 回归用例：写入 v2 文件后 `readState()` → `writeState()`，断言磁盘为 3 且字段不丢。

### R2 · P0 · apply 的状态落盘非原子

- 位置：`lib/routes.js:94-140`（`applyRoute`）
- 证据：顺序为 `manager.sync(candidate)`（:119）→ `commitApply`（:126）→ `rememberListeners`（:129）→ `writeRoutes`（:134）→ `rememberListeners`（:135）。三次独立写入，中间无事务。
- 影响：磁盘满或进程中断时，可出现「配置 baseURL 已指向 8792、监听在跑、state 无该路由」。重启后监听不会恢复，baseURL 仍指向空端口 → Gemini 不可用。
- 修法：commit 成功后单次 `updateState()` 同时写 `routes` + `listeners` + `history`；任一步失败则恢复文件、停监听、写回旧 state。启动时的 reconcile 可作兜底。
- 回归用例：mock `writeState` 抛错，断言文件已回滚、监听已关闭、state 与操作前一致。

### R3 · P0 · rollback 盲写备份，吞掉用户后续手改

- 位置：`lib/patcher.js:168-190`（`rollbackLast`），盲写在 `lib/patcher.js:178`
- 证据：`fs.copyFileSync(last.backup, last.file)`，整份回退，不校验当前内容是否仍是 apply 写入的版本。
- 影响：用户在 apply 与 rollback 之间手改任何 provider，一次回滚全部丢失。
- 修法：账本记录 apply 后文件 `sha256After`；回滚前比对当前 sha256，不等则 409 `file_changed_since_backup`，需 `force: true`。
- 回归用例：apply → 手动追加 provider → rollback，断言 409 且文件未改写；带 force 成功。

### R4 · P0 · probe 无鉴权，可当端口扫描器

- 位置：`lib/routes.js:180-188`（probe 分支在 `assertWriteAllowed` 之前）
- 证据（无 Origin、无 cookie、生产实测）：

```
POST ?op=probe {"target":"127.0.0.1:49553"} → 200 ... WRONG_VERSION_NUMBER
POST ?op=probe {"target":"127.0.0.1:1"}     → 200 ... connect ECONNREFUSED 127.0.0.1:1
```

- 影响：本机任意页面或进程可借 DSH 进程探测本机/内网端口，错误文本还能区分「有服务但协议不符」与「端口关闭」，形成指纹能力。
- 修法：①probe 同样过 `assertWriteAllowed`；②目标必须命中本次 discovery 或已存在的 route；③显式拒绝 loopback 与私网网段（与 `applyRoute` 的 loopback 拒绝一致）。
- 回归用例：无 Origin 的 probe → 403；未知 `target` → 400 `unknown_target`；`127.0.0.1:1` → 400 `private_target`。

### R5 · P1 · 停止后残留幽灵状态

- 位置：`lib/manager.js:47-54`（`stop`）
- 证据：`if (!server) return false` 直接返回，`statuses` 未清理。
- 影响：失败条目永久留在 `snapshot()`，UI 显示「失败 :8793」，并写入 `state.listeners`。
- 修法：`statuses.delete(id)` 移到 server 判空之前。

### R6 · P1 · 写配置重排整份 YAML

- 位置：`lib/patcher.js:126`
- 证据：`leadingComments(raw) + yaml.dump(doc, { lineWidth: 120, noRefs: true })`。
- 影响：仅保留文件开头注释块；中间注释、锚点/别名、引号风格、键序全部丢失（当前配置正文无注释，故未暴露）。
- 修法：改为定向写入——定位 `providers:` 下目标 provider 的缩进块，只替换/插入该块内的 `baseURL:` 行；未命中时退回 dump 并返回 `format: 'rewritten'`。

### R7 · P1 · 正常结束也销毁上游请求

- 位置：`lib/relay.js:197-198`
- 证据：

```js
request.pipe(upstream)
response.on('close', () => upstream.destroy())
```

- 影响：`close` 在正常写完时同样触发，每次请求结束都拆上游，keep-alive 复用率打折。
- 修法：`if (!response.writableFinished) upstream.destroy()`，或监听 `request.on('aborted')`。

### R8 · P1 · TLS 握手无超时

- 位置：`lib/relay.js`（`connectViaProxy` 内 `tls.connect` 之后）
- 影响：代理可连通但 TLS 卡住时，socket 挂到系统默认超时（约 2 分钟）。
- 修法：`secured.setTimeout(timeoutMs, () => secured.destroy(new Error('tls_handshake_timeout')))`，`secureConnect` 后清除。

### R9 · P1 · apply 之后不做端到端验证

- 位置：`lib/routes.js:126` 之后无探活
- 影响：上游已挂也报成功，用户首次真实调用才见 502。
- 修法：commit 后经新端口 `probeTarget({ target, proxyUrl, timeoutMs: 5000 })`；失败自动回滚并返回 502 `apply_unverified`；成功响应带 `verified: true`。

### R10 · P1 · 探测默认不带代理；未定义代理名静默直连

- 位置：`lib/routes.js:180-188`；`lib/manager.js`（`proxyUrlFor` 返回 null 时按直连）
- 影响：新建行点「检查」只测直连，`verdict` 恒为 `needs-proxy`/`unreachable`；`proxies` 中不存在的名字会静默直连，只留日志。
- 修法：探测未指定 proxy 时用插件默认代理；`start`/`applyRoute` 对未定义代理名报 400 `unknown_proxy`。

### R11 · P1 · 客户端请求无超时

- 位置：`client/client.js:13`
- 影响：宿主忙或探活卡住时按钮停在「应用中…」。
- 修法：`signal: AbortSignal.timeout(20000)`，超时提示「超时，请刷新后查看结果」。

### R12 · P2 · 去重用前缀匹配

- 位置：`lib/discovery/index.js:180`、`lib/discovery/index.js:211`
- 证据：`item.target.startsWith(host.split(':')[0])`。
- 影响：`api.telegram.org.evil.com` 会被当成 `api.telegram.org` 而跳过。
- 修法：按 `host:port` 精确相等比较。

### R13 · P2 · 重复读盘

- 位置：`lib/discovery/index.js:199`、`lib/discovery/index.js:267`（`installedBundles` 各调一次）
- 影响：每次扫描多读一遍 profile 与 17 个包，并逐个读 bundle 的 `cordis.patch.yml`。
- 修法：`discover()` 内取一次作为参数传入。

### R14 · P2 · 备份文件只增不减

- 位置：`lib/patcher.js:125`（`backupOf`）与 state 的 `backups` 截断逻辑
- 影响：数组截到 20，但 `storages/egress-router/backups/*.bak` 永久累积。
- 修法：按账本同步删除超出上限的 `.bak`。

### R15 · P2 · `resolveProfileDir` 假设 hoisted 布局

- 位置：`lib/index.js:13`
- 证据：`path.resolve(here, '..', '..', '..')`。
- 影响：`nodeLinker: hoisted` 正确；isolated（`.pnpm` 嵌套）会解析到 `node_modules`。
- 修法：优先 `config.profileDir` → `process.env.DSH_PROFILE_DIR` → 路径推导。

### R16 · P2 · 测试缺口

缺以下回归：R1 版本升级、R2 写入失败原子性、R3 回滚漂移、R4 probe 鉴权、R5 stop 清状态、R7 复用。现有 23 条用例覆盖的是正向路径与 0.2.0 的四条安全约束。

## 三、0.2.2 修改方案

### 范围

| 批次 | 条目 | 预估 |
|---|---|---|
| 必做 | R1、R2、R3、R4、R5、R11 + 6 条测试 | 4 h |
| 建议 | R6、R7、R8、R9、R10 + 5 条测试 | 6 h |
| 可选 | R12–R15 | 2 h |

### 数据模型（v4）

```
state.json
  version: 4
  routes: [{ id, target, listenPort, proxy, enabled, tls?, verified? }]
  listeners: { [id]: { ok, port, error?, at } }
  backups: [{ id, routeId, file, backup, sha256Before, sha256After, at, format }]
  history: [{ at, kind, detail }]                      # 上限 50
  discoveredAt / discovered / warnings / lastError
```

迁移：`2|3 → 4` 时为旧 backups 补 `sha256After: null`（视为不可校验，回滚需 force）。

### API 变更

| 调用 | 变化 |
|---|---|
| `POST ?op=probe` | 需同源；目标须为已知项；拒绝 loopback/私网 |
| `POST ?op=apply` | 响应新增 `verified`；失败自动回滚，错误码 `apply_unverified` |
| `POST ?op=rollback` | 新增 409 `file_changed_since_backup`；body 支持 `force` |
| `GET ?op=state` | 保持只读放开（无副作用），文档标注 |

### 兼容性

- 配置格式不变：仍只写 `providers.<key>.baseURL` 与 `egress-router.config.routes`。
- 原地升级：`pnpm add file:...0.2.2.tgz` → 重启宿主。
- 回滚路径：卸载插件后把 gemini `baseURL` 改回 `https://generativelanguage.googleapis.com/v1beta/openai`（备份在 `F:\projects_all\AI_projects\dsh-tools\backup-egress-0.2.0-20261019-220146\`）。

## 四、风险

1. R6 定向写入依赖 YAML 缩进假定；用户若用 flow 风格会退化为 dump。缓解：返回 `format` 字段并在 UI 提示。
2. R9 自动回滚会在上游短暂抖动时撤销刚生效的配置。缓解：探活失败重试 1 次并明确提示「已回滚」。
3. R2 的单次写入把 `listeners` 纳入同一事务；必须在 `sync` 之后取快照，避免读到旧值。

## 五、验收标准

1. `node test/run-all.mjs` 全绿，用例 ≥ 34（新增 ≥ 11）。
2. 生产 `state.json` 升级为 `version: 4`，`routes` 保留。
3. 无 Origin 的 `POST ?op=probe` → **403**；`{"target":"127.0.0.1:1"}` → **400 `private_target`**。
4. `POST ?op=apply` 返回 `verified: true`；停掉 7897 后 apply → 502 `apply_unverified` 且配置已回滚。
5. `stop()` 后 `?op=state` 不再出现失败监听条目。
6. 连续两次同目标请求，relay 不新建上游连接。
7. 含中间注释的 fixture apply 后注释仍在。
8. 卸载插件并还原 baseURL 后，Gemini 配置可回到直连形态。

## 六、发布与回滚

```powershell
cd F:\projects_all\AI_projects\dsh-egress-router
node test\run-all.mjs
pnpm pack
cd C:\Users\86139\.dsh\profiles\desktop
pnpm add file:F:/projects_all/AI_projects/dsh-egress-router/dsh-egress-router-0.2.2.tgz
# 完全退出 DSH 后重开
```

回滚：`pnpm remove dsh-egress-router`，用备份覆盖 `cordis.patch.yml`，重启。

## 附录 · 实测片段

```
GET  http://127.0.0.1:49553/plugins/egress-router?op=state  → 200 {"ok":true,"routes":[...],"listeners":{...}}
POST ?op=apply  (无 Origin)                                 → 403 {"ok":false,"error":"forbidden"}
POST ?op=probe  (无 Origin, target 127.0.0.1:1)             → 200 {"verdict":"unreachable",...}
GET  http://127.0.0.1:8792/__health                         → {"ok":true,"secure":true,"viaProxy":true}
POST http://127.0.0.1:8792/v1beta/openai/chat/completions   → 200 (gemini-3.8-flash, 3.4 s)
```
