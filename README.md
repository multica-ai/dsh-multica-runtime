# Multica DSH Runtime

Private, out-of-tree runtime bridge between Multica and the public
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It exposes
a versioned JSONL protocol over stdio and composes over
`@deepseek-ai/dsh-base`. It does not require changes to DeepSeek Harness.

![DeepSeek Harness runtime online in Multica](docs/images/multica-dsh-runtime.png)

## Privacy

- This repository contains only the Multica integration layer. It does not
  vendor or redistribute DeepSeek Harness source code.
- Never commit API keys, MCP secrets, session logs, or generated profiles.
- DSH telemetry is disabled by the bundle patch.
- stdout is protocol-only; diagnostics go to stderr.

## Local development

桥接使用公开的 DSH npm 包，当前适配 `@deepseek-ai/dsh@0.2.1-rc.4`。
开发与运行依赖须使用对应版本的 `@deepseek-ai/dsh-*` 包；安装时启用严格 peer
依赖检查，并重新生成锁文件，避免保留旧版本的间接依赖。`engines.dsh` 声明
支持范围为 `^0.2.1-rc.4`；DSH 会拒绝在范围外加载 bundle。
DSH 0.1.x 需要先前的 `0.1.0-private.1` 构建。

```bash
pnpm install
pnpm check
pnpm build
```

Install the local bundle into a DSH profile after building it:

```bash
dsh plugin --profile multica add /absolute/path/to/multica-dsh-runtime
```

The plugin supports:

```bash
dsh --profile multica --probe
dsh --profile multica --list-models
dsh --profile multica --stdio
```

Multica discovers the profile only after `--probe` returns protocol version 1.
For a non-standard DSH installation, point the daemon at its launcher:

```bash
export MULTICA_DSH_PATH=/absolute/path/to/dsh
```

The runtime contract includes:

- model and thinking-level discovery from DSH itself;
- committed text, reasoning, tool, result, and token-usage events;
- cooperative cancellation and durable session resume;
- canonical Multica MCP configuration translated to DSH stdio or
  streamable-HTTP clients;
- per-runtime/agent session roots supplied by the Multica daemon;
- headless one-shot approvals, with no interactive question surface.
- narrowly forwards only Multica's server-minted `mat_` task token into DSH's
  otherwise credential-scrubbed shell, so in-task `multica` commands retain
  task attribution without exposing model-provider credentials.

任务注入的 MCP 服务连接失败时，客户端保留告警并按既有策略重连，Agent
仍可继续执行；失败服务的工具在连接恢复前不可用。需要该服务的任务仍须先解决
对应的连接或鉴权问题。

The local `.local/` tree is ignored. It may hold an isolated DSH home and a
development launcher, but neither belongs in source control.

`DEEPSEEK_API_KEY` is read by DSH's credential provider at process runtime. It
must not be stored in this repository.
