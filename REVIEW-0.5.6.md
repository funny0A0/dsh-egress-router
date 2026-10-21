# dsh-egress-router 0.5.6 全身体检与发布前改进方案

> 体检时间：2026-10-21 · 版本：0.5.6 · 宿主：DSH 0.2.1-rc.2（桌面版）· Node 24.15.0
> 体检方式：静态检查（`node --check` 全部源码）、93 条测试全量运行、运行面 API 抽样、
> 产物审计（tarball 内容 / 安装副本逐文件哈希）、发布元数据审阅。
> 结论先行：**功能面健康，发布面不合格**。代码本身可以交付，但按 npm/市场发布的标准看，
> 它还缺版本控制、元数据、兼容性声明、CI 与产物审计。

---

## 1. 评分

| 维度 | 评分 | 依据 |
| --- | --- | --- |
| 功能完整性 | 8 / 10 | 发现、探测、端口、改写、事务回滚、转发、审计、机器人代理、配置自愈均已落地 |
| 正确性 | 8 / 10 | 93 条用例覆盖事务性、回环恢复、互改写、鉴权；仍有 3 处边界见 H6/H11/H12 |
| 测试 | 7 / 10 | 12 个文件 93 条、无外部依赖；缺覆盖率、缺 CI、缺跨宿主版本回归 |
| 安全 | 8 / 10 | 写操作全部要求 POST + JSON + 同源意图；私网/未知目标拒绝；body 256KB 上限 |
| 可维护性 | 6 / 10 | 路由 482 行单函数、客户端 980 行单文件；无分层、无 lint |
| 文档 | 5 / 10 | 中文 README 159 行完整，英文 26 行；缺快速上手与故障排查章节 |
| 兼容性 | 4 / 10 | 只声明 `0.2.1-rc.2` 一个版本，且依赖宿主未文档化契约 |
| 发布准备 | 3 / 10 | `private: true`、无 git、无 repository、无 CI、无产物断言 |

---

## 2. 通过项（可复现）

```powershell
cd F:\projects_all\AI_projects\dsh-egress-router
node test/run-all.mjs        # 93 pass / 0 fail，exit 0
Get-ChildItem lib,client,test -Recurse -Include *.js,*.mjs | % { node --check $_.FullName }
tar -tzf dsh-egress-router-0.5.6.tgz
```

- `node --check`：**0 失败**（lib 11 个文件、client 1 个、test 12 个）。
- 测试：**93 条通过**（bots 7 / client 4 / discovery 2 / hardening 22 / loopback-recovery 4 /
  observability 11 / patcher 7 / patches 12 / plugin 1 / reconcile 11 / relay 2 / write-safety 10）。
- 产物：tarball 20 个文件，含 LICENSE、README 双语、CHANGELOG、`patches/definitions.json`；
  未混入 `preview/`、历史 `.tgz`、REVIEW/PROMPT 文档。
- 安装副本：`lib/patcher.js`、`lib/reconcile.js`、`lib/routes.js`、`client/client.js`、
  `patches/definitions.json` 与仓库逐字节一致（`package.json` 差 1 字节，见 H15）。
- 运行面：2 条路由（gemini 8792/clash、openrouter 8791/direct）`listeners` 均 `ok=true`，
  `/__health` 两个端口均 200；`state.json` v7、backups 10、无 `reconcile-paused`。
- 资源上限：history 50、backups 20、ttfb 采样 200、body 256KB —— 都不会无界增长。
- 补丁写入用 `tmp + rename`，不会原地改 pnpm store 的硬链接；备份文件先于写入落盘。

---

## 3. 问题清单

### P0 — 发布阻断

**H1 包元数据不可发布**
`package.json` 里 `"private": true`，且没有 `repository` / `author` / `homepage` / `bugs` /
`publishConfig`。现在 `npm publish` 会直接拒绝；即使去掉 `private`，也拿不出可审计的来源。

**H2 兼容性只声明了一个宿主版本**
```json
"compatibility": { "dsh": ">=0.2.1-rc.2 <0.3.0", "dshReleases": { "0.2.1-rc.2": "compatible" } }
```
DSH 还在 rc 阶段，宿主下一版（0.3.x 或新 rc）会被插件管理器判为不兼容而拒绝启动。
清单里只写一个版本，等于把「能不能装」押在宿主的版本号上。

