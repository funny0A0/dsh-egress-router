# 回滚

## 先判断是哪一类

| 现象 | 回滚对象 |
| --- | --- |
| 新版本功能异常（设置页报错、应用失败） | 插件包 |
| 配置被改坏（provider 指向错误端口/地址） | `cordis.patch.yml` 与 state |
| 机器人连不上 | `.env` 托管块与补丁 |
| 端口被占 / 多实例 | 停掉旧宿主进程后再启动 |

## 回滚插件包

```powershell
cd C:\Users\<you>\.dsh\profiles\desktop
pnpm add "file:F:/projects_all/AI_projects/dsh-egress-router/dsh-egress-router-0.6.0.tgz"
```

旧 tgz 都在仓库根目录（每个版本一个）。装完**完全退出 DSH 再启动**：插件代码只在启动时加载。

## 恢复配置

每次应用/回滚/自愈都会写备份，位置：

- `%DSH_HOME%\storages\egress-router\backups\cordis.patch.yml.<时间戳>.<pid>.bak`
- 手工备份：`F:\projects_all\AI_projects\dsh-tools\backup-egress-<版本>-<时间戳>\`

恢复步骤：

1. 先停 DSH（否则监视器可能立刻把文件改回去）。
2. 把选定的 `.bak` 覆盖 `profiles\desktop\cordis.patch.yml`。
3. 需要清空路由时，编辑 `storages\egress-router\state.json`，把 `routes` 置为 `[]`（或删除整个文件，重启后按 `config.routes` 播种）。
4. 启动，确认 `?op=state` 的 `routes` 与 `listeners` 一致。

## 恢复机器人代理

0.7.2 起代理不再写 `.env`（启动器拒绝该变量，会导致 DSH 无法启动），只记录在
`storages\egress-router\state.json` 的 `bots` 里并在启动时注入本进程。

回到默认：设置页「清除」，或删掉 `bots` 里的 `telegram` 条目后重启。
若你从 0.7.0/0.7.1 升级，启动时会自动清掉旧 `.env` 受管块（`history` 里的 `env-cleanup`）。补丁在 `storages\egress-router\patches\telegram-proxy.bak`，设置页的「兼容补丁 → 复原」也会还原原文件。

## 完全卸载

```powershell
cd C:\Users\<you>\.dsh\profiles\desktop
pnpm remove dsh-egress-router
```

然后把 `cordis.patch.yml` 里各 provider 的 `baseURL` 改回公网地址（回滚按钮做的是同一件事），再删除 `storages\egress-router`。

## 验证

- 两个中转端口都不再监听：`Get-NetTCPConnection -LocalPort 8791,8792 -ErrorAction SilentlyContinue`
- 配置里没有 `127.0.0.1:879x`：`Select-String cordis.patch.yml '127\.0\.0\.1:87'`
- Gemini / OpenRouter 用真实请求各打一次。
