# 提示词：dsh-egress-router 0.2.2（按评审报告修复）

你是 DSH 插件工程师。请在 **`F:\projects_all\AI_projects\dsh-egress-router`** 内把 `0.2.1` 修到 `0.2.2`，依据是同目录的 `REVIEW-0.2.1.md`（已给出 16 条缺陷、修法与验收）。不要重写架构，只做定点修复。

## 一、环境事实（已核实，不要重新调研）

- 宿主：`@deepseek-ai/dsh` **0.2.1-rc.2**（`D:\dsh\resources\app.asar\dsh`），Node v24.15.0，Windows 11。
- 运行中的 profile：`C:\Users\86139\.dsh\profiles\desktop`（junction → `D:\dsh-data\home\profiles\desktop`）；插件已装在该 profile，版本 0.2.1。
- 状态文件：`D:\dsh-data\home\storages\egress-router\state.json`（生产实测 `version: 2`）。
- 现有测试：`node test\run-all.mjs`，6 文件 23 用例全绿。
- `node --test` 在沙箱内会因 worker `spawn EPERM` 失败，只能用自带 runner。
- 用 `write` 工具在本仓库**新建**文件会报 `EISDIR`：先 `New-Item -ItemType File` 造空文件再写。
- 会话已是 `danger-full-access`；不要带 `sandbox_permissions`。
- 生产监听 8792 属宿主进程；`__health` 200；`?op=state` 200；无 Origin 的 `?op=apply` 403。

## 二、硬约束

1. **不引入新依赖**（只用 `node:*` 与已有的 `js-yaml`）。
2. **不改** `cordis.patch.yml` 里与本次无关的条目；不新增 `- id: egress-router` 副本。
3. 不写全局代理环境变量；不把任何 `*_PROXY` 写进 `~/.dsh/.env`。
4. 所有改动保持 `node --check` 通过；测试必须由 `node test\run-all.mjs` 全绿。
5. 不修改 `client/client.js` 已确认可用的槽位 API（`settings.plugins.tab`）。
6. 中文注释与 UI 文案保持现状；新增英文标识符用小写下划线错误码。
7. 每个修复必须附**可执行的回归用例**；没有用例的修复视为未完成。

## 三、任务（按优先级）

### P0 必做

**R1 · 版本号必须真正升级**
- `lib/store.js` 的 `writeState` 改为 `{ ...next, version: EMPTY.version }`。
- `readState` 遇到 `version < EMPTY.version` 执行迁移并写回；迁移函数集中在一个 `migrate(state)` 里。
- 用例：写一份 `version: 2` 的文件 → `readState()` → 断言 `version === 4` 且 `routes`/`history` 不丢。

**R2 · apply 的状态落盘原子化**
- `lib/routes.js:94-140` 改为：`sync(candidate)` → `commitApply` → **一次** `updateState()` 写 `routes` + `listeners` + `history`。
- 任一步失败：恢复配置文件、`sync(previous)`、写回旧 state，返回对应错误码。
- 用例：注入 `writeState` 抛错 → 断言文件 sha256 回到操作前、监听已关闭、`state.routes` 未变。

**R3 · 回滚前校验文件漂移**
- 备份账本新增 `sha256Before` / `sha256After`（`lib/patcher.js:125` 的 `backupOf` 附近）。
- `rollbackLast({ routeId, force })`：当前文件 sha256 ≠ `sha256After` 时返回 409 `file_changed_since_backup`；`force: true` 才继续。
- `sha256After` 为 `null`（旧账本）时一律要求 `force`。
- 用例：apply → 手动改文件 → rollback 期望 409 且文件未动；force 后成功。

**R4 · probe 收紧**
- probe 分支（`lib/routes.js:180`）前加 `assertWriteAllowed(req)`。
- 目标必须在 `discover` 已知集合或已有 route 中，否则 400 `unknown_target`。
- 拒绝 loopback 与私网（10/8、172.16/12、192.168/16、169.254/16、127/8、::1、fe80::/10），返回 400 `private_target`。
- 用例：无 Origin → 403；未知目标 → 400 `unknown_target`；`127.0.0.1:1` → 400 `private_target`。

**R5 · 停止即清状态**
- `lib/manager.js:47-54` 把 `statuses.delete(id)` 提到 `if (!server)` 之前。
- 用例：起监听 → 外部关闭 socket → `stop()` → `snapshot()` 不含该 id。

### P1 建议

**R6 · 定向写 baseURL**：写一个 `setProviderBaseURL(raw, providerKey, value)`，按行定位 provider 块，只改 `baseURL:`；找不到则退回 `yaml.dump` 并在结果里标 `format: 'rewritten'`。
**R7 · 修 keep-alive**：`lib/relay.js:197-198` 改为 `if (!response.writableFinished) upstream.destroy()`。
**R8 · TLS 超时**：`tls.connect` 后 `setTimeout(timeoutMs, destroy)`，`secureConnect` 时清除。
**R9 · apply 后探活**：commit 后经新端口探活（5 s，失败重试 1 次）；失败自动回滚 → 502 `apply_unverified`；成功带 `verified: true`。
**R10 · 代理默认值**：probe 未指定 proxy 时用 `config.defaultProxy` 或 `config.proxies` 第一条；`start` 遇到未定义代理名抛 `unknown_proxy`（HTTP 400）。
**R11 · 客户端超时**：`client/client.js:13` 加 `signal: AbortSignal.timeout(20000)`，超时提示「超时，请刷新后查看结果」。

