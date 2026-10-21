# dsh-egress-router 0.1.5 评审与修改意见

- 评审对象：`F:\projects_all\AI_projects\dsh-egress-router`（0.1.5，已装入 `C:\Users\86139\.dsh\profiles\desktop`）
- 评审时间：2026-10-19
- 评审方式：逐文件阅读（`lib/*.js` 共 9 个模块、`client/client.js`、5 套测试）、在真实 host（pid 16892，GUI 端口 56040）上调用运行中 API、用临时 profile 做写入模拟
- 结论先说：**功能通路已经打通（设置页可见、8792 中转在跑、Gemini 能用），但「配置持久化、回滚一致性、本地 API 安全」三项是必须立刻补的硬缺陷**。其中 D1 会让插件在“看起来成功”的情况下把用户配置改坏。

---

## 一、当前架构（评审基线）

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 | `lib/index.js`（38 行） | `apply(ctx, config)`：起监听 → 注册 `webServer` 精确路由 `/plugins/egress-router` |
| 监听 | `lib/manager.js`（83 行） | 每个 route 一个 `http.createServer`，绑 127.0.0.1，端口占用检查 |
| 转发 | `lib/relay.js`（204 行） | `TunnelAgent`/`PlainTunnelAgent` 复用隧道，keep-alive，`/__health`，502 `relay_forward_failed` |
| 发现 | `lib/discovery/index.js`（273 行） | 解析 `cordis.patch.yml` + `.env` + bundles，产出 `llm:*` / `im:telegram` / `cfg:*` |
| 改写 | `lib/patcher.js`（79 行） | diff、备份、原子写、YAML 复校、回滚账本 |
| API | `lib/routes.js`（91 行） | `op=state|discover|probe|apply|rollback` |
| UI | `client/client.js`（190 行） | `settings.plugins.tab` 面板，表格、端口输入、检查、应用、扫描、回滚 |
| 状态 | `lib/store.js`（44 行） | `$DSH_HOME/storages/egress-router/state.json`（备份账本） |

接入方式（已生效）：`package.json` 的 `exports["./client"]` + `dsh.client.immediately` 让 shell 扫描到 bundle；`cordis.patch.yml` 里 `egress-router` 条目提供 `proxies.clash` 与 `routes`；Gemini provider 的 `baseURL` 指向 `http://127.0.0.1:8792/v1beta/openai`。

**已经做对、不要改坏的部分**：只绑 loopback；转发时重写 `Host` 并剥离 hop-by-hop 头；上游失败返回结构化 502；apply 拒绝 loopback 目标（0.1.4 加的）；`.env` 全局代理不再被插件改动；Telegram 走 `pnpm patch` 而非手改 `node_modules`。

---

## 二、缺陷清单

严重度：**S0** = 会改坏配置或造成不可用且不自知；**S1** = 明显错误但可恢复；**S2** = 体验/工程债。

### D1 · `apply` 不持久化路由（S0，崩溃级）

**现象**：在 UI 点「应用」后一切正常；重启 DSH 后监听不再启动，而 `baseURL` 仍指向 `127.0.0.1:<port>` → 该 provider 直接不可用。

**证据**
- `lib/routes.js:73-76`：路由只写进内存 `config.routes`，随后 `manager.sync(nextRoutes)`。
- `lib/patcher.js:48-70`：`commitApply` 只把 provider 的 `baseURL` 写进 `cordis.patch.yml`，**从不写 `egress-router` 条目的 `routes:`**。
- 临时 profile 实测输出：`egress-router` 条目写入后仍是 `config: {}`。

**修法**：`commitApply` 同时更新两处——provider `baseURL` 与 `egress-router.config.routes`（按 `id` 合并/替换）；写盘前校验 YAML 可解析。持久化后重启应能自动起监听。

**成本**：0.5 人日（含回归）。

### D2 · `rollback` 不卸载监听（S0）

**现象**：回滚后 `baseURL` 已恢复上游，但该端口仍在监听、UI 仍显示「运行中」，形成“指向已回滚上游的孤儿路由”。

**证据**：`lib/routes.js:80-84` 回滚后调用 `manager.sync(config.routes ?? [])`，而 `config.routes` 里这条路由从未被移除。

**修法**：回滚时同步移除 `config.routes` 中对应条目并持久化，再 `sync`；或让回滚账本记录 `routeId`，回滚按 id 精确卸载。

