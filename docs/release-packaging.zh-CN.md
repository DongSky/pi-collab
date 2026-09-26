# 安装包与版本切换

默认仍为无 Docker 原生执行。团队安装包包括生产 Web 产物、执行器/网关/运维源码、迁移、锁文件、静态资源、部署模板及逐文件 SHA-256 清单；不包含个人配置、数据库、密钥、node_modules、Git 历史或开发缓存。Docker 后端复用同一安装包，runner 镜像另外准备。

## 生成安装包

仓库新增手动 `Team release artifact` 工作流。它仅在独立 CI checkout 中安装锁定依赖、检查代码、构建生产产物，生成并安装包，在新的临时数据库中启动真实 `next start` 及原生执行服务，检查匿名访问、真实常驻执行器终端工作、快照保存、完整停止／重启及快照恢复、排空和无 Git 目录的备份版本信息，并对原生与 Docker 两个后端执行，成功后上传工作流 artifact。不会创建 GitHub Release、发布 npm 包、连接生产数据库或发邮件。尚未触发 GitHub 工作流；本机已在独立临时 checkout 完成真实生产构建、安装及两个后端的生产启动验收。开发 checkout 的 `.next` 未用于构建。

工作流固定 Linux x64 / Node 22；本机实际验收为 macOS arm64 / Node 26，不能代替尚未运行的 Linux CI。安装目标必须匹配构建的 OS、架构和 Node 主版本。源码 `package-lock.json` 固定依赖，安装使用 `npm ci --include=dev`，因为运行入口还使用 tsx/embedded-postgres 等依赖。当前不是完全离线、自带 Node 的二进制安装包；部署主机仍需 Node、npm、Git、Python 3 和依赖下载能力。

已有独立生产构建目录时，可以只打包，**命令本身不会构建**：

```bash
node scripts/release.mjs pack --output /absolute/new-package-directory
```

要求在 Git checkout 根目录操作、打包范围内的源码与 HEAD 一致、生产输出完整，输出必须是源码目录外尚不存在的目录。只选择版本控制中的源码和生产 `.next`，不递归复制整个开发目录。生产构建应和打包在同一受控作业完成；该命令不会证明现有 `.next` 与 HEAD 的来源关系，也不提供数字签名。

## 安装到独立目录

仅接受自己受信任构建得到的包。先与可信工作流下载信息核对 archive SHA-256，再解压到新的暂存目录。逐文件清单用于发现损坏或意外修改，不能证明不可信发布者的身份。

```bash
sha256sum -c pi-collab-linux-x64.tar.gz.sha256
mkdir unpacked-release
tar -xzf pi-collab-linux-x64.tar.gz -C unpacked-release
node unpacked-release/scripts/release.mjs verify --source unpacked-release
mkdir -p /srv/pi-collab/releases
node unpacked-release/scripts/release.mjs install \
  --source unpacked-release --output /srv/pi-collab/releases/REVISION
```

安装器仅创建新目录，按清单复制文件、安装锁定依赖、再次校验。目标已存在时拒绝覆盖；失败删除本次新建的不完整目录。安装不改运行实例，不迁移数据库，不修改 systemd，也不启动服务。项目数据与私有环境文件放在发布目录外；不要在安装包中放 `.env` 或修改源码。生产启动和 `deploy:check` 会验证清单、平台、必要产物与额外文件。

## 接入现有运维流程

1. 从旧版本运行目录，载入旧实例的私有配置，执行 `ops:drain`、核查 `ops:status`、`ops:stop`。等待原服务和 PostgreSQL 退出，保存加密冷备份。未知运行不能强行当作已停止。
2. 安装新版本到不同目录；保持既有持久数据路径与密钥不变。从新版本目录、使用同一私有配置执行 `ops:upgrade`、`deploy:check`。
3. 将服务管理器的工作目录切到新版本，再按 [部署文档](deployment.zh-CN.md) 启动，检查登录与服务状态后显式 `ops:resume`。
4. 旧版本和备份继续保留。数据库迁移不做自动 down migration；恢复必须按 [运维文档](operations.zh-CN.md) 核对代码/迁移与备份，不能只切回旧代码假装已回滚。

没有 `.git` 的安装目录也能备份：校验后的 release commit 写入备份清单。开发 checkout 继续使用原来的 Git 版本/脏状态记录。

## 最新产品包（aff0035）