**H3 没有版本控制**
仓库根没有 `.git`。无法给发布打 tag，无法回溯「0.5.4 到底改了什么」，也无法提供
source provenance。线上装的是哪个 tgz 只能靠 `dsh-tools\backup-*` 目录猜。

**H4 依赖宿主未文档化的契约，且没有降级路径**
用到三处：`hostCtx.webServer.register({ kind: 'exact', path, handler })`、
`ctx.slots.inject('settings.plugins.tab', …)`、`package.json` 的 `dsh.client` 段。
宿主换一种注册方式或槽位改名，插件要么启动失败，要么静默没有界面（0.1.1 那次就是
槽位名写错、只留一句 `console.warn`）。目前只有 try/catch，没有「探测 → 降级 → 告知」。

### P1 — 发布前应修

**H5 机器人代理只在进程内生效，依赖加载顺序**
`restoreBots()` 在插件启动时 `process.env.DSH_TELEGRAM_PROXY = …`，但 dsh-im 可能先于本插件
加载并建连。更稳的做法是把该变量写进 `$DSH_HOME/.env`（宿主在加载任何插件前读取），
本进程赋值只作为兜底。

**H6 客户端把「非 JSON 响应」原样抛给用户**
`client/client.js:273-281` 直接 `res.json()`。宿主路由 404、网关返回空体时，界面显示
`接口不可用：Failed to execute 'json' on 'Response': Unexpected end of JSON input`
—— 今天排障时用户看到的就是这句，它对定位毫无帮助。应改为：先读 text，空了就报
「插件接口未就绪（可能未重启或版本不匹配）」。

**H7 六个界面文案键从未接线**
`noTraffic`、`noProxy`、`planPortFree`、`viaProxy`、`botBot`、`staleHint` 定义了却没用。
它们对应的正是「没有流量」「直连」「端口可用」「经代理」这类状态 —— 不是死代码，
是**界面缺了状态表达**（例如 stale 行有徽章但没有说明文字）。

**H8 英文 README 只有 26 行**
中文 159 行（含版本史、行为约定、故障排查），英文只有标题和一句介绍。对外发布时，
英文文档是市场页面的默认展示。

**H9 没有 CI**
`test/run-all.mjs` 是自研 runner（因为沙箱里 `node --test` 的 worker 会 `spawn EPERM`），
但 CI 环境没有这个限制，应改用 `node --test` 并加覆盖率。

**H10 仓库根混着 23 个历史 tgz 与开发文档**
`dsh-egress-router-0.1.0.tgz` … `0.5.6.tgz`、`REVIEW-*.md`、`PROMPT-*.md`、`preview/`。
`files` 白名单保证它们不入包，但仓库噪音会让「发布前检查」变得不可信。

**H11 回环恢复仍会走进死局**
0.5.6 补了 4 个内置端点（openrouter / gemini / moonshot / deepseek）。其它 provider 一旦
`baseURL` 停在回环、本地又没记录，仍然只能报「请手动恢复」。应给界面一个「原始地址」输入框，
由用户填一次并记入账本。

**H12 reconcile 暂停状态不落盘、也不显示**
熔断只活在内存（`pausedUntil` Map）。重启后重新计数；界面也看不出「已暂停修复」，
用户只会觉得「插件不管我的配置了」。

### P2 — 可以排进日常

**H13 客户端 47 KB 未压缩、无构建**
设置页加载可接受，但发布前应至少给出 gzip 后体积（预计 12–14 KB），并考虑把
`client/client.js` 拆成 `i18n.js` + `styles.js` + `panel.js`。

**H14 可访问性欠账**
输入框没有 `<label for>` / `id` 关联，徽章没有 `aria-label`，按钮焦点态未在真实主题下验证。

**H15 `package.json` 与安装副本差 1 字节**
pnpm 打包会去掉行尾换行。做「仓库 = 安装」哈希对比时永远显示 DIFF，属于噪音；
应统一为「打包前写入不带尾换行」或对比时归一化。

