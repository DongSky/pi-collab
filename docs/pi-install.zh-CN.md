# 通过 Pi 安装和启动 pi-collab

适用：Pi 0.87.0、本机 Node.js ≥ 22.19、npm、Git、Python 3。默认无 Docker。该入口启动本机开发模式；团队生产部署继续使用 [生产安装包](release-packaging.zh-CN.md)。

## 本地安装

在 pi-collab 源码目录执行 `npm ci`，然后 `pi install /absolute/path/to/pi-collab`。Pi 本地安装仅登记路径，依赖需要先安装。回到正在运行的 Pi，执行 `/reload`；新开的 Pi 会自动加载。加载只注册 `/collab`，不启动服务，不调用模型，也不自动导入 Pi 凭据。

也可运行 `pi install git:github.com/DongSky/pi-collab`，Pi 自动获取源码并安装依赖。不要使用上游 agegr/pi-web 地址期待得到 pi-collab。本项目尚未发布 npm 包，没有可用的公开 `pi install npm:pi-collab` 安装承诺。

## Pi 命令

```text
/collab start --port 30200 --database-port 55440 --gateway-port 30201
/collab status
/collab open
/collab stop
/collab resume
```

- `start`：后台启动数据库、迁移、Web、执行器、模型网关、资源和 Git 服务，等待初始化 API 就绪。默认 Web 30142、数据库 55432、网关 30143；端口必须为 1024–65535 的不同整数。退出 Pi 或 `/reload` 后服务仍保留，不影响其他成员。
- `status`：检查当前安装的进程身份并报告任务 / 排空状态。未启动时不创建账户配置。
- `open`：在系统浏览器打开当前地址。首次通过页面初始化 Owner；令牌位于数据目录 `config.json` 的 `bootstrapToken`，不会打印到 Pi 对话。
- `stop`：先排空，拒绝新工作，再检查活动任务。存在未结束或状态不明任务时拒绝停止；处理后再次执行。停止不删除数据，也不强杀占用端口的其他进程。
- `resume`：取消排空。`stop` 后排空标志会保留，重新 `start` 后执行此命令恢复写入；停止被拒绝时也可用它恢复工作。

更换端口：先 `stop`，再 `start --port 新端口`。配置持久化，后续省略参数沿用上次值。运行期间修改端口会拒绝；Web、数据库、网关不能互相重用端口。已有服务占用时查看日志并换端口，不自动寻找其他端口。

## 独立命令行、数据和日志

源码安装可运行：

```bash
node /absolute/path/to/pi-collab/bin/pi-collab.cjs start \
  --data-dir /absolute/private-data \
  --port 30200 --database-port 55440 --gateway-port 30201
node /absolute/path/to/pi-collab/bin/pi-collab.cjs status --data-dir /absolute/private-data
```

npm 安装包注册同等的 `pi-collab` 可执行入口。命令行支持 `--data-dir`；Pi 命令使用启动 Pi 时的 `PI_COLLAB_DATA_DIR` 环境变量，未指定则为 `~/.pi/collab`。将数据放在安装目录外，尤其不要放进 Pi 托管的 Git 克隆目录；更新可能重置该目录。

数据目录包含账户、数据库、项目、模型加密凭据、`config.json` 及 `launcher.log`。启动失败只显示日志位置，不把可能敏感的完整服务日志发送到 Pi。第一次编译需要时间；超时后后台进程保留，可查看日志和 `status`。启动仅绑定回环地址。

同一源码目录只能运行一个开发实例，即使使用不同端口也共享 Next 开发锁；需要多个实例时使用不同安装目录。当前源码已有 `npm run dev:local` 实例时，先按既有流程停止，或另用独立安装目录。

npm 安装时，Next 不能直接编译 `node_modules` 下的应用源码；启动器在 npm 安装根下的 `.pi-collab-runtime/` 自动准备运行副本，引用已安装依赖。这个目录只存程序和开发缓存，可重新生成，不能用于保存项目数据。启动准备受安装级锁保护，不会重写正在运行的副本。

## 更新与卸载

先 `stop` 并确认成功，再更新源码或执行 Pi 的包更新命令，随后 `/reload`、`start`、`resume`。后台旧实例不会随 `/reload` 自动重启。跨版本数据库更新仍应先备份；团队部署使用既有运维升级流程。

卸载前先停止服务，再 `pi remove /absolute/path/to/pi-collab`。Pi 卸载或更新不会主动删除安装目录外的数据。若未先停止，后台服务仍运行，应从原安装目录执行停止命令。

## 验证范围

`npm run test:pi-install` 验证真实 Pi 路径安装 / 卸载、扩展加载、端口参数转发与校验、npm 文件清单。安装包依赖按 npm 省略开发依赖的情况验证；运行源码所需的 tsx、PostgreSQL、样式编译与页面依赖已列入 dependencies。

独立安装目录可运行完整冒烟：

```bash
npm run test:pi-install:smoke -- --package-dir /absolute/isolated/install
```

该验证创建独立 Pi 配置、数据目录与端口，实际初始化 Owner、停止所有服务、更换端口重启并检查账户保留，最后再次停机并卸载 Pi 登记；不会调用模型或修改现有账户。失败保留日志，不强杀进程。

2026-09-26 本机 macOS 验证：10 项安装 / 发布 / 部署测试、类型检查、lint 通过。已用省略开发依赖的独立 npm 安装包完成原生服务启动、初始化页面 HTTP 200、Owner 初始化、运行中改端口拒绝、停止后换端口、账户保留及完整停机，并通过实际 Pi 资源加载器调用 `/collab` 命令。修复了 npm 依赖提升、Turbopack 对 node_modules 源码的限制，以及嵌入式数据库退出钩子抢先停机的问题。浏览器 Computer Use 因工具鉴权不可用未执行，本次页面验证为 HTTP 检查；未发布 npm 或远端版本，也未进行 Linux 验收。

Pi 扩展只导入宿主 SDK 类型；独立协作服务保留固定版本 SDK 运行依赖，与加载插件的 Pi 进程分离。没有模型调用或远端发布是安装验证的前置条件。