撤回来源筛选修复后再次构建、打包并安装至 `/tmp/pi-collab-installed-aff0035`，原生／Docker 的完整生产启动、停机重启、快照恢复两套冒烟均通过。日志 `/tmp/pi-collab-release-native-aff0035.log`、`/tmp/pi-collab-release-docker-aff0035.log`。之后的 `4f0d34f` 仅修改测试断言，没有改变运行代码。

## 长路径修复验收（1c8dd73）

2026-09-24 重新在独立 checkout 构建并打包，安装到 `/tmp/pi-collab-installed-1c8dd73`，原生与 Docker 两套实际生产冒烟均通过。每套均启动完整服务、执行终端写入、保存快照、全部停机重启并恢复继续写入；来源包括迁移 001–073。

本轮修复较长数据目录导致 PostgreSQL Unix socket 路径超限的启动失败：应用原本全部使用认证 loopback TCP，现禁用未使用的 Unix socket。真实长路径数据库启动／重启持久性测试通过，原生安装冒烟也在该超长路径执行通过。Docker `/tmp` 挂载探测失败，系统默认临时路径通过；具体部署目录仍应先执行现有读写探测。

日志：`/tmp/pi-collab-release-build-1c8dd73.log`、`/tmp/pi-collab-release-install-1c8dd73.log`、`/tmp/pi-collab-release-native-1c8dd73.log`、`/tmp/pi-collab-release-docker-1c8dd73-default.log`。构建平台仍为 macOS arm64 / Node 26，不替代 Linux 和公网部署。

## 前次验证状态（32f0974）

代码版本 `32f0974` 已从独立生产 checkout 的真实 Next 产物打包，经完整锁文件 `npm ci` 安装到无 Git 的新目录，并通过原生、Docker 两套 `release-smoke.ts`。每套使用全新 PostgreSQL 和数据目录，启动真实 `next start`、执行器、网关及资源／Git 服务，完成终端写入 → 持久快照 → 全部进程与数据库停止 → 同目录重启 → 保留排空标记 → 恢复快照到新运行并继续写入。发布校验、匿名访问拒绝、Gitless 备份版本、退出与原文件保持均通过。Docker 使用本机可挂载的临时持久目录并真正执行容器，未改变 Docker Desktop 共享设置。

本轮发现并修复生产服务遗漏密钥路径、资源／Git 环境未切换生产的问题。资源密钥只由显式停机升级在没有历史凭据时初始化；不会在丢失密钥后重置加密数据。

另有 2 项打包协议及 5 项部署／真实备份恢复回归通过，类型检查／lint 通过。协议单测中的合成 `.next` 仍只验证打包，不替代上述实际安装验收。日志为 `/tmp/pi-collab-production-{build,install,smoke-native,smoke-docker,tests,packaging-tests,types,lint}.log`。

仍未验收：GitHub 托管 CI 的 Linux 包、实际公网 HTTPS/SMTP、特定部署主机的持久路径／服务管理器、20 成员／8 AI 容量和真实团队试点。上述范围继续保留，没有对外发布或发送邮件。

## 当前功能版本（13e0a8b，2026-09-25）

已在独立 worktree `/tmp/pi-collab-production-system` 安装锁定依赖并构建，安装到 `/tmp/pi-collab-installed-13e0a8b`。原生与 Docker 两套完整停机重启／终端写入／快照恢复再次通过；包含最新容器镜像解析及预览权限失效修复。日志为 `/tmp/pi-collab-system-{build,install,release-native,release-docker}.log`。后续 `4ccd9d6` 只修改基准隔离和文档，未改运行代码。此前标题中的“最新产品包”属于历史时点。

## 2026-09-25 工作台最终安装包

产品提交 `93123ee` 包含新工作台、跨任务草稿恢复及隐藏组件请求收尾修复。独立 worktree `/tmp/pi-collab-production-system` 完成真实生产构建、manifest 打包和完整安装，安装目录 `/tmp/pi-collab-installed-93123ee`。该包的原生与 Docker 两套完整冒烟均通过：真实常驻终端、快照、完整监督进程／数据库停机重启、恢复后的继续写入、排空标记持久性、匿名访问保护和无 Git 目录备份身份验证。

日志 `/tmp/pi-collab-workbench-93123ee-{build,pack,install,native,docker}.log`。没有在开发 checkout 构建，也没有用合成 `.next` 替代实际产品包。构建平台 macOS arm64／Node 26，Linux 与公网环境仍未验收。
