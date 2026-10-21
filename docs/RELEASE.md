# 发布清单

发布一个版本 = 一次可回滚的、有证据的变更。下面的顺序不能跳步：每一步都要有「我看到了什么」，
而不是「应该没问题」。命令默认在仓库根执行。

## 0. 先决条件

- 在 `main` 上，工作区干净（`git status --short` 为空）。
- `node -v` ≥ 20；`npm -v` ≥ 9（`npm pack --json` 的形状依赖它）。
- 能访问 `registry.npmjs.org`（发布）与 `github.com`（推送）。本机直连不通时临时加 `-c http.proxy=http://127.0.0.1:7897`，不要改全局配置。
- 目标宿主已在本机安装（真机验收需要）；`DSH_HOME` 默认为 `~/.dsh`。

## 1. 改版本号（单一来源）

```bash
node scripts/version.mjs            # 打印当前版本，并检查 README / CHANGELOG 是否已写该版本
node scripts/version.mjs --set 0.9.1
```

`--set` 只改 `package.json`。随后必须手工补齐：

- `CHANGELOG.md` 顶部新增 `## <version>`，按「修了什么 → 为什么 → 影响谁」写，不要只写「优化」。
- `README.md` 版本历史加一行 `<version> — <一句话>`；`README.en.md` 同步。
- 若改了对外接口：更新 README 的接口表；破坏性改动升 `apiVersion` 并写迁移说明。

## 2. 本地门禁（四项，缺一不可）

```bash
npm run check            # 语法：lib / client / test / scripts
npm test                 # 全部用例；失败就先修，不要带着红发布
npm run check:package    # 产物白名单、体积上限、必备文件
npm run install-smoke    # 打包 → 干净 consumer 安装 → 启动已安装副本 → 校验对外契约
```

`install-smoke` 是发布前最接近用户的一次验证：它跑的是 **tarball**，不是源码树。
0.7.x 的 `exports["./client"]` 缺失与 profileRoot 少上溯一层，都是这类检查才能发现的。

## 3. 检查产物内容

```bash
npm pack --dry-run --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const p=Array.isArray(j)?j[0]:Object.values(j)[0];console.log(p.files.map(f=>f.path).sort().join('\n'))})"
```

必须包含：`lib/**`、`client/client.js`、`cordis.patch.yml`、`patches/definitions.json`、
`README.md`、`README.en.md`、`CHANGELOG.md`、`LICENSE`、`docs/**`、`package.json`。
不得包含：`test/`、`preview/`、`*.tgz`、`REVIEW-*`、`PROMPT-*`、`node_modules/`、`.bak`、`.git`。

## 4. 真机验收（Windows / Linux / macOS 各自一遍）

在目标宿主里安装 tgz 并重启：

```bash
cd <profile 目录，通常 ~/.dsh/profiles/desktop>
pnpm add file:<绝对路径>/dsh-egress-router-<version>.tgz
```

重启后逐条确认，任一失败就回滚（见第 7 步）：

1. 设置 → 插件 → 「出口路由」标签页存在，无红条 / 黄条。
2. 面板顶部无「接口不可用」；`?op=state` 返回 200，`schemaOk: true`，`profileOk: true`。
3. 已有一条路由时，`/__health` 返回 `{"ok":true,...}`；点「应用」显示成功且需重启时提示正确。
4. 「诊断」下载的 JSON 不含明文密码 / token；`history` ≤ 20 条。
5. 「上游」探活结果与手测一致（例如关掉 Clash 后 gemini 行应报失败）。
6. 若装过兼容补丁：启动日志无 `patch attention needed`，`?op=patches` 为 `applied`。
7. 退出宿主，确认监听端口随进程消失（没有幽灵 node 进程）。

把结果记进 `docs/compatibility.md` 的「实测记录」表。

## 5. 提交与打标

```bash
git add -A
git commit -m "dsh-egress-router <version>: <一句话>"
git tag -a v<version> -m "dsh-egress-router <version>"
git push origin main
git push origin v<version>
```

F: 盘仓库需要 `-c safe.directory=<repo>`；大量 `LF will be replaced by CRLF` 警告无害。
推送后用 GitHub API 核对 `main` 的 sha 与 tag 是否存在，不要只看本地命令的退出码。

## 6. 发布到 npm 与市场

```bash
npm publish            # 二因素开启时按提示输入 OTP
npm view dsh-egress-router version dist.tarball
```

- 包必须保持 `publishConfig.access = public`，`dsh.compatibility.dsh` 与 `dshReleases` 如实填写。
- 市场收录：`keywords` 含 `dsh-plugin`；在 `awesome-dsh-plugin.com` 的索引仓库提 PR（字段：name、repo、description、version、screenshots）；`dsh-plugin-catalog` 由 registry 自动扫描，发布后 10–30 分钟可见。
- 发布后从市场安装一次，确认装到的是新版本（`?op=state` 里 `plugin.version`）。

## 7. 回滚

```bash
cd <profile 目录>
pnpm add file:<绝对路径>/dsh-egress-router-<上一个版本>.tgz
```

重启宿主导回。配置改动（`cordis.patch.yml` 的 `baseURL`）不随插件版本回退，
需要「撤销」按钮或 `storages/egress-router/backups/` 里的备份手动恢复。
完整步骤见 `docs/rollback.md`。

## 8. 发布后 24 小时

- 看 GitHub Issues / 市场评论里是否有「设置页空白」「接口不可用」类报告——它们通常意味着宿主契约变了。
- 若某宿主版本出现契约问题：先降 `dshReleases` 状态为 `unknown`，再发补丁版本；不要靠猜版本号修。
- 每季度做一次「停掉上游代理再启动」演练，确认失败只影响对应路由（爆炸半径不变）。

## 附：三平台差异速查

| 事项 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| profile 目录 | `%USERPROFILE%\.dsh\profiles\desktop` | `~/.dsh/profiles/desktop` | `~/.dsh/profiles/desktop` |
| pnpm store 跨盘 | 常见（store 会自动换盘） | 少见 | 少见 |
| 文件锁 | 已关闭的句柄才能删除；用 `tmp + rename` | 同 | 同 |
| 大小写 | 不敏感（`DeepSeek Harness.exe` 被 360 盯上过） | 敏感 | 默认不敏感 |
| 换行 | CRLF 检出，插件写 LF | LF | LF |
| 安装冒烟 | `node <npm-cli.js>` | `npm` | `npm` |
