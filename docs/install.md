# 安装、升级与卸载

本插件是标准的 DSH profile 插件：装进某个 profile 的 `node_modules`，并在
`dsh.profile.bundles` 里登记。桌面版和 TUI 都能用，Windows 与 Linux 步骤相同（只是路径写法不同）。

## 前置条件

| 项 | 要求 | 检查 |
| --- | --- | --- |
| Node | ≥ 20 | `node -v` |
| DSH | 桌面版 ≥ 0.2.1-rc.2 | 设置 → 关于 |
| pnpm | 任意近期版本 | `pnpm -v` |
| 上游代理（可选） | `http://host:port` 形式的 HTTP CONNECT 代理 | `Test-NetConnection 127.0.0.1 -Port 7897` |

插件本身只依赖 `js-yaml`，不需要编译工具链。

## Windows 安装

```powershell
# 1) 进入 profile
cd "$env:USERPROFILE\.dsh\profiles\desktop"

# 2) 安装（本地 tgz 或已发布版本二选一）
pnpm add file:F:\projects_all\AI_projects\dsh-egress-router\dsh-egress-router-0.7.1.tgz
# pnpm add dsh-egress-router

# 3) 登记到 bundles（用编辑器改，或下面这行）
node -e "const f='package.json',fs=require('fs'),p=JSON.parse(fs.readFileSync(f,'utf8'));p.dsh.profile.bundles=[...new Set([...p.dsh.profile.bundles,'dsh-egress-router'])];fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
```

完全退出 DSH（托盘退出，确认 `DeepSeek Harness.exe` 全部消失）再启动。

## Linux / macOS 安装

```bash
cd ~/.dsh/profiles/desktop

pnpm add file:/path/to/dsh-egress-router/dsh-egress-router-0.7.1.tgz
# 或 pnpm add dsh-egress-router

node -e "const f='package.json',fs=require('fs'),p=JSON.parse(fs.readFileSync(f,'utf8'));p.dsh.profile.bundles=[...new Set([...p.dsh.profile.bundles,'dsh-egress-router'])];fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
```

如果设置了 `DSH_HOME`，把 `~/.dsh` 换成 `$DSH_HOME`。Linux 上 pnpm 的 store 可能位于
`~/.local/share/pnpm/store`；跨文件系统安装时会退化为复制，属正常现象。

重启 DSH 后打开 **设置 → 插件 → 出口路由**。

## 安装后自检

```powershell
# 版本与入口
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-egress-router\package.json" | Select-String '"version"'

# 状态（端口取自设置页地址栏，形如 http://127.0.0.1:50685）
Invoke-RestMethod "http://127.0.0.1:<port>/plugins/egress-router?op=state" | ConvertTo-Json -Depth 4

# 某个中转
Invoke-RestMethod "http://127.0.0.1:8792/__health"
```

期望：`state` 返回 `routes`、`listeners`、`patches`、`contract` 等 19 个字段；
`/__health` 返回 `{"ok":true,...}`。

## 升级

```powershell
# 本地 tgz
pnpm add file:F:\projects_all\AI_projects\dsh-egress-router\dsh-egress-router-0.7.1.tgz
# 已发布
pnpm add dsh-egress-router@latest
```

升级不会丢状态：`state.json` 会按 `version` 自动迁移，配置漂移会在启动后自动校正。
升级后建议看一眼「最近操作」里有没有 `host-contract` 与 `reconcile` 记录。

## 卸载

```powershell
# 1) 先把改过的 baseURL 回滚（设置页「撤销」，或手工改回 https://…）
# 2) 移除包
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm remove dsh-egress-router
# 3) 从 dsh.profile.bundles 删除 "dsh-egress-router"
# 4) 重启 DSH
```

状态目录 `$DSH_HOME/storages/egress-router` 可以保留（下次安装会复用），也可以整个删掉。
机器人代理记录在 `storages\egress-router\state.json` 的 `bots` 里，删掉该条目或点「清除」即可；`$DSH_HOME/.env` 不需要动（0.7.2 起不再写入，旧受管块会在启动时自动清理）。

## 安装期常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_PNPM_NO_MATCHING_VERSION` | 版本号不存在 / 未发布 | 用本地 tgz，或确认 npm 上的版本 |
| 页面没有「出口路由」 | 未登记 `bundles`，或未重启 | 检查 `package.json` 的 `dsh.profile.bundles` |
| `Cannot find package '@deepseek-ai/dsh'` 警告 | 核心包由宿主提供（peer） | 正常，忽略 |
| 安装后旧版本仍生效 | 进程未重启 | 完全退出 DSH 再启动 |
| Linux 上文件权限错误 | store 与 profile 跨用户/跨盘 | 用同一用户安装，或 `pnpm config set store-dir` 到同一分区 |