**成本**：0.25 人日。

### D3 · 本地 API 无鉴权（S0，安全）

**现象**：任意本地进程（脚本、其它插件、恶意程序）都能 `POST ?op=apply` / `?op=rollback`，改写用户 `cordis.patch.yml` 并开监听。

**证据**：无 cookie、无 token，`GET /plugins/egress-router?op=state` 返回 200；`POST ?op=apply` 可直达 `commitApply`。

**修法**（按代价递增，选一）：
1. 校验 `Sec-Fetch-Site`/`Origin` 为同源且 `content-type: application/json`；
2. 与 host 现有鉴权对齐：只接受带 host 会话 cookie 的请求；
3. 启动时生成一次性 token，写进 `__DSH_BOOT__` 由客户端带 `x-egress-token`。

**成本**：0.5 人日。

### D4 · 写文件先于起监听（S0 数据完整性）

**现象**：端口被占用时，配置已经被改写，`apply` 仍返回 200（`status[].ok=false`），用户看到“成功”但实际可用性已破坏，且没有自动回滚。

**证据**：`lib/routes.js:71-76` 顺序是 `commitApply` → `sync`；端口检查在 `lib/manager.js:26` 才开始；`sync` 在 `lib/manager.js:64-71` 吞掉异常。

**修法**：改成 `预留端口 → 起监听 → 写文件 → 失败则回滚文件并停监听`；`sync` 的失败要作为 `apply` 的非 200 响应返回。

**成本**：0.5 人日。

### D5 · `yaml.dump` 重写整份配置（S1）

**现象**：每次 apply 都会把整份 `cordis.patch.yml` 重新 dump（`lib/patcher.js:54`，`lineWidth: 120, noRefs: true`），用户手写注释全部丢失、格式被归一化、锚点被展开。

**实测**：临时 profile 里 `# user hand-written patch, keep my comments` 在写入后消失，顶部被替换为 `# written by dsh-egress-router`。

**修法**：优先做**定点文本替换**（定位 `providers.<key>.baseURL` 那一行）；做不到时再整份 dump，并在 UI 明示“将重写格式”。

**成本**：0.5–1 人日。

### D6 · 错误码语义混乱（S2）

`lib/routes.js:86-89` 把所有失败（含 `provider not found`、参数缺失）都映射成 500；用户错误应为 400/404，服务端错误才是 500。

**成本**：1 小时。

### D7 · `probe` 可探测任意目标（S1，安全）

`lib/routes.js:55-61` 直接接受请求体里的 `target`，等价于给本机任意进程一个 TCP 扫描器（还能借 7897 出网）。

**修法**：只允许 `config.routes`/发现结果里出现过的目标。

**成本**：0.25 人日。

### D8 · 配置无 schema 校验（S1）

`lib/index.js:17-24` 直接使用 `config`，非法 `routes`/`proxies` 会在运行期抛错，没有友好的启动失败信息。应加 schemastery（host 已内置 `@deepseek-ai/schemastery`）描述 `listenHost`、`proxies`、`routes`。

**成本**：0.5 人日。

### D9 · 端口未做范围校验（S1）

`lib/routes.js:65-66` 只判断 `Number(...)` 非零；`lib/ports.js` 里已有 `isValidPort`（1024–65535）却没被调用。

**成本**：1 小时。

### D10 · 无审计、发现结果不缓存（S1）

`state.json` 只在 `commitApply` 成功后写一次；`routes.js:46` 读的 `readState().discovered` 永远是 `null`。目录在首次 apply 前不存在。应记录：扫描时间、每次 apply/rollback 的 diff 摘要与探测结果、最近 20 条历史。

**成本**：0.5 人日。

### D11 · 不可路由项仍显示「应用」（S1，UX）

`im:telegram`、`cfg:<host>` 这类条目没有对应的 patch 支持，点了必然失败：实测 `{"error":"provider not found in cordis.patch.yml: im:telegram"}`。

**修法**：发现结果加 `patchable: boolean`；UI 只对可改写项给「应用」，其余显示「仅提示 / 复制配置」。

**成本**：2 小时。

### D12 · 上游掉线无感知（S1，UX）

7897 挂掉后每个请求都是 502，UI 依旧「运行中」。应周期探活（30s TCP connect），状态带 `upstreamOk`，UI 标红并给出下一步。

**成本**：0.5 人日。

