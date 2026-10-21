# dsh-egress-router

> **只让需要代理的端点走代理，其余全部直连。**
> 一个 DSH 插件：给单个外连目标开一个本机端口，请求经它转发；没开端口的目标照旧直连。

[![ci](https://github.com/funny0A0/dsh-egress-router/actions/workflows/ci.yml/badge.svg)](https://github.com/funny0A0/dsh-egress-router/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A520-informational)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational)
![license](https://img.shields.io/badge/license-MIT-informational)

---

## 为什么需要它

DSH 的传输策略是**「每个进程只有一个答案」**：`@deepseek-ai/dsh-http-proxy` 在进程启动时读一次
`HTTPS_PROXY`，之后所有出站 HTTPS 都走同一个代理，没有 per-provider 开关。

于是只要设了全局代理，而代理客户端没在跑（或节点被墙、被限速），就会一起坏：

| 走代理的请求 | 后果 |
| --- | --- |
| `platform.deepseek.com`（账号资料、余额） | 设置页显示「账号资料暂不可用」 |
| 插件市场目录（`awesome-dsh-plugin.com`、npm registry） | 「插件目录加载失败」 |
| `pnpm add` 安装/升级插件 | 装不上，插件版本停在旧的 |
| 会话本身 | **正常**——因为 `api.deepseek.com` 在 `NO_PROXY` 里直连 |

三种做法对比：

| 做法 | 故障半径 | 配置粒度 |
| --- | --- | --- |
| 全局 `HTTPS_PROXY` | 代理一挂，账号 / 市场 / 安装 **全挂** | 进程级，不可分 |
| 全部直连 | 需要代理的端点（Google 系等）不可用 | 无 |
| **本插件** | 只有一个中转挂了才影响那一个目标 | **每个目标** |

## 它做什么

| 能力 | 说明 |
| --- | --- |
| **逐目标路由** | 每个目标一个 `127.0.0.1` 端口，可选「直连」或某个上游代理；端口可自定义 |
| **发现** | 从 `cordis.patch.yml`、`.env`、已装插件的默认配置里找工作区外的 HTTPS 目标，标出「已路由 / 待确认 / 受保护」 |
| **探活** | 同一目标分别试直连与经代理，返回能否连通、耗时、是否只到 TLS |
| **改写 + 回滚** | 只改 provider 的 `baseURL` 一行（保留注释与锚点），改前备份、改后校验，失败自动还原 |
| **应用后自检** | 起监听 → 真实请求一次目标 → 不通就回滚，不会「看起来成功、用起来失败」 |
| **指标** | 每个端口的请求数、上/下行字节、失败数、状态码分布、首字节延迟 p50/p95 |
| **机器人代理** | Telegram 这类把地址写死在代码里的插件：补丁 + `DSH_TELEGRAM_PROXY`，并写进 `.env` 供下次启动 |
| **兼容补丁** | 声明式补丁（包名 / 版本 / 文件 / 唯一锚点），重装后被冲掉会在下次启动自动修复 |
| **漂移自愈** | 配置里的 `baseURL` 与运行监听不一致时自动校正；被外部反复改写则暂停并显示原因 |
| **宿主契约探测** | 不靠版本号猜接口形状，依次尝试三种注册方式，结果记入状态 |
| **中英双语** | 跟随浏览器语言 |

## 工作原理

```
              ┌──────────────────────── DSH 宿主进程 ────────────────────────┐
 provider ───▶│ baseURL = http://127.0.0.1:8792/v1beta/openai                │
 (cordis      │            │                                                  │
  patch)      │            ▼                                                  │
              │   RelayManager（每个路由一个 http.Server，只绑 127.0.0.1）    │
              │            │  keep-alive，TLS 复用                            │
              └────────────┼──────────────────────────────────────────────────┘
                           ▼
                 CONNECT 隧道 ──▶ 上游代理（可选，如 clash 127.0.0.1:7897） ──▶ 目标
```

三个要点：

1. **路由存在 `state.json`，不写进配置。** `cordis.patch.yml` 里只留一条 `id` 覆盖（`proxies` 等）。
2. **重启自动重建。** 监听由持久化的 `routes` 恢复；配置漂移会被校正。
3. **写配置是外科手术。** 只替换 provider 的 `baseURL` 值，其余字节不动；同时留备份与账本。

## 安装

前置：**Node ≥ 20**、**DSH 桌面版 ≥ 0.2.1-rc.2**、`pnpm`。

### Windows

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add file:F:\projects_all\AI_projects\dsh-egress-router
# 或在发布后： pnpm add dsh-egress-router
```

### Linux / macOS

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:/path/to/dsh-egress-router
# 或在发布后： pnpm add dsh-egress-router
```

然后在 `profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加入 `"dsh-egress-router"`，
重启 DSH。页面：**设置 → 插件 → 出口路由**。

安装与升级的完整说明见 [docs/install.md](docs/install.md)。

### 安装后自检

```powershell
# 1) 版本
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-egress-router\package.json" | Select-String version
# 2) 接口（端口随实例变化，从设置页地址栏取）
Invoke-RestMethod "http://127.0.0.1:<GUI端口>/plugins/egress-router?op=state"
# 3) 某个中转是否活着
Invoke-RestMethod "http://127.0.0.1:8792/__health"
```

## 快速上手

1. **扫描** —— 列出模型 provider、Telegram、以及配置里的其它 HTTPS 目标。
2. **检查** —— 看「直连」和「经代理」哪个通；不确定的点「找端口」拿一个空闲端口。
3. **选代理** —— 每行一个下拉：`直连` 或 `config.proxies` 里的名字（如 `clash`）。
4. **应用** —— 写入 `baseURL`、起监听、真实请求一次自检；成功后再点一次刷新即可看到「运行中」。
5. **重启 DSH**（首次或改端口后）。之后监听随宿主重建，不需要再动配置。

## 设置页说明

**顶部**：`扫描`（重新发现）、`端口检查`（批量看占用）、`回滚上次改动`（最近一次应用的逆操作）。

**每一行**

| 元素 | 含义 |
| --- | --- |
| `模型` / `消息` / `外连` | 目标类型；`外连` 表示从配置里扫到但无法判定用途（标「待确认」） |
| `已路由` | 这个目标当前指向本机中转 |
| `运行中 :8792` / `未运行` | 监听是否真的起来了 |
| `42 次 · ↑14.9KB ↓86.1KB · p50 231.4ms · 5xx 1` | 该端口累计指标；`尚未有流量` 表示还没请求过 |
| `经 clash` / `直连` | 该行选中的上游 |
| `检查` `预检` `找端口` `应用` `测试` `撤销` | 探活、看 diff、取空闲端口、落盘生效、经中转发一次真实请求、按项回滚 |

**兼容补丁**：列出声明式补丁的状态（`已生效` / `待应用` / `锚点缺失` / 包未安装）。
`已生效` 且无备份时说明补丁来自 `pnpm patch`，只读。

**最近操作**：最近 10 条审计（应用、回滚、补丁、启动、配置校正、暂停）。

## 配置

### `cordis.patch.yml`（只留代理表）

```yaml
- id: egress-router
  config:
    proxies:
      clash: http://127.0.0.1:7897
```

> 不要写 `name: dsh-egress-router`：`bundles` 已经加载了本插件，再写 `name` 会被当成第二个实例。

### `$DSH_HOME/storages/egress-router/state.json`

`version: 8`、`schemaVersion: 1`。主要字段：

| 字段 | 说明 |
| --- | --- |
| `routes[]` | `{ id, target, listenPort, proxy, tls, tuning, originBaseURL }` |
| `listeners[]` | 最近一次同步结果（`ok` / `error`），重启后可见 |
| `metrics{}` | 每个路由的计数与延迟分位（样本在内存，重启从零累计） |
| `backups[]` | 配置备份账本（最多 20 条），回滚依据 |
| `patches{}` | 补丁账本（自修复只处理这里记录过的） |
| `bots{}` | 机器人 → 代理映射（写 `.env` 的受管块） |
| `history[]` | 审计流水（最多 50 条，重复行 60s 内折叠） |
| `hostContract` / `hostEnv` | 宿主接受的注册形状与当时的平台/Node 版本 |
| `reconcilePaused{}` | 漂移自愈的暂停窗口（原因 + 到期时间） |

### `$DSH_HOME/.env`（受管块）

```
# dsh-egress-router (managed) — bot egress
DSH_TELEGRAM_PROXY=http://127.0.0.1:7897
# dsh-egress-router (managed) end
```

只替换这一块，其余内容与 LF 换行保持原样（Windows 上也不会写入 `\r`）。

## HTTP 接口

`GET|POST http://127.0.0.1:<GUI端口>/plugins/egress-router?op=<op>`

| op | 方法 | 说明 |
| --- | --- | --- |
| `state` | GET | 页面所需的全部状态（19 个键，见 `test/api-surface.test.mjs`） |
| `discover` | GET | 重新扫描目标并缓存 |
| `probe` | POST | 探活；只接受已扫描到的目标，拒绝私有地址 |
| `plan` | POST | 只算 diff / 端口 / 警告，不写文件 |
| `ports` | GET | `?op=ports&port=8791&port=8792` 批量查占用 |
| `suggest` | POST | 取一个空闲端口（跳过本插件已占用的） |
| `apply` | POST | 应用：起监听 → 写 `baseURL` → 自检；失败自动回滚 |
| `rollback` | POST | 按项或全局回滚最近一次改动 |
| `test` | POST | 经已完成的中转发一次真实请求 |
| `patches` / `patch` | GET / POST | 兼容补丁列表 / 应用 / 复原 / 复查 |
| `bot` | POST | 给机器人设代理（写 `.env` 受管块） |
| `reconcile` | POST | 处理配置漂移（或解除暂停） |

写操作要求 `POST` + `content-type: application/json`；来自明确外来 web Origin 的请求返回 `403`。

常见错误码：`invalid_port`、`port_in_use`、`provider_not_found`、`not_patchable`、
`private_target`、`unknown_target`、`unknown_proxy`、`apply_unverified`、`listener_failed`、
`file_changed_since_backup`（409）、`no_backup`、`stale_plan`（409）、`invalid_tuning`、
`unauthorized`（403）、`reconcile_paused`（409）。

## 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 设置页「账号资料暂不可用」「插件目录加载失败」 | 进程里有指向未运行代理的 `HTTPS_PROXY` | 删掉 `$DSH_HOME/.env` 里的全局代理，改用本插件按目标代理 |
| 「接口不可用：Unexpected end of JSON input」 | 页面请求拿到空响应（插件 API 未挂载/宿主重载中） | 完全退出 DSH 再启动；页面会显示契约降级提示 |
| 「应用失败：port … is already in use」 | 端口被别的进程占用 | 点「找端口」取一个空闲端口再应用 |
| 「目标连不上，已自动回滚」 | 上游代理没起、节点被墙、目标域名错 | 先点「检查」；`/__health` 看中转是否在跑 |
| 「宿主没有接受任何已知的接口注册形状」 | 宿主契约变了 | 路由与中转仍工作；把 `state.hostContract` 反馈到 issue |
| 配置反复被外部改写 | 宿主与插件互相纠正 | 页面黄条点「恢复检查」；60s 内 3 次会自动暂停 10 分钟 |
| Telegram 机器人连不上 | 其传输只读进程环境变量 | 该行选代理 →「用这个代理」（补丁 + `.env`），重启 |
| 应用成功但没生效 | 改端口 / 改目标后需要重建监听 | 重启 DSH |
| 市场 / npm 装不上 | 安装走 registry 直连 | 确认 `registry.npmjs.org` 可达；本插件不代理它 |

## 兼容性

| 宿主 | 平台 | 状态 |
| --- | --- | --- |
| DSH 桌面版 `0.2.1-rc.2` | Windows 11（Node 24） | **实测通过**（本机） |
| DSH 桌面版 `0.2.0-rc.2` | Windows / Linux | 未实测（契约探测会尝试三种形状） |
| 其它 `0.2.x` | Windows / Linux | 未实测；失败时显式降级 |

Linux 侧的 CI 覆盖见 `.github/workflows/ci.yml`（Windows/Linux × Node 20/24：语法检查、测试、打包门禁）。
细节与升级检查清单：[docs/compatibility.md](docs/compatibility.md)。

## 安全边界

- 只绑 `127.0.0.1`，不对局域网/公网开放。
- 写操作需要 JSON POST + 同源意图；不返回任何 `Access-Control-*`，跨源请求会在预检阶段被浏览器拦下。
- **受保护目标**（`platform.deepseek.com`、`api.deepseek.com`、`registry.npmjs.org`、插件市场目录源）
  只展示、不建议改写——它们是账号、安装、市场的命脉，绕中转只会扩大故障面。
- 改配置前备份、写入后重新解析校验、失败还原；补丁要求锚点唯一且原文件可复原。

## 已知限制

- 不能替代**别的插件进程内部**的 HTTP 客户端；这类目标要么插件自己支持代理，要么用兼容补丁。
- 只转发 HTTP/1.1；不支持 HTTP/2 明文升级、SOCKS、PAC。
- 上游代理只支持 `http://host:port`（CONNECT 隧道），不支持需要认证的代理。
- 指标中的 p50/p95 样本只在内存，重启后从零累计。
- 兼容补丁绑定包版本前缀；插件升级后可能需要更新补丁锚点（启动时会报「锚点缺失」）。

## 开发

```bash
npm test               # 105 条测试（自带 runner：node --test 在沙箱内 worker 会 EPERM）
npm run check          # 所有模块 node --check
npm run check:package  # 打包门禁：必备/禁入文件、体积
npm run version        # 校验版本号在 README 与 CHANGELOG 都有记录
```

目录：

```
lib/            插件后端（入口、manager、relay、discovery、patcher、routes、store、bots、patches、reconcile、probe、ports）
client/         设置页 bundle（无构建，纯 ESM + h()）
patches/        声明式兼容补丁定义
docs/           安装、兼容矩阵、回滚
preview/        离线渲染 harness 与明暗截图
test/           14 个套件，105 条用例
scripts/        发布门禁
```

## 版本历史

| 版本 | 主题 |
| --- | --- |
| 0.1.0 | 首个可用版本：发现、探测、逐目标端口、带备份的改写与回滚 |
| 0.2.0 | 路由持久化、回滚卸监听、写入鉴权、失败不改配置 |
| 0.2.1 | 单实例化：路由移入状态、同端口幂等、按项撤销 |
| 0.2.2 | 加固：状态版本化、单事务落盘、探测收敛、连接复用、应用即验证 |
| 0.2.3 | 修复桌面版 `dsh-app://app` 页面被 403 挡住 |
| 0.2.4 | 自检放宽到 12s × 3 次，失败显示真实原因 |
| 0.3.0 | 指标、真实测试、HTTP 层探活、预检、端口批量检查、参数可调、双语 |
| 0.4.0 | 声明式兼容补丁（唯一锚点、备份、启动自修复） |
| 0.4.1 | 单实例守卫、审计去重、退出落盘、界面改用 DSH 设计 token |
| 0.4.2 | 修正 token 名称与取值，明暗主题可读 |
| 0.4.3 | 「找端口」与 `?op=suggest`，应用自动补端口 |
| 0.4.4 | 每行代理选择器（直连 / clash） |
| 0.5.0 | 机器人代理接管（补丁 + 环境变量 + 状态） |
| 0.5.1 | 配置自愈：检测并修复 `baseURL` 指向旧端口 |
| 0.5.2 | 热重载接管：新实例先拆旧实例，修复 404 空体 |
| 0.5.3 | 应用/回滚后同时刷新状态与发现列表 |
| 0.5.4 | 回环恢复：撤销后重应用取回真实端点 |
| 0.5.5 | 监视器读实时路由 + 熔断，已删路由不再写回 |
| 0.5.6 | 内置端点兜底（openrouter / gemini / moonshot / deepseek） |
| 0.6.0 | 舒适度：`.env` 持久化、空响应可读、原始地址可补、暂停可见 |
| 0.7.0 | 发布准备：契约探测、API 快照、门禁、CI、发布/回滚文档 |
| 0.7.1 | 跨平台：profile 根目录上溯、记录运行环境、契约降级提示、平台测试、README 重写 |

完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT
