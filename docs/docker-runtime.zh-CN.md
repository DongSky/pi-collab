# 可选 Docker 执行配置

默认 `npm run dev:local` 仍是无 Docker 的原生版本。Docker 的 Web、数据库、模型网关及资源服务仍在本机；每个 AI 在独立容器中运行，共用现有账户、任务、权限、版本、租约和配额协议。

## 已接通

- 独立 Pi 容器/代码目录/HOME/profile，真实双容器并行修改；网页可以启动、查看、停止运行和交接控制权。
- 容器禁网、只读镜像、非 root 用户、无 Docker socket、删除能力、禁止提权，以及 CPU/内存/进程数限额。只挂载当前工作区，依赖和契约副本只读。
- 模型、协作/测试资源和 npm 默认 registry 经附加通信通道转发。宿主只允许固定的项目模型网关、当前运行协作端点，以及 `registry.npmjs.org` GET；拒绝任意目标与重定向。模型和协作仍使用每运行短期能力，长期 Provider/数据库密钥不进入容器。容器没有一般宿主或互联网网络访问。
- 执行前运行固定的环境配方；`npm ci` 禁用生命周期脚本，支持本地依赖和默认 npm registry。其他自定义下载域名不开放。镜像 ID、实际容器 Node/npm/Pi、平台/架构等记录为交接证据；恢复检查镜像与工具链匹配。
- 停止以 Docker 中的容器 ID、daemon 标识和持久凭据核对，不能把 `docker start` 客户端退出当成容器退出。未知运行继续隔离；异常核查读取同一容器状态，不盲目重新运行。
- 停止后捕获代码快照，再由新负责人在新容器重建原配方，支持已有的私有讨论和建议接续协议。

迁移 055 补齐共享人工终端和固定命令验证：同一真实容器 Bash PTY 支持多人旁观、控制交接与快照；验证从固定快照恢复新目录，在新的受限容器执行 Node/npm 配置，记录实际镜像、运行时、输出 hash，确认容器退出后才记录通过。超时或源码变化会失败，无法确认退出则保留 unknown，不自动重放。npm 默认 registry 经既有只读通道访问，其他网络继续拒绝。来源按 native/docker 分配验证执行器，不能用本机检查冒充容器检查。

迁移 056 接通容器 Git：确认来源容器退出后，由受限 Git 服务执行固定版本差异、暂存、提交、历史预览、推送与 PR/MR 交付。多个成果整合只要包含容器来源，就分配容器验证；冲突修复也保留这一边界，旧原生执行器不会领取容器整合。原有本地推进仍需通过固定版本评审与检查。测试覆盖容器修复到独立评审、GitLab 实际 Git 合并、GitHub 双成员网页推送/PR/CI/合并以及工作区暂存/提交；远端使用本机协议服务。专门故障矩阵及外部账号验收继续保留。

## 启动

```bash
npm run runner:docker:build
PI_COLLAB_DATA_DIR=/path/to/persistent-docker-shared-data npm run dev:docker
```

`dev:docker` 默认使用 `~/.pi-collab-docker`，与原生 `.local` 分开；显式提供 `PI_COLLAB_DATA_DIR` 可选择其他位置。它先启动受限容器，在空探测目录验证实际读写字节和镜像可用性，再启动业务服务，不挂载控制层密钥作探测。数据目录必须是 Docker daemon 能访问的**持久目录**；Docker Desktop 的目录共享/系统访问权限由部署者配置，启动器不会修改权限。不要将临时目录当作长期团队存储。

两个配置的默认端口相同，先停止原生实例再启动 Docker 配置，或事先为另一配置设置不同的 `config.json` 端口。不要为同一 Next checkout 同时运行两个开发服务。使用 `ops:*` 管理 Docker 配置时，同样提供它的 `PI_COLLAB_DATA_DIR`；备份仍要求全部容器已确认停止。

镜像构建只在显式执行构建命令时联网，运行阶段 `--pull=never` 且固定当前镜像 ID。当前镜像没有默认跟随 latest 更新。仅有 Docker daemon 不代表基础镜像和挂载已准备好。

## 本机验证

```bash
npm run test:collab:docker
PI_COLLAB_RUNTIME=docker PI_COLLAB_E2E_FOCUS=environment-handoff npm run test:collab:identity:e2e
```

已执行：真实双容器/写入隔离/禁网/凭据拒绝/退出凭据；两名用户通过真实 Pi、模型网关与本机流式协议服务调用工具；同一容器控制交接；npm 本地依赖重建与快照恢复；双成员网页启动和环境交接。协议模型服务不产生外部推理消费。关联原生回归通过。

本机 Docker Desktop 在 Documents 和用户主目录的绑定创建会超时；测试使用已验证可挂载的独立临时目录，测试结束清理。网页测试将临时代码目录与容器数据目录分开，避免让挂载限制误导为业务失败。持久目录的 Docker Desktop 共享配置尚未由本任务更改，当前本机日常服务继续使用原生模式。真实云 Provider 的 Docker 验收、外网部署仍未宣称通过。新增 3 项真实容器专项覆盖固定验证到静态预览、隔离与清理、源码变更/超时；共享终端和固定检查点预览两个双成员容器网页流程通过，未使用外部推理。镜像增加共享 PTY 入口和受审记忆工具，需重新执行显式镜像构建命令。

2026-09-24 补充持久目录探测：本机 `/Users/Shared/pi-collab-data` 的无密钥读写探测超时，`/opt/homebrew/var/pi-collab-data` 被 Docker 拒绝挂载。探测容器及文件已清理，未修改 Docker Desktop 设置；不能把临时挂载验收当作持久部署通过。

可单独执行 `npm run ops:docker-check` 做相同检查。公网/生产配置与无 Docker 版本共用 [团队部署入口](deployment.zh-CN.md)，Docker 仅替换执行后端。
