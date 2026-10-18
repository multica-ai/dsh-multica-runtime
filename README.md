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

The DSH packages used by this plugin are public npm packages. This plugin
targets DSH `0.2.1-rc.2` and the rest of the `0.2.x` line
(`engines.dsh`: `>=0.2.1-rc.2 <0.3.0`). It is not compatible with the
`0.1.x` family: DSH 0.2.1 changed the tool-result message and renamed several
bundle patch keys this bridge depends on.

```bash
pnpm install
pnpm check
```

The test suite includes isolated, offline launcher checks for profile loading,
model discovery, and the stdio handshake. It never reads the user's DSH home
or contacts a model endpoint. `pnpm test` builds the bundle before these checks.

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

The local `.local/` tree is ignored. It may hold an isolated DSH home and a
development launcher, but neither belongs in source control.

`DEEPSEEK_API_KEY` is read by DSH's credential provider at process runtime. It
must not be stored in this repository.
