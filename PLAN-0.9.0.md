# dsh-egress-router 0.9.0 方案：「看得见、带得走、装得下」

> 状态：已定稿并开始实施（0.8.0 已发布并推送，tag `v0.8.0`）。
> 目标版本：0.9.0。基线：0.8.0（75 个用例全绿）。

## 一、现状与差距（实测，不是推测）

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| G1 | 重启后流量指标归零 | 宿主 09:44 重启后 `state.json` 的 `metrics[*].startedAt` 变成重启时刻、`samples: 0`；指标只在 apply/rollback/dispose 时落盘 | 无法回答「今天经中转跑了多少、失败几次」 |
| G2 | 自定义端点不能被检查 | `lib/routes.js:379` 的 `knownTargets()` 只收「发现到的 + 已有路由」，`?op=probe` 对其它目标一律 400 `unknown_target` | 想验证一个暂时没进配置的域名，没有入口 |
| G3 | 出问题只能远程读状态 | 现在排障靠我连到机器读 `state.json` / 日志 | 用户无法自己导出一份可分享的现场 |
| G4 | 上游（Clash 节点）健康只能靠「应用」碰 | `verifyApply` 12s × 3 次只在 apply 时跑（`lib/probe.js:69`） | 节点掉线时先表现为「应用失败」，没有主动体检 |
| G5 | Telegram 仍必须打补丁 | `@xmanrui/dsh-im` 5.1.0 的配置 schema 没有 proxy 字段；`lib/index.js` 偏移 3848926 的 `EnvHttpProxyAgent` 只读进程 env | 0.9.0 不移除补丁，只做可见性（见「不做」） |

## 二、目标

1. **看得见**：指标跨重启累计（本次 + 总计），上游可达性一键体检。
2. **带得走**：一键导出脱敏诊断包，不必再靠远程登录。
3. **装得下**：`config.targets` 声明自定义端点，参与发现、检查、健康面板，但**永远不参与改写配置**。

非目标：不改变现有路由/改写/回滚语义；不引入新依赖；不做 npm 发布；不做 UI 重构。

## 三、范围

### P0-1 指标累计（v9）

- `lib/store.js`：`EMPTY.version = 9`，新增 `metricsTotals: {}`；`migrate` 归一（旧文件补 `{}`，不清已有）；新增 `mergeMetricsTotals(delta)`（只加不减，写 `since` 首次时间与 `updatedAt`）。
- `lib/index.js`：新增 `flushMetrics()` —— 读 `manager.metrics()`，与上次基线相减得到 delta；**计数回退时跳过该轮并重置基线**（watchdog 重建会让 session 计数归零，直接相减会得到负数并污染总量）；`setInterval(flushMetrics, 60_000).unref?.()`，`shutdown` 里 `clearInterval` 再 flush 一次。
- `lib/routes.js` 的 `?op=state`：`metrics[id].totals` 与 `metricsTotals`；`metricsTotals` 是独立键。
- 验收：重启后 `totals.requests` 保留；同一会话内多次 flush 不重复计数（用例断言两次 flush 后总量 == 1 次请求）。

### P0-2 诊断包 `?op=diagnose`

- 只读 GET，鉴权同 state（无需写意图）；返回一个可以直接发出去的 JSON：
  `{ apiVersion, generatedAt, plugin: {version, contract, hostEnv, profileOk, profileDir}, routes, listeners, metrics, metricsTotals, drift, paused, patches, bots, recentHistory(20), lastError, probes }`
- **脱敏规则**（写进测试）：`bots[*]` 只给 `envVar` 与布尔（`configured` / `envSet`），不给 `url`；`config.proxies` 的 URL 去掉 userinfo；备份路径只留 basename；`history` 截 20 条。
- 验收：导出内容里不出现 `@`/`://user:pass` 形态的凭据；不含 `config` 全量（避免泄露 apiKeyEnv 之外的东西）；小于 64KB。

### P1-3 自定义端点 `config.targets`

- 配置形态：
  ```yaml
  - id: egress-router
    config:
      proxies: { clash: http://127.0.0.1:7897 }
      targets:
        - { id: github, name: GitHub API, host: api.github.com, port: 443 }
  ```
- `lib/discovery/index.js`：`discover({ profileDir, routes, targets })` 追加 `custom:<id>` 行（`kind: 'custom'`、`custom: true`、`patchable: false`、`confidence: 'certain'`、`source: 'config.targets'`），与已有 target 去重。
- `lib/routes.js`：`knownTargets()` 并入 `config.targets`，于是 `?op=probe` / `?op=upstream` / UI「检查」都能用；`plan`/`apply` 仍只接受 `llm:` 行（自定义行没有 provider 可改）。
- 客户端：`kindLabel` 增加「自定义」，行内只给「检查」，不出现「应用/预检」。
- 验收：fixture 配置里一个自定义端点能在 `discover` 中出现并 probe 通过；对它调用 apply 仍被拒（`provider_not_found`）。

