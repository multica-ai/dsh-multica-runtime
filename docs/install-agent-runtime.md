# 在 Linux/macOS 上安装 Multica DSH runtime

本指南用于单机安装：在本机的 DSH `multica` profile 中加入 runtime，然后让
Multica daemon 使用这个 profile。默认 DSH 数据目录为 `DSH_HOME=~/.dsh`，不覆盖
多机部署或多个 profile 的配置。

## 1. 准备 Node.js、npm 和 pnpm

runtime 与 DSH 使用 Node.js `^22.19.0 || >=24.0.0`。先确认版本：

```sh
node --version
npm --version
```

若版本不满足要求，请使用 nvm、Homebrew 或发行版包管理器安装 Node.js 22.19+
或 24+。安装完成后启用 pnpm（Corepack 随 Node.js 提供）：

```sh
corepack enable pnpm
pnpm --version
```

在 Linux 上通常由 bash 运行命令；macOS 默认由 zsh 运行命令。以下命令均为
POSIX shell 语法，可在 bash 和 zsh 中执行。

## 2. 安装 DSH

使用 npm 的 `latest` 通道安装 DSH CLI：

```sh
npm install --global @deepseek-ai/dsh@latest
dsh --version
```

全局 npm 命令必须位于 `PATH` 中。检查 npm 的全局 prefix：

```sh
npm config get prefix
```

Linux 和 macOS 的全局 bin 目录通常是 `<prefix>/bin`。如果 `command -v dsh`
没有输出路径，把以下目录加入当前 shell 的启动文件（Linux bash 通常是
`~/.bashrc`，macOS zsh 通常是 `~/.zshrc`）：

```sh
export PATH="$(npm config get prefix)/bin:$PATH"
```

执行 `source ~/.bashrc`（Linux bash）或 `source ~/.zshrc`（macOS zsh），再验证：

```sh
command -v dsh
dsh --version
```

推荐使用 nvm 或用户级 Node.js 安装，这样全局 npm 目录由当前用户拥有，不需要
`sudo`。如果 Linux/macOS 使用系统 Node.js 且全局目录不可写，`npm install`
可能报 `EACCES`：可以改用用户级 Node.js，或仅在确认目标目录属于 npm 全局
prefix 后执行 `sudo npm install --global @deepseek-ai/dsh@latest`。不要为了绕过
权限问题给整个 home 目录或 npm 目录执行宽泛的 `chmod`。

## 3. 设置 DSH_HOME 和 API key

DSH 默认使用 `~/.dsh`。如需显式固定单机目录，可在 shell 启动文件中加入：

```sh
export DSH_HOME="$HOME/.dsh"
mkdir -p "$DSH_HOME"
```

runtime 通过 DSH 的凭据提供器读取 `DEEPSEEK_API_KEY`。在当前 shell 临时设置：

```sh
export DEEPSEEK_API_KEY="<your-deepseek-api-key>"
```

需要每次登录都可用时，将同一行加入 `~/.bashrc`（Linux bash）或 `~/.zshrc`
（macOS zsh），然后重新加载文件。API key 不要提交到 Git、写入 profile 的
`package.json`，也不要粘贴到 issue 或日志中。

## 4. 构建并安装 runtime profile 插件

在工作目录获取本仓库后，安装依赖并执行检查和构建：

```sh
cd /path/to/dsh-multica-runtime
pnpm install
pnpm check
pnpm build
```

构建成功后，用仓库的绝对路径把 runtime 加入单机 `multica` profile。`dsh
plugin` 会在首次使用时创建 `$DSH_HOME/profiles/multica`：

```sh
RUNTIME_DIR="$(pwd)"
dsh plugin --profile multica add "$RUNTIME_DIR"
```

也可以直接写绝对路径，例如：

```sh
dsh plugin --profile multica add /path/to/dsh-multica-runtime
```

安装后，profile 的插件清单应包含 `@multica-ai/dsh-runtime`。不要手工编辑
`$DSH_HOME/profiles/multica/package.json` 来替代 `dsh plugin`。

如果 `dsh` 不在标准位置，可为 Multica daemon 指定启动器：

```sh
export MULTICA_DSH_PATH="$(command -v dsh)"
```

## 5. 探针和模型列表验证

先确认 runtime 能被 DSH profile 加载。两个命令都应以退出码 0 完成：

```sh
dsh --profile multica --probe
dsh --profile multica --list-models
```

`--probe` 输出单行 JSON，必须包含 `type: "probe"` 和
`protocol_version: 1`。`--list-models` 应输出当前 DSH/网关可用的模型与思考级别。
如果命令找不到 `dsh`，先修复本节第 2 步的 `PATH`；如果模型请求提示凭据缺失，
检查当前 shell 的 `DEEPSEEK_API_KEY`，不要把 key 写进命令历史以外的仓库文件。

## 6. 重启并确认 Multica daemon 上线

安装或更新 profile 后重启本机 daemon：

```sh
multica daemon restart
```

确认 daemon 仍在运行，并检查 JSON 中的状态字段：

```sh
multica daemon status --output json
```

确认输出中的 `status` 为 `running`，且没有启动错误；随后在 Multica 中创建或
运行一个测试任务，确认该 runtime 出现在可用 runtime 列表并能完成一次最小
任务。若未上线，先查看 daemon 日志：

```sh
multica daemon logs --lines 100
```

常见原因是 daemon 进程没有继承你刚修改的 `PATH`、`DSH_HOME` 或
`MULTICA_DSH_PATH`。从 shell 启动 daemon，或把这些变量写入 daemon 使用的
启动环境后，再运行 `multica daemon restart`。确认后即可继续使用单机
`multica` profile；本指南不涉及多机或多 profile 路由。

## 7. 转发 agent 凭据到 shell

DSH 会把环境变量名中包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的变量从
agent 生成的子进程里剥掉，因此配置在 agent 上的第三方 skill 凭据（如
`WEKNORA_API_KEY`）默认无法到达 shell。需要时，在 Multica 中给对应 agent
增加一个环境变量，值为逗号分隔的变量名列表：

```sh
FORWARD_ENV_NAMES=WEKNORA_API_KEY
```

控制变量名不能以 `MULTICA_` 或 `DSH_` 开头：前者会被 Multica daemon 拦截丢弃，
后者属于 DSH 保留命名空间。

只列出确实需要穿过的"凭证形状"变量名：

- 不含敏感词的变量（如 `WEKNORA_BASE_URL`、`PATH`）本就能通过，无需列出；
- 模型提供商凭据（`DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等）绝不能列入，
  否则会泄漏进 agent 的 shell。