**H16 版本号三处手抄**
`package.json`、`CHANGELOG.md`、`README.md` 各写一次，0.4.4 就出现过打包时版本没跟上
（脚本引号写错，`.tgz` 已生成但 `version` 仍是 0.4.3）。应由脚本一处改写、三处校验。

---

## 4. 改进方案

### 0.6.0 — 稳定性收尾（1–2 人日）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| H6 | `call()` 先读 text 再解析；空体/HTML 给明确文案 | 模拟 404 空体，界面显示「插件接口未就绪」，不出现 JSON 解析错误 |
| H11 | 回环行显示「原始地址」输入，提交后记入 `originBaseURL` 账本 | 账本为空时仍可一键恢复任意 provider |
| H5 | bot 代理同时写 `$DSH_HOME/.env`（带托管标记，回滚时删除） | 冷启动后 dsh-im 首个请求即经代理 |
| H7 | 六个文案键接线或删除 | 无孤儿键；stale 行有说明文字 |
| H12 | `paused` 写进 `state.reconcile`，界面黄条提示 | 熔断后刷新仍显示「已暂停 10 分钟」 |

### 0.7.0 — 发布准备（2–3 人日）

**A. 包与来源**
- 去掉 `private`；补 `repository` / `author` / `homepage` / `bugs` / `publishConfig.access=public`。
- `git init`，建立 `vX.Y.Z` tag 与 `CHANGELOG` 对应；发布脚本校验 tag 与 `package.json` 一致。
- 版本号单一来源：`scripts/version.mjs bump <version>` 同时改 `package.json` / `README` / `CHANGELOG`，
  `scripts/version.mjs check` 在 CI 里跑。

**B. 兼容性矩阵（核心）**

| 宿主版本 | 状态 | 说明 |
| --- | --- | --- |
| 0.2.0-rc.2 | 未测 | 可能缺 `webServer.register kind:'exact'`，需实测后再声明 |
| 0.2.1-rc.2 | 已验证 | 当前生产环境：路由、槽位、补丁、机器人全部通过 |
| 0.3.x | 待适配 | 跟随 rc 逐个验证，不预先声称兼容 |

- `dsh.compatibility.dsh` 改为开区间（如实测通过 0.2.0-rc.2 则写 `>=0.2.0-rc.2`），
  `dshReleases` 逐版本写 `compatible` / `partial` / `incompatible`。
- **运行时特性探测**（替代版本号猜测）：
  1. `webServer.register` 是否接受 `kind:'exact'` → 否则尝试无 `kind` 的旧签名；
  2. `slots.inject('settings.plugins.tab')` 是否存在 → 否则注册到旧槽位，都没有则只保留 API 模式；
  3. `dsh` 清单字段读取失败 → 记录一条 `host-contract` 历史，界面显示降级说明。
- **状态迁移前向兼容**：`store.migrate` 只增字段、不删字段；新增 `state.schemaVersion` 暴露在
  `?op=state`；每次迁移补一条用例（v6→v7 已有先例）。
- **API 契约快照测试**：把 `?op=state` 的键集合、错误码集合固化成断言，
  宿主/依赖升级导致行为变化时第一时间失败。

**C. 质量门**
- GitHub Actions：`windows-latest` × `ubuntu-latest`，Node 20/24，跑 `check` / `test` /
  `npm pack --dry-run` 内容断言 / 版本一致性。
- 产物断言脚本：包内必须含 `LICENSE`、双语 README、`patches/definitions.json`；
  不得含 `preview/`、`*.tgz`、`REVIEW-*`、`PROMPT-*`；总字节上限 150 KB。
- 覆盖率：`c8` 跑 `node --test`，门槛先定 70%，路由层与 store 层单列。

**D. 文档**
- README 双语对齐，新增三段：**60 秒上手**（装 → 重启 → 设置里点「扫描」→ 选端点 → 应用）、
  **故障排查**（代理未启动 / 端口漂移 / 配置被改写 / 接口 404）、**安全边界**
  （本机 API 不做鉴权，但写操作要求同源意图；谁能在本机跑进程，谁本来就能改文件）。
