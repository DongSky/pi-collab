# pi-collab

为 [Pi coding agent](https://pi.dev) 提供多人、多 AI 协作开发工作台。通过 Pi 的 `/collab` 命令启动，在浏览器中管理账户、编辑代码、与 AI 对话、运行终端并处理 Git 变更。

派生自 [agegr/pi-web](https://github.com/agegr/pi-web)。每个 AI 任务使用独立工作区，通过版本检查、控制权交接和评审整合成果。默认无需 Docker，另有可选 Docker 运行后端。

**开发预览版：** 支持 Git 仓库和本地路径安装，尚未发布 npm 包。已完成本机验收的范围见[安装验证](docs/pi-install.zh-CN.md#验证范围)；不承诺与 Cursor 全量等价。

## 环境要求

- Node.js **22.19.0 或更高版本**、npm、Git、Python 3。
- Pi CLI：当前验证版本为 **0.87.0**。
- 浏览器；调用 AI 前需配置项目模型。

安装与启动流程已在 macOS 验证。Linux 安装验收、Windows / WSL 适配仍待完成。默认使用嵌入式 PostgreSQL，不需要预先安装数据库或 Docker。

## 安装

通过 Git 仓库安装，Pi 会获取源码并安装依赖：

```bash
pi install git:github.com/DongSky/pi-collab
```

也可以进入已取得的 **pi-collab 源码目录**，执行：

```bash
npm ci
pi install .
```

Pi 的本地路径安装只登记目录，依赖需先通过 `npm ci` 安装。默认登记到用户级 Pi 配置；需要仅在某个项目启用时，在该项目目录运行 `pi install -l /absolute/path/to/pi-collab`。

回到 Pi，执行：

```text
/reload
/collab start
/collab open
```

默认地址为 [http://127.0.0.1:30142](http://127.0.0.1:30142)。首次启动会准备数据库、执行迁移并启动 Web 与后台服务，页面首次编译需要一些时间。加载插件本身只注册命令，不启动服务，也不调用模型。

尚未发布 npm 包，不要执行 `pi install npm:pi-collab`。上游 pi-web 的安装地址不能用于安装 pi-collab。

## 首次使用

1. 打开初始化页面，使用 `~/.pi/collab/config.json` 中的 `bootstrapToken` 创建首位 Owner。令牌只能使用一次。
2. 登录后进入「账户安全」，设置验证器并保存恢复码；需要协作时，通过团队管理邀请成员。
3. 按[项目模型与网关说明](docs/local-development.zh-CN.md#9-项目模型与网关)接入模型。插件不会自动导入或修改 Pi 的模型凭据。
4. 点击「打开文件夹」，选择项目目录，确认建立带 Git 基线的协作副本。
5. 在左侧代码树打开文件，在中央标签页编辑，在右侧 Agent 栏提出需求、查看回复并审阅修改 Diff。

导入目录目前采用副本方式，编辑不会自动回写原目录。保存编辑与 Git 提交是独立操作；运行代码需要先将保存的草稿交给运行工作区。详见[代码工作区使用说明](docs/code-workspace.zh-CN.md)。

## Pi 命令

- `/collab start`：后台启动本机服务；已运行时返回当前地址。
- `/collab open`：在系统浏览器打开当前实例。
- `/collab status`：查看实例地址、任务与排空状态、日志位置。
- `/collab stop`：进入排空状态，检查未结束任务后停止服务，保留数据。
- `/collab resume`：退出排空状态，恢复接收新的修改和任务。
- `/collab help`：显示使用帮助。

**退出 Pi 或执行 `/reload` 不会停止后台服务。** 需要停机时使用 `/collab stop`。存在活动任务或状态不明的操作时，停止会被拒绝；处理后再次 `stop`，或用 `resume` 恢复工作。

`stop` 后排空状态会保留。再次使用时依次执行：

```text
/collab start
/collab resume
/collab open
```

## 配置

### 端口

可在启动时分别指定 Web、数据库和模型网关端口：

```text
/collab start --port 30200 --database-port 55440 --gateway-port 30201
```

- `--port`：Web 端口，默认 **30142**。
- `--database-port`：PostgreSQL 端口，默认 **55432**。
- `--gateway-port`：模型网关端口，默认 **30143**。

端口必须是 1024–65535 内的不同整数，配置会持久保存。省略参数时沿用已有配置。更换端口前先停止：

```text
/collab stop
/collab start --port 30200
/collab resume
```

运行期间修改端口会被拒绝；占用冲突不会自动换端口，也不会停止其他进程。同一安装目录只能运行一个开发实例，即使使用不同端口也不能同时启动两个实例。

### 数据目录

Pi 命令默认将数据保存在 `~/.pi/collab`。要更换目录，在启动 Pi 前设置环境变量：

```bash
PI_COLLAB_DATA_DIR=/absolute/path/to/collab-data pi
```

数据目录保存账户、数据库、项目、加密模型凭据及以下文件：

- `config.json`：端口、初始化令牌和本机服务密钥，应作为私有配置保存。
- `launcher.log`：启动与后台服务日志。

数据目录应位于安装目录之外，方便更新或卸载后继续使用。`/collab start` 输出实际数据与日志路径，不会把初始化令牌打印到 Pi 对话中。

### 独立命令行

也可以在源码目录直接使用启动器，支持相同的子命令及 `--data-dir`：

```bash
node bin/pi-collab.cjs start --data-dir /absolute/path/to/collab-data --port 30200
node bin/pi-collab.cjs status --data-dir /absolute/path/to/collab-data
node bin/pi-collab.cjs stop --data-dir /absolute/path/to/collab-data
```

Pi 启动入口使用本机开发模式，仅监听 `127.0.0.1`。团队远程访问、HTTPS 和可选 Docker 后端见[部署说明](docs/deployment.zh-CN.md)、[安装包流程](docs/release-packaging.zh-CN.md)及 [Docker 配置](docs/docker-runtime.zh-CN.md)。

## 功能

- **账户与权限**：首次初始化、邀请、团队 / 项目角色、多因素认证、成员管理和审计。
- **协作编辑**：左侧代码树、中央文件标签、Yjs 共编、保存状态、恢复草稿、搜索替换及目录导出。
- **版本受检保存**：检查最新版本并进行 Git 式三方合并；冲突时由用户手动解决，或让 Agent 提出候选修改，再确认应用。
- **代码工具**：JS / TS 补全、类型提示、诊断、定义与引用、符号重命名、快速修复、格式化和多文件原子修改。
- **AI 对话与协调**：右侧持续对话、当前文件 / 选区上下文、候选 Diff、独立任务工作区、依赖与范围重叠提示、控制权交接。
- **运行与 Git**：共享终端、快照与接续工作区、差异检查、暂存、本地提交，以及带确认和评审的交付流程。

原生执行适用于可信成员与项目；独立 AI 工作区用于协调修改，不等同于操作系统安全沙箱。任务整合仍受项目评审策略约束。

## 当前限制

- 工作文件夹导入为协作副本，尚未统一实现原目录直接编辑、运行和完整 Git 工作区映射。
- 语言语义能力目前以 JS / TS 为主；通用多语言 LSP、可视化调试、可编辑分栏、Test Explorer、IDE 扩展宿主及远程工作区仍待补齐。
- 文件聊天保留最近的本窗口对话，尚未实现服务端完整长期对话同步；AI 行内预测补全和任意多文件上下文附件仍待补齐。
- GitHub / GitLab 等外部服务的真实账户验收、Linux 部署和长期团队试用尚未完成。本机协议测试不代表这些环境已通过验收。

准确能力范围与已验证操作见[单人开发能力核查](docs/solo-development-audit.zh-CN.md)、[逐模块收尾记录](docs/module-closeout.zh-CN.md)和[开发计划](docs/development-plan.zh-CN.md)。

## 更新与卸载

更新前先执行 `/collab stop` 并确认停止，再备份数据。Git 安装可执行 `pi update git:github.com/DongSky/pi-collab`；本地路径安装需要自行更新源码并运行 `npm ci`。回到 Pi 执行 `/reload`、`/collab start`、`/collab resume`。

团队生产部署涉及数据库迁移时，按[运维升级流程](docs/operations.zh-CN.md)操作。

卸载前先停止服务，再从终端执行：

```bash
pi remove git:github.com/DongSky/pi-collab
```

本地路径安装改用 `pi remove /absolute/path/to/pi-collab`；项目级安装再加 `-l`。卸载不会删除独立数据目录，也不会自动停止正在运行的后台服务。

## 常见问题

**找不到 `/collab`。** 用 `pi list` 确认已登记正确的源码目录，执行 `/reload` 或重启 Pi；检查 `pi config` 中扩展是否启用。本地安装前需完成 `npm ci`。

**启动失败或等待超时。** 查看命令输出的 `launcher.log`，核对端口、依赖和现有实例。超时可能保留后台进程，先用 `status` 核查。同一安装目录已有开发实例时，需要先停止该实例或使用独立安装目录。

**重启后无法编辑或启动新任务。** 用 `/collab status` 检查是否仍在排空，确认后执行 `/collab resume`。

**页面保存了，原文件却没有变化。** 当前编辑的是协作副本。可导出工作文件夹，或通过草稿交接、终端和 Git 流程处理成果；原目录不会自动覆盖。

## 开发与验证

在源码目录启动开发环境：

```bash
npm ci
npm run dev:local
```

此入口默认使用仓库下的 `.local`，与 Pi 插件默认的 `~/.pi/collab` 分开。不要与同一目录的 `/collab start` 同时运行。

常用检查：

```bash
npm run typecheck
npm run lint
npm run test:pi-install
npm run test:release
```

对独立安装目录验证初始化、停机、端口切换和账户持久化：

```bash
npm run test:pi-install:smoke -- --package-dir /absolute/path/to/isolated-install
```

开发 checkout 内不要运行 `next build`；生产构建使用独立副本。更多协作与端到端测试见[统一功能验收](docs/foundation-acceptance.zh-CN.md)。

## 文档

- [Pi 安装、启动与验证记录](docs/pi-install.zh-CN.md)
- [公开版本脱敏说明](docs/publication-security.zh-CN.md)
- [代码工作区与快捷键](docs/code-workspace.zh-CN.md)
- [本地开发与项目模型配置](docs/local-development.zh-CN.md)
- [运行控制权交接](docs/run-control.zh-CN.md)
- [Git 交付](docs/git-delivery.zh-CN.md)
- [部署](docs/deployment.zh-CN.md) · [生产安装包](docs/release-packaging.zh-CN.md) · [运维与备份](docs/operations.zh-CN.md)
- [系统验收](docs/system-acceptance-2026-09-25.zh-CN.md) · [单人开发核查](docs/solo-development-audit.zh-CN.md) · [实施待办](docs/implementation-backlog.zh-CN.md)

## 许可证与致谢

[MIT](LICENSE)。派生自 [agegr/pi-web](https://github.com/agegr/pi-web)，上游基线为 pi-web 0.9.2（`040faddfecd98e92d31bcb3a526be06b66f790bb`），保留原作者版权声明。

由 Pi SDK、Next.js、PostgreSQL、CodeMirror 和 Yjs 等开源项目提供支持。Pi 的包安装约定见官方 [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。