### P2 可做

R12 精确 host:port 去重（`lib/discovery/index.js:180`、`:211`）；R13 `installedBundles` 只取一次；R14 按账本清理多余 `.bak`；R15 `resolveProfileDir` 优先 `config.profileDir` / `DSH_PROFILE_DIR`。

## 四、数据模型（v4）

```json
{
  "version": 4,
  "routes": [{ "id": "llm:gemini", "target": "generativelanguage.googleapis.com:443",
               "listenPort": 8792, "proxy": "clash", "enabled": true, "verified": true }],
  "listeners": { "llm:gemini": { "ok": true, "port": 8792, "at": "2026-10-19T…" } },
  "backups": [{ "id": "b1", "routeId": "llm:gemini", "file": "…cordis.patch.yml",
                "backup": "…b1.bak", "sha256Before": "…", "sha256After": "…",
                "at": "…", "format": "surgical" }],
  "history": [{ "at": "…", "kind": "apply", "detail": "llm:gemini:8792" }],
  "discoveredAt": "…", "discovered": [], "warnings": [], "lastError": null
}
```

## 五、API 契约

| 调用 | 成功 | 失败 |
|---|---|---|
| `GET ?op=state` | `{ok:true, routes, listeners, history, warnings, backups:number}` | — |
| `GET ?op=discover` | `{ok:true, items, warnings}` | — |
| `POST ?op=probe {itemId?|target, proxy?}` | `{ok:true, verdict, direct, proxy}` | 403 `forbidden` / 400 `unknown_target` `private_target` |
| `POST ?op=apply {itemId, listenPort, target?}` | `{ok:true, route, verified, diff}` | 400 `invalid_port` `loopback_target` `unknown_proxy` / 409 `port_in_use` / 502 `listener_failed` `apply_unverified` |
| `POST ?op=rollback {routeId?, force?}` | `{ok:true, routes:[...]}` | 400 `no_backup` / 409 `file_changed_since_backup` |

统一错误体：`{ok:false, error:"<code>", message:"<中文说明>"}`。

## 六、测试要求

在现有 6 个文件基础上新增 ≥ 11 条（总数 ≥ 34）：

- store：版本升级、v2→v4 迁移、字段不丢。
- patcher：漂移 409、force 成功、定向写入保留中间注释与锚点。
- routes：未授权 probe 403、unknown_target、private_target、原子写失败回滚、`unknown_proxy`。
- manager：stop 清状态、未定义代理名报错。
- relay：连续两次请求复用上游连接；TLS 超时路径（可用假 socket 模拟）。
- client：超时分支（mock fetch 挂起）。

测试不得访问真实网络；一律用本地 stub 服务器（现有 `test/relay.test.mjs` 的假 CONNECT 代理可复用）。

## 七、交付物

1. 代码改动（版本号 → `0.2.2`）。
2. `CHANGELOG.md` 新增 `## 0.2.2`，逐条列出 R 编号。
3. `README.md` 更新「行为约定」新增：probe 限制、apply 验证、回滚漂移保护。
4. `node test\run-all.mjs` 输出（全绿，含用例数）。
5. `pnpm pack` 产物 `dsh-egress-router-0.2.2.tgz`，并安装进 `C:\Users\86139\.dsh\profiles\desktop`。
6. 一份 `REPORT-0.2.2.md`：改了哪些文件、每条 R 的证据、测试结果、安装结果、重启后的自查清单。

## 八、验收标准

1. 23 → ≥ 34 条用例全绿。
2. 重启后 `state.json` 为 `version: 4`，`routes` 保留，`/__health` 200。
3. 无 Origin 的 probe → 403；`{"target":"127.0.0.1:1"}` → 400 `private_target`。
4. 停掉 7897 后 apply → 502 `apply_unverified`，配置已回滚。
5. `stop()` 后 state 无残留失败监听。
6. 含注释的 fixture apply 后注释仍在（`format: surgical`）。
7. 卸载插件 + 还原 baseURL 后配置回到直连形态。

## 九、不要做

- 不要重构 relay 的转发架构、不要换隧道实现。
- 不要动 Telegram 的 pnpm patch、不要动 `.env`。
- 不要新增设置页标签、不要改 UI 布局（0.1.5 的窄屏修复保持）。
- 不要在未跑测试的情况下 bump 版本。
- 不要把修复记录只写在聊天里——必须落到 `REPORT-0.2.2.md`。

## 十、工作方式

1. 先读 `REVIEW-0.2.1.md` 与现有 5 个源码文件，产出「改动文件清单 + 每条 R 的落点」。
2. 按 R1→R5 顺序实现，每完成一条跑一次 `node test\run-all.mjs`。
3. 再实现 R6–R11，最后按需做 R12–R15。
4. 全部绿后 bump 版本、写 CHANGELOG/README/REPORT、pack、安装。
5. 交付时给出：测试数量、每个 R 的一句话证据、需要用户重启才能验证的项。