- `docs/compatibility.md`：兼容矩阵 + 每个版本「怎么验、验到什么程度」。
- `docs/rollback.md`：五步回到出厂（停插件 → `pnpm remove` → 恢复 `cordis.patch.yml` 备份 →
  删 `storages/egress-router` → 重启）。

**E. 发布流程**
1. `0.7.0-rc.1` 先自用两周（当前环境就是最好的 dogfood）。
2. `npm publish --access public --provenance`（带 tag 与仓库地址）。
3. 市场登记：`awesome-dsh-plugin.com/plugins.json` 与 `dsh-plugin-catalog`，
   附兼容矩阵、截图（`preview/harness-light.png` 可复用）、回滚说明。
4. 发布后 48 小时观察 `reconcile-paused` / `patch-repair` 两类历史，异常则 `npm deprecate` 并回退。

### 0.8.0 — 能力扩展（3–5 人日，可选）

- 端点映射表可扩展（用户自定义 provider → 公网地址），替代内置 4 条。
- 指标面板：把已有 `metrics` 画成 24h 折线（请求数 / p50 / 错误），加「导出 JSON」。
- 机器人适配层泛化：微信 / QQ / Telegram 统一成 `BOT_TARGETS` 的声明式条目。
- 多路复用调优：`maxSockets` 自适应（按 p95 排队时间），而非固定 6。

---

## 5. 发布前兼容性准备清单（gate）

| # | 项目 | 现状 | 目标 | 验收方式 |
| --- | --- | --- | --- | --- |
| 1 | 包元数据 | `private: true`、无 repository | 可发布、可追溯 | `npm publish --dry-run` 通过 |
| 2 | 兼容声明 | 1 个宿主版本 | ≥3 个版本 + 未来 rc 策略 | `dshReleases` 覆盖矩阵每一行 |
| 3 | 宿主契约 | 硬依赖、仅 try/catch | 特性探测 + 降级 | 模拟缺 `slots` / 缺 `kind` 仍能启动 |
| 4 | 状态迁移 | v7 | 前向兼容 + 用例 | v6→v7→v8 连续迁移测试 |
| 5 | API 快照 | 无 | 键集合/错误码固化 | 破坏性变更时测试失败 |
| 6 | CI | 无 | Win/Linux × Node 20/24 | 红灯即阻断合并 |
| 7 | 产物审计 | 手工肉眼 | 脚本断言 | 包内容/体积/必需文件三项 |
| 8 | 版本一致性 | 三处手抄 | 单一来源 | `version.mjs check` 通过 |
| 9 | 文档 | 中文完整、英文 26 行 | 双语对齐 + 三篇专题 | 市场页面可直接用 |
| 10 | 安全审查 | 写操作鉴权已有 | 补威胁模型段落 | 文档含「谁能调用本机 API」 |
| 11 | 市场登记 | 未提交 | 已上架 | 市场能搜到、安装成功 |
| 12 | 回滚演练 | 有备份目录 | 文档化五步 | 按文档在新环境复现一次 |

---

## 6. 风险

1. **宿主 rc 变更**：兼容矩阵只能覆盖已测版本；缓解是特性探测 + API 快照，而不是猜版本号。
2. **补丁机制与 pnpm 布局**：`pnpm patch` 与自带 `patches/` 双轨并存，`nodeLinker` 换成 `isolated`
   时 `locatePackage` 的 realpath 逻辑需要重测（当前只验证了 `hoisted`）。
3. **互改写重演**：宿主若持续把 `baseURL` 改成自己的回环端口，熔断只能「停手」，不能「修好」；
   届时应把该 provider 标记为「宿主托管」并从界面移除应用按钮。
4. **发布后支持成本**：每个宿主 rc 都要回归，估算 1–2 小时/版本；0.7.0 的 CI 就是为此降本。

---

## 7. 一句话总结

插件本体已经能干活，缺的是「让别人敢装」的那一层：**来源可追溯、兼容性可声明、
降级可预期、产物可审计**。0.6.0 把行为收干净，0.7.0 把交付面补齐，之后才谈 0.8.0 的扩展。
