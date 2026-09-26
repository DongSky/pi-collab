# pi-collab 统一功能验收

功能范围以 [功能骨架交付清单](foundation-delivery.zh-CN.md) 为准，运行结果以 [实施状态](implementation-status.zh-CN.md) 为准。本入口将已经实现的功能纳入可重复验收；新增入口不等于所有场景已经在当前提交执行过。

## 本机协议与运行后端

```bash
npm run typecheck
npm run lint
npm test
npm run test:collab
npm run test:release
```

协作测试使用独立临时数据库及真实 Git/Pi 进程。本机已有健康 PostgreSQL 时会复用服务、隔离数据库，因此测试期间不要停止持有 PostgreSQL 的主启动器。`npm test` 验证上游兼容；`test:release` 验证打包协议，不替代当前提交的生产构建、安装与重启验收。不要在正在开发的源码目录运行 `next build`。

Docker 可选，显式选择后运行：

```bash
npm run runner:docker:build
npm run test:collab:docker
```

该命令包含 Docker 生命周期与完整网关测试，包括双 Pi、控制交接、等待人工回答、模型预算及成员并发；不能只运行某个名称匹配的测试后声称整套通过。测试使用本机模型协议服务，不消耗外部模型额度。

## 双成员浏览器功能

```bash
node e2e/collab-suites.mjs --list
PI_COLLAB_E2E_FOCUS=run-control npm run test:collab:identity:e2e
```

唯一场景目录为 `e2e/collab-suites.mjs`，目前包含 21 项：账户与基础执行、项目全景、运行控制、讨论、整合行内讨论、工作区 Git、推送历史、PR 交付、GitLab、证据包、子 AI、资源与调度、管理、环境交接、历史、共享终端、共编、OIDC、接口兼容、项目记忆、预览。

不指定时运行 `core`；拼错名称直接失败，在创建配置、启动数据库或浏览器之前退出，不会悄悄转跑默认场景。每个场景有自己的临时源码、数据库和账户；本机顺序运行，以免不同进程同时覆盖截图目录及私有服务日志。

## 手动 CI 与开发流程

`.github/workflows/collab-foundation.yml` 提供 **Collaboration foundation acceptance** 手动工作流：`suite=all` 展开全部 21 项，也可填目录中的一个名称；`docker=true` 额外构建和测试容器后端。浏览器任务彼此隔离，最多两个并行，一个失败不取消其他场景。只上传 PNG 截图，不上传可能含重置链接的服务日志。

日常修改先运行受影响的协议/浏览器场景，再执行类型与 lint 检查；跨模块集成或候选发布执行完整协议和全部浏览器矩阵。失败须区分产品问题、测试夹具失配和外部环境缺失，修复后保留同条件复验记录。已应用迁移只能追加修复，不能改写历史。

该工作流尚未在托管 Linux 上执行。真实 GitHub/GitLab/IdP、公网 HTTPS/SMTP、参考硬件长时间负载和真实团队试用仍为独立最终验收；本机模拟协议通过不替代这些结果。