### D13 · 并发写无锁（S2）

两个 apply 同时执行会竞争备份与 `rename`。加进程内互斥（单写者队列）即可。

**成本**：2 小时。

### D14 · 热路径开销（S2，已量化）

同一节点、15 次采样、4 次预热：

| 路径 | p50 | p90 | max |
|---|---|---|---|
| npm 直连 | 250 ms | 277 ms | 292 ms |
| npm 进程级代理 | 338 ms | 405 ms | 627 ms |
| npm 经 relay | 376 ms | 398 ms | 696 ms |
| Gemini 进程级代理 | 866 ms | 5748 ms | 6517 ms（1 次失败） |
| Gemini 经 relay | 140 ms | 161 ms | 169 ms |

净开销约 **+38 ms/请求**（多一跳 loopback + relay 侧另建 TLS + 多一层 pipe）；在抖动链路上 relay 反而快数倍（复用已建隧道）。**不建议为此回到独立进程**，代价（窗口/自启/误报）大于收益。

---

## 三、改进分级与排期

### 0.2.0 —— 正确性与安全（约 1.5–2 人日）

D1、D2、D3、D4，配套 4 条新测试：
- `apply → 重新 load 配置 → 监听自动恢复`（D1）
- `rollback → 端口关闭 / 状态无该路由`（D2）
- 未授权请求返回 401/403（D3）
- 端口占用时配置文件**字节不变**、响应非 2xx（D4）

### 0.3.0 —— 可用性（约 2–3 人日）

D5、D7、D8、D9、D10、D11、D12。

### 0.4.0 —— 工程化与发布（约 2 人日）

D6、D13、i18n（zh/en）、README 与 CHANGELOG 补齐 0.1.2 的 `exports`/`immediately` 契约、`pnpm pack` 产物校验、发布到 npm 的检查清单。

### 长期（不属于本插件范围）

- 上游 `@deepseek-ai/dsh-http-proxy` 支持 per-provider/per-origin 传输 → 本插件退化为诊断面板。
- `@xmanrui/dsh-im` 增加 proxy 配置项 → 去掉 `pnpm patch`。

---

## 四、验收标准

1. 全新 profile 上：`扫描 → 应用 Gemini → 重启 DSH → 不改任何文件`，设置页仍显示「运行中」，Gemini 可用。
2. `回滚` 后：端口关闭、`cordis.patch.yml` 与 apply 前逐字节一致（注释保留优先）。
3. 未授权本地请求（无会话、`Origin: null`）对 `apply`/`rollback` 返回 401/403。
4. 端口被占用时执行 apply：响应非 2xx、配置文件不变、UI 显示原因。
5. 全部测试通过（现有 9 条 + 新增 4 条），`pnpm pack` 产物包含 `client/`、`cordis.patch.yml`，装入后设置页可见。
6. 代理不可用时：`/__health` 仍 200，但状态含 `upstreamOk:false`，UI 标红。

---

## 五、风险与注意事项

- **改 `cordis.patch.yml` 是全局副作用**：任何 bug 都会影响所有插件加载。写入前必须备份 + 复校 + 失败自动回滚。
- **不要**把 `platform.deepseek.com`、`api.deepseek.com`、`registry.npmjs.org`、`awesome-dsh-plugin.com` 纳入路由（发现逻辑已有 GUARDED，UI 也要挡住）。
- **不要**改 `.env` 的全局代理；本插件只做「按目标拆端口」。
- 桌面版每次升级可能改 `slots`/`webServer` 契约：客户端要有特性探测与降级，避免整页白屏。
- 测试运行器是自写的（`test/run-all.mjs`），因为 `node --test` 在 DSH 沙箱里 worker `spawn EPERM`；新增测试要沿用这个 runner。

---

## 六、附：本次评审用到的复现命令

```powershell
# 运行中实例的 API（端口随 host 实例变化）
Invoke-RestMethod 'http://127.0.0.1:56040/plugins/egress-router?op=state'
Invoke-RestMethod 'http://127.0.0.1:56040/plugins/egress-router?op=discover'
Invoke-RestMethod 'http://127.0.0.1:8792/__health'

# 写入模拟（临时 profile，不碰真实配置）
# 见本文 D1 证据：commitApply 后 egress-router 条目仍为 config: {}

# 测试
cd F:\projects_all\AI_projects\dsh-egress-router; node test/run-all.mjs
```
