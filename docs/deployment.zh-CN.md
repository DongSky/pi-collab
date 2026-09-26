# 团队部署入口

本机开发默认仍为 `npm run dev:local`：原生 Pi、回环服务、本机邮件箱。团队部署使用同一套账户、任务、Git、运维和执行器，生产入口 `start:team` 不运行开发服务器，不自动迁移数据库。Docker 是可选执行后端，并不要求用 Docker 部署 Web 或数据库。

## 准备独立发布目录

使用 [安装包与版本切换](release-packaging.zh-CN.md) 中的打包、校验及独立目录安装流程。生产启动检查逐文件清单、平台和必要 Next 产物，拒绝缺失或被修改的安装包；**不要在正在运行的开发 checkout 中执行构建**。本机开发 checkout 不运行构建。生产产物已在独立临时 checkout 构建和安装，验收状态见文末；手动发布工作流尚未触发。

复制 [环境模板](../deploy/team.env.example) 到代码目录外的私有配置文件，权限设为 `600`。数据目录用独立绝对持久路径，保留已有 `config.json`、数据库与密钥，不要把开发 `.local` 直接作为生产数据。原生执行需要 Node、Git、Python 3；版本以当前 package.json 和环境配方为准。

配置项：

- `PI_COLLAB_DEPLOYMENT=production`：生产启动及 SMTP；省略时保持本机邮件箱，不继承外部 SMTP 凭据。
- `PI_COLLAB_RUNTIME=native`：默认无 Docker；可选 `docker`。
- `PI_COLLAB_EXECUTOR_CAPACITY`：本节点同时执行的运行数，默认 8，范围 1–32。监督进程将它传给执行器；项目／成员配额仍分别生效。
- `PI_COLLAB_DATA_DIR`：持久目录绝对路径，包含数据库、凭据和工作区。
- `PI_COLLAB_PUBLIC_ORIGIN`：控制台 HTTPS origin，无路径、用户名或查询参数。
- `PI_COLLAB_PREVIEW_ORIGIN`：独立主机名的 HTTPS origin。预览保留响应 CSP 沙箱、成员检查与短期能力。
- 密钥默认独立存放在持久目录的 `model-master.key`、`resource-master.key`、`git-master.key`。网关／资源／Git 服务分别只收到自己的路径，Web 和执行器没有这些变量。可用 `PI_COLLAB_MODEL_MASTER_KEY_FILE`、`PI_COLLAB_RESOURCE_KEY_FILE`、`PI_COLLAB_GIT_KEY_FILE` 指定外部文件；外部密钥需另行管理备份，内置冷备份会拒绝假装覆盖这些外部文件。
- `SMTP_URL`、`SMTP_FROM`：实际邮件服务和发件身份；密码需 URL 编码。不接受 URL 查询选项，`smtp://` 在生产中强制 STARTTLS，`smtps://` 从握手起加密，两者均验证证书。

## 初始化、检查及启动

下列命令在独立发布目录执行。Node 的 `--env-file` 读取私有配置，不要把凭据写进命令行参数或版本库。

```bash
node --env-file=/srv/pi-collab/team.env --import tsx scripts/operations.ts upgrade
node --env-file=/srv/pi-collab/team.env --import tsx scripts/check-deployment.ts
node --env-file=/srv/pi-collab/team.env --import tsx scripts/dev-local.ts
```

首次 `ops:upgrade` 在尚无加密资源凭据时以私有权限创建资源密钥；已有凭据但密钥丢失会拒绝，不会生成无法解密历史数据的新密钥。模型与 Git 密钥仍由显式接入流程创建。

已有实例先按运维文档排空并停止，再升级。生产启动只核验已应用迁移及哈希，不自动改变数据库；缺失迁移会要求执行 `ops:upgrade`。默认端口读取持久 `config.json`，数据库和全部应用服务都绑定回环地址。

SMTP 连通检查需显式增加 `--smtp`：仅连接、TLS 和认证验证，不发送邮件。检查结果将配置、发布产物、SMTP 连接、实际投递、公网入口分开报告，成功连接不等于邮件到达。

生产 Docker 入口换为 `scripts/dev-docker.ts`；也可以在已载入环境的 shell 中使用 `npm run start:team:docker`。先显式构建 runner 镜像，再运行 `npm run ops:docker-check`。检查真正启动受限容器，读写空探测目录并核对字节；只通过 `docker create` 不算挂载可用。检查不修改 Docker Desktop 的目录共享设置。

## HTTPS 与服务管理

[反向代理模板](../deploy/Caddyfile.example) 将两个域名分别转到控制台和 `/preview/*`、`/service/*`。替换域名和端口并配置 DNS，由 Caddy 管理 HTTPS。预览域名的其余路径返回 404，禁止将模型网关 `/v1`、协作和资源接口整体暴露到公网；移除预览请求 Cookie/Authorization 和响应 Set-Cookie。SSE 即时转发，模板不记录包含短期能力的访问 URL。证书、DNS 和公共入口的最终验收必须在实际部署环境执行。

[systemd 模板](../deploy/pi-collab.service.example) 使用专用系统用户、私有权限和监督进程。调整 Node 路径、发布目录及私有配置路径；Docker 模式还需把入口改成 `scripts/dev-docker.ts`。正常升级优先使用运维排空/停止流程。进程异常不盲目自动重启作业，先检查 `ops:status` 及隔离的未知运行，再恢复开放。

## 本轮验证与未完成项

已验证：独立 macOS arm64 / Node 26 生产构建、完整锁文件安装、真实 `next start`、原生与 Docker 常驻执行器终端工作、快照与完整停止重启恢复、持久排空与数据保留、安装包完整性和无 Git 备份版本；生产配置／服务密钥及邮件凭据隔离、实际本机 TLS SMTP 收件和真实备份恢复回归通过。类型检查／lint 通过。没有外部模型推理，也没有向真实地址发邮件。

尚未验证：GitHub 托管 Linux 构建、实际公网 DNS/HTTPS、真实 SMTP 投递，以及具体部署主机的数据路径／服务管理器配置。Docker 已在本机可挂载的独立临时数据目录完成完整重启及快照恢复；默认用户目录的历史挂载问题仍见 [Docker 说明](docker-runtime.zh-CN.md)，没有修改 Docker Desktop 共享设置。20 成员/8 AI 容量、灾难恢复指标和团队试点属于最终交付验收，继续保留。