### P1-4 上游健康 `?op=upstream`

- `POST`（同 probe 的写意图校验），对每条活动路由的 target 用该路由的 proxy 做一次 `probeOnce`（TLS，`timeoutMs: 6000`），返回：
  `{ proxy: {name, url}, results: [{id, target, via, ok, ms, error}], ok }`
- 客户端头部新增「上游」按钮：结果为全绿显示「上游可达」，否则列出失败项与错误；不自动轮询（避免自己制造负载）。
- 验收：上游不可达时（假 proxy 端口）`ok:false` 且 `results[*].error` 含连接错误；上游正常时 `ok:true`。

### P2-5 API 版本化

- `?op=state` / `diagnose` 增加 `apiVersion: 1`；`test/api-surface.test.mjs` 锁定新键（`apiVersion`、`metricsTotals`）。

## 四、数据模型 v9

```jsonc
{
  "version": 9,
  "metricsTotals": {
    "llm:gemini": { "requests": 120, "bytesIn": 240000, "bytesOut": 512000, "errors": 1,
                    "since": "2026-10-20T05:12:00.000Z", "updatedAt": "2026-10-21T14:50:00.000Z" }
  }
}
```

迁移规则：只增不改；`metricsTotals` 缺失补 `{}`；未知键保留（前向兼容）。

## 五、API 契约

| op | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `state` | GET | 无 | 22 → 24 键（+`apiVersion` +`metricsTotals`） |
| `diagnose` | GET | 无 | 脱敏现场包 |
| `upstream` | POST+JSON | 同 probe（`assertWriteAllowed`） | 每路由一次 TLS 探活 |
| `probe` | POST+JSON | 同前 | 现在也接受 `config.targets` 里的目标 |

## 六、UI 变更（延续 DSH token 风格）

1. 指标行：`42 次 · ↓14.9KB · p50 231ms · 失败 1` → 追加 `· 累计 1.2k 次`（有 totals 时）。
2. 头部按钮：`扫描 / 端口检查 / 上游 / 诊断 / 回滚上次改动`；诊断按钮触发 JSON 下载 `egress-router-diagnose-<ts>.json`。
3. 自定义端点的徽章与按钮（只有「检查」）。
4. 所有新按钮沿用 `disabled: anyBusy` 与既有 aria 规则。

## 七、测试（新增 `test/insight.test.mjs`，≥ 6 条）

1. `mergeMetricsTotals` 累加、`since` 不变、`updatedAt` 更新。
2. 两次 flush 不重复：模拟 manager 计数 120 → flush → 仍是 120 → flush → 仍 120。
3. 计数回退（watchdog 重建）时该轮跳过，不产生负数总量。
4. `?op=diagnose` 脱敏：含 `envVar`、不含 proxy URL 的 userinfo、history ≤ 20、小于 64KB。
5. `config.targets` 出现在 discover，且 probe 接受、apply 拒绝。
6. `?op=upstream` 正常/异常两种结果形状。
7. API 快照：`apiVersion === 1`、`metricsTotals` 存在。

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 每分钟写盘 | 仅在 delta 非零时写；timer `unref`；`dispose` 清理 |
| 双计数 / 负计数 | delta + 计数回退检测（重建基线） |
| 诊断包泄露凭据 | 白名单字段 + userinfo 剥离 + 断言测试 |
| 自定义端点被误改写 | `patchable: false` + 服务端 `provider_not_found` 兜底 |
| 上游探活拖慢页面 | 只手动触发、6s 超时、结果写回消息区 |

## 九、时间

实现 + 测试 + 打包安装约 1.5–2 人日当量，本轮一次完成。

## 十、不做（明确排除）

- **Telegram 去补丁**：上游 `dsh-im` 没有 proxy 配置字段，只能等它加；本版只保证补丁状态可见（已有）。
- 指标写入独立时序文件 / 图表库：增加依赖与体积，收益低。
- 多实例共享、远程/多用户鉴权、npm 公开发布。
- 大改设置页布局。

## 十一、验收（6 条）

1. `node test/run-all.mjs` 全绿（≥ 75 + 新增 ≥ 6）。
2. `node scripts/check-syntax.mjs` 0 失败；`check-package` 通过。
3. 安装产物与仓库哈希一致；`?op=state` 返回 24 键且 `apiVersion === 1`。
4. 重启后 `metricsTotals` 仍在，UI 指标行显示「累计」。
5. 诊断包可下载且不含凭据（按测试断言人工抽查一次）。
6. 上游体检在 Clash 正常时全绿、断开时给出可读错误。
