# dsh-multica-runtime 兼容 DSH 0.2.1+ 迁移分析

结论先行：这个插件在 0.2.1 上**首先不是“某个 API 崩了”，而是整层 bundle 被版本门禁跳过**——进程正常启动，但 bridge 根本没挂载，`--probe` 永远没有输出。修好元数据后还有一处真正的代码断裂（`tool/result` 消息结构），以及两处会静默改变行为的 patch/配置问题。

本文所有结论都在本机 DSH **0.2.1-rc.2** 上做过对照实测：原始插件被拒、修复副本 `--probe` 成功、类型检查从 6 个错误降到 0。

> 状态（2026-10-18）：文中的修改已应用到当前工作树，并通过 `pnpm check` 与隔离 `DSH_HOME` 的 `--probe` 验证；先前用于试算的 `compat-dsh-0.2.1.patch` 已应用后移除。

## 0. 验证环境与判定方法

| 项 | 值 |
|---|---|
| 已安装运行时 | `/home/zhangbin/.npm/_npx/57e83f33d8ab027d`，`@deepseek-ai/dsh` **0.2.1-rc.2** |
| 同版本源码树 | `/home/zhangbin/github/deepseek-harness/deepseek-harness`（0.2.1-rc.2，用于读实现与门禁源码） |
| 插件基线 | 本仓库源码，README 声明基线 **0.1.0-rc.6** |
| 判定手段 | ① 两版真实 `tsc` 类型检查；② 安装版 `evaluatePluginCompatibility` 实测门禁；③ 隔离 `DSH_HOME` 端到端 `--probe`（原始 vs 修复） |

## 1. 五处必须修改（按修复优先级）

| # | 文件 | 修改 | 不改的后果 |
|---|---|---|---|
| P0-1 | `package.json` | 8 个 `@deepseek-ai/dsh-*` peer **和 devDependencies** 由 `^0.1.0-rc.6` 升到 `^0.2.1-rc.2`；新增 `engines.dsh` | bundle 被整层跳过（安装期/启动期/行级三处拒绝），bridge 完全不加载 |
| P0-2 | `src/index.ts` | tool 结果改读 `ToolResultMessage` 一级字段；删 `renderBlock` 的 `tool-result` 分支 | 类型错误；运行时 `TypeError` 被 `session/event` 容器吞掉 → **每条 tool_result 帧静默丢失** |
| P0-3 | `cordis.patch.yml` | `persona:` → `personaPrefix:`，并删除 `{{cwd}}` 子句 | 人格静默变空（0.2.1 不读 `persona` 键）；若只改键名不删 `{{cwd}}`，首次 assemble 直接抛错 |
| P1 | `src/index.ts` | `subagents.drainContinuableDescendants` → `drainDescendants` | 可选链变 no-op，子代理永不 drain，且无任何报错 |
| P1 | `cordis.patch.yml` | `telemetry-otel` → `session-telemetry-otel` | patch 目标不存在，仅告警跳过；“关闭遥测”的隐私承诺失效 |

建议顺手做（非阻断）：`turn/end` 新增 kind 的映射、README 基线更新、为 tool_result 新结构补一条回归测试、`PLUGIN_VERSION` 与包版本同步、重新生成 `pnpm-lock.yaml`。

## 2. P0-1 版本门禁：先于一切发生的失败

### 2.1 机制

0.2.1 在三个位置判定插件/ bundle 的 DSH 版本要求（源码 `packages/boot/app-boot/src/plugin-compatibility.ts:51-102`）：

1. **安装前置**：`dsh plugin --profile X add <path>` 在 pnpm 之前读 manifest，未通过则 `installation rejected … nothing was installed`。
2. **启动期整层**：profile 的每个 bundle 层在组合前判定，未通过则整层 skip，只打一行 stderr，进程照常启动。
3. **行级预检**：组合出的每一行（包括 bundle 自己 insert 的行）按被解析到的插件 manifest 再判一次，未通过则 `disabled = true`。

判定规则：若 manifest 有 `engines.dsh` 则**只看它**；否则检查每一个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 是否满足运行版本（`semver.satisfies`，`includePrerelease: true`）。本插件 8 个 peer 全是 `^0.1.0-rc.6`，上界 `<0.2.0`，0.2.1-rc.2 全部不满足。

### 2.2 实测（原始插件，隔离 DSH_HOME）

```text
$ DSH_HOME=... node .../dsh/lib/bin.js --profile multica --probe
dsh: skipping profile bundle "@multica-ai/dsh-runtime": Error: Plugin @multica-ai/dsh-runtime@0.1.0-private.1
is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-agent":"^0.1.0-rc.6",
"@deepseek-ai/dsh-agent-default-model":"^0.1.0-rc.6","@deepseek-ai/dsh-cmdline":"^0.1.0-rc.6",
"@deepseek-ai/dsh-llm":"^0.1.0-rc.6","@deepseek-ai/dsh-mcp-client":"^0.1.0-rc.6",
"@deepseek-ai/dsh-session":"^0.1.0-rc.6","@deepseek-ai/dsh-subprocess":"^0.1.0-rc.6",
"@deepseek-ai/dsh-user-approval":"^0.1.0-rc.6"}. Running it may cause crashes or data loss. ...
Exact-version exemption: not active.
[超时退出 124，stdout 为空]
```

这就是“不支持 0.2.1 以上”的直接原因：Multica daemon 走 `--probe` 探测协议版本，永远拿不到应答。

### 2.3 修法

```jsonc
// package.json
"version": "0.1.0-private.2",
"engines": {
  "node": "^22.19.0 || >=24.0.0",
  "dsh": ">=0.2.1-rc.2 <0.3.0"      // 新增：门禁只看它
},
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.0.5",                              // 对齐 DSH 0.2.1 同代（门禁不检查该包名）
  "@deepseek-ai/cordis-plugin-loader": "~1.0.6",                // 同上
  "@deepseek-ai/dsh-agent": "^0.2.1-rc.2",                      // 8 个 dsh peer 全升
  "@deepseek-ai/dsh-agent-default-model": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-cmdline": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-llm": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-mcp-client": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-session": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-subprocess": "^0.2.1-rc.2",
  "@deepseek-ai/dsh-user-approval": "^0.2.1-rc.2"
},
"devDependencies": { /* 同样 8 个同步到 ^0.2.1-rc.2；cordis/loader 不动 */ }
```

三个要点：

- **cordis 版本要对齐运行时常量**。`dsh-mcp-client@0.2.1-rc.2` 要求 `@deepseek-ai/cordis ~4.0.5`，而 4.0.1 缺少 `Volatile` 导出，`skipLibCheck:false` 时 `dsh-agent-default-model` 的 `.d.ts` 会直接报错。因此把 cordis / cordis-plugin-loader 的 peer 与 dev 依赖一起对齐到 `~4.0.5` / `~1.0.6`。
- **补一个纯类型依赖**。`dsh-mcp-client@0.2.1-rc.2` 的 `.d.ts` 引用 `@deepseek-ai/dsh-mcp-resources`，而它只是 optional peer，pnpm 不会自动安装；把它加进 devDependencies（`0.2.1-rc.2`）即可让 `pnpm typecheck` 通过。
- **devDependencies 不是可选项**。实测 `dsh plugin add <path>` 会把本地目录记成 `link:`（符号链接），插件运行时从**自己的 node_modules** 解析 `@deepseek-ai/dsh-*`。devDeps 若仍是 0.1.0-rc.6，即使门禁通过，插件也会在 0.2.1 宿主里加载 0.1.0 的模块副本。
- `engines.dsh` 存在时 peers 不参与门禁，但仍要升：它们是类型与安装正确性的事实声明，也避免误导后续维护者。

验证：

```text
gate: undefined            # 修复后的 manifest 通过门禁
{"v":1,"type":"probe","runtime":"dsh","plugin_version":"0.1.0-private.2","protocol_version":1}
EXIT=0
```

## 3. P0-2 会话事件：tool 结果从“内容块”变成“消息”

### 3.1 变化

旧（0.1.0-rc.6）：

- `ContentBlockMap` 含 `'tool-result': ToolResultBlock`；
- `tool/result` 事件的 `data.message.content[0]` 就是这个块，`toolCallId` / `isError` / `content` 都在块上。

新（0.2.1-rc.2）：

- `ContentBlockMap` 只剩 `text | reasoning | image | file | tool-call | tool-addition | tool-removal`；
- tool 结果是 `role: 'tool'` 的一等消息：`data.message.toolCallId`、`data.message.isError`、`data.message.content`（普通内容块数组）。

证据：`dsh-llm/lib/types/types.d.ts:114-126`、`dsh-llm/lib/types/message.d.ts:153-160`、`dsh-session/lib/types/types.d.ts:375-389`。

### 3.2 实测类型错误（原始源码 × 0.2.1 类型）

```text
src/index.ts(198,10): error TS2678: Type '"tool-result"' is not comparable to type
  '"text" | "image" | "reasoning" | "file" | "tool-call" | "tool-addition" | "tool-removal"'.
src/index.ts(199,20): error TS2339: Property 'content' does not exist on type 'never'.
src/index.ts(254,42): error TS2339: Property 'content' does not exist on type 'ContentBlock'.
src/index.ts(259,30): error TS2339: Property 'toolCallId' does not exist on type 'ContentBlock'.
src/index.ts(260,48): error TS2339: Property 'toolCallId' does not exist on type 'ContentBlock'.
src/index.ts(262,24): error TS2339: Property 'isError' does not exist on type 'ContentBlock'.
```

同一份源码对 0.1.0-rc.6 类型检查为 **0 错误**——基线成立。

运行时后果更隐蔽：`session/event` 的 observer 异常被 Session 容器化（`dsh-session/lib/types/index.d.ts:51-60`），turn 不失败、进程不崩，但 `content[0].content` 是 `undefined`，`.map` 抛错后**该条 tool_result 帧永远不发出**。

### 3.3 修法

```ts
// renderBlock：删除已不存在的分支
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'image':
      return `[image attachment ${block.attachment.attachmentId}]`
    case 'tool-call':
      return `[tool call ${block.name}: ${block.arguments}]`
    default:
      return JSON.stringify(block)
  }
}

// observeSessionEvent：tool 结果直接读消息一级字段
if (event.type === 'tool/result') {
  const result = event.data.message
  const callId = String(result.toolCallId)
  const rendered = truncateUtf8(result.content.map(renderBlock).join(''))
  writeFrame({
    v: PROTOCOL_VERSION,
    type: 'tool_result',
    request_id: requestId,
    call_id: callId,
    name: active.toolNames.get(callId) ?? 'unknown',
    output: rendered.value,
    is_error: result.isError === true,
    ...rendered.truncated ? { truncated: true } : {},
  })
  return
}
```

新 `ContentBlock` 多了 `file` / `tool-addition` / `tool-removal`，默认分支会 JSON 序列化；如需更友好的展示可各加一个占位分支（非阻断）。

## 4. P0-3 patch 配置：人格键改名 + `{{cwd}}` 已删除

### 4.1 `persona` → `personaPrefix`

0.2.1 的 `dsh-system-prompt` Config 只有 `personaPrefix` / `personaSuffix`（`packages/core/system-prompt/src/index.ts:257-275`）。schemastery 对未知键**保留但不报错**，插件又不读 `persona`，所以现状是**人格整段静默丢失**——headless、不要调用 `ask_user_question` 这些给 agent 的约束都没有了。

### 4.2 `{{cwd}}` 必须删

0.2.1 只注册 `provider` / `model` 两个提示变量（`packages/core/agent-loop/src/index.ts:389-390`），`{{cwd}}` 已移除（升级指南 `docs/upgrade-guide/v0.2.1-alpha.1/working-directory/guide.md`），插值是严格的。实测：

```text
"Your working directory is {{cwd}}. You are {{model}}."
  -> THROW: unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"; registered variables: provider, model
"You are {{model}}."
  -> "You are deepseek-flash."
```

注意顺序：如果只把 `persona` 改名为 `personaPrefix` 却没删 `{{cwd}}`，会从“静默丢失”升级为“每个 turn 首次 assemble 直接失败”。工作目录由 working-directory 上下文提供，不需要写进人格。

### 4.3 遥测行 id 已改名

`telemetry-otel` 在 0.2.1 不存在，实际行 id 是 `session-telemetry-otel`（`packages/bundle/base/cordis.patch.yml:218`）。patch 找不到目标是“告警并跳过”（`cordis-plugin-include/src/index.ts:109-113`），所以“关闭遥测”的隐私意图从未生效；base 里该行默认 `mode: FEEDBACK_ONLY` 仍挂载。

```yaml
- id: hmr
  disabled: true

- id: session-telemetry-otel        # 原 telemetry-otel：改名后才能真正禁用
  disabled: true

- id: session-persistence-jsonl
  config:
    root: !!js process.env.MULTICA_DSH_SESSION_ROOT ?? dshHomePath('sessions')

- id: system-prompt
  config:
    personaPrefix: >-              # 原 persona
      You are a coding agent powered by the {{model}} model and running for Multica.
      This runtime is headless: do not call ask_user_question. When a genuinely
      user-owned decision blocks progress, explain the decision and available
      options in your final response.
```

`headless-runner` 这个 insert 行 id 的注释（“启动器把它当 one-shot 面”）已经过时；但它恰好命中 0.2.1 app-boot 的 `requiredStartupEntryIds`（`packages/boot/app-boot/src/index.ts:951-960`），保留可获得“启用但没激活就启动失败”的 fail-loud 收益。前提是 profile 不同时选 `@deepseek-ai/dsh-headless`（同 id 会被覆盖）。建议保留 id、改写注释。

## 5. 静默行为断裂（不阻塞启动，但会改变产品行为）

1. **子代理 drain 改名**：0.2.1 只有 `subagents.drainDescendants(parents)`（`dsh-subagent/lib/types/index.d.ts:207`）；插件用 `drainContinuableDescendants?.(...)` 的可选链，方法不存在就静默 no-op。过渡期可双名兼容：

```ts
const subagents = ctx.get('subagents') as {
  drainDescendants?(parents: readonly Agent[]): Promise<void>
  drainContinuableDescendants?(parents: readonly Agent[]): Promise<void>
} | undefined
if (subagents?.drainDescendants !== undefined) {
  await subagents.drainDescendants([agent])   // 必须按方法调用
  return
}
await subagents?.drainContinuableDescendants?.([agent])
```

注意必须保留 receiver：0.2.1 的 `drainDescendants` 读取自身的 `this.manager`，把方法取出来再单独调用会得到 `TypeError: Cannot read properties of undefined (reading 'manager')`。这一点是在本机真实 `--stdio` 冒烟测试里发现的，单元测试和 `--probe` 都覆盖不到。

2. **`turn/end` 新增 kind**：0.2.1 增加 `blocked` / `interrupted` / `forked`（`dsh-session/lib/types/types.d.ts:166-211`）。现有代码会落进兜底 `failed`；建议至少把 `blocked` 映射为非错误终止，并给 `interrupted` 独立 stop_reason，便于 Multica 侧区分展示。

3. **默认模型 id 变化**：base 组合默认从 `deepseek-v4-flash` 改为 `deepseek-flash`。插件本身用 `agentDefaultModel.currentSelection()` 没问题；但 Multica daemon 若缓存了旧 model id 并显式下发，会得到未知模型错误。以 `--list-models` 实时结果为准，不要缓存。

## 6. 已确认“不用改”的部分

| API / 机制 | 结论 |
|---|---|
| `SessionId`、`session.id` / `.seq` / `.header.cwd` | 仍在；只增加了品牌类型/格式版本，插件用法不变 |
| `sessions.flush(session)` | 签名与实现未变（`dsh-session/lib/types/index.d.ts:470-483`） |
| `ctx.on('session/event', (session, event))` | 事件名、参数、类型未变 |
| `assistant/message` 的 text / reasoning / usage / source | 仍然每个 step 一条完整消息，字段全在；新增 `stream`/`interrupted` 对读方无感 |
| `tool/call` 的 callId / name / arguments | 同形状（品牌类型改名） |
| `agent.cancel({ kind: 'user' })` | `AgentCancelCause` 仍含 `'user'` |
| `createUserMessage` / `ReasoningEffortId` / `llm.listProviders/listModels/resolveModelInfo` 与 reasoning 结构 | 逐字段一致 |
| `McpClient.Config` 与 `agentCtx.plugin(McpClient, cfg)` | 仍是 0.2.1 官方唯一用法（ACP 同构） |
| `SENSITIVE_ENV_PATTERN` / `scrubbedParentEnv` 的 monkey-patch | 导出与实现未变，实测 patch 后 `MULTICA_TOKEN` 通过、模型凭据仍被清洗 |
| `ApprovalOutcome` / `approval/request` | listener 签名与返回类型不变 |
| `agentDefaultModel.currentSelection()` | 仍在，返回 `ModelSelection` |
| inject `['cmdlineArgs','agents','agentDefaultModel','sessions','llm']` | 5 个服务名全部合法 |
| `--probe` / `--list-models` / `--stdio` 自定义参数 | launcher `allowUnknownOption() + passThroughOptions()`，原样透传 |
| `loader.await()` / `appExit` / `cmdlineArgs` | 仍在，launcher 挂载前提供 |
| `dsh.bundle.patch` 发现机制、`dshHomePath()`、`hmr` 行、jsonl root | 均未变 |
| resume 旧会话 | 会话格式 v0→v4 迁移内建在 `dsh-session-persistence-jsonl` 依赖里，插件无需改 |

## 7. 实施步骤

```bash
# 1. 改三个文件（本文所列改动已应用；package.json / cordis.patch.yml / src/index.ts）
#    package.json / cordis.patch.yml / src/index.ts

# 2. 重装依赖并重新生成 lockfile（pnpm，不要用 npm）
pnpm install
pnpm check          # typecheck + vitest + tsc build
#    注意：本轮未跑 vitest（本机无依赖）；建议补一条 tool_result 新结构的回归测试

# 3. 装进 profile（--profile 必须在 pnpm 参数之前）
dsh plugin --profile multica add /absolute/path/to/dsh-multica-runtime

# 4. 端到端确认
dsh --profile multica --probe        # 期望：{"v":1,"type":"probe",...,"protocol_version":1}
dsh --profile multica --list-models  # 期望：模型数组（无凭据时为空数组，正常）
```

本机已在隔离 `DSH_HOME` 完整跑通上述第 3、4 步。

## 8. 升级后仍需注意

- **运行副本必须与宿主同版本**：插件用 `link:` 安装时从自身 node_modules 解析 DSH 包；请确保构建/部署机执行过 `pnpm install`，且其中 `@deepseek-ai/dsh-*` 就是目标版本。若把插件打成 tarball 装进 profile，注意 `file:` 安装只复制 `files` 字段内容、不含 node_modules，需要改为自包含或声明运行时依赖。
- **临时豁免只能救急**：`dsh plugin --profile multica allow-version @multica-ai/dsh-runtime@0.1.0-private.1 --dsh-version 0.2.1-rc.2 --accept-risk` 能让旧包过门禁，但代码级断裂仍在（tool 帧丢失、人格丢失），不建议作为交付方案。
- **Multica 侧无需改协议**：`protocol_version` 仍是 1，probe/ready 帧格式未变。
- **升级 profile 里的官方 bundles 到 0.2.1 后再装插件**，避免宿主与插件副本再次错位。

## 附录 A：证据索引

| 主题 | 位置 |
|---|---|
| 门禁实现 | `packages/boot/app-boot/src/plugin-compatibility.ts:51-102` |
| bundle 整层 skip | `packages/boot/app-boot/src/profile.ts:740-774` |
| 行级预检 | `packages/boot/app-boot/src/compatibility-preflight.ts:89-128` |
| 安装前置拒绝 | `packages/boot/plugin-manager/src/operations.ts:167-188, 333-352` |
| ContentBlock 变化 | `dsh-llm/lib/types/types.d.ts:114-126`；`message.d.ts:153-160` |
| tool/result 事件 | `dsh-session/lib/types/types.d.ts:375-389` |
| persona 配置 | `packages/core/system-prompt/src/index.ts:257-275, 430-437` |
| 提示变量注册 | `packages/core/agent-loop/src/index.ts:389-390` |
| 遥测行 id | `packages/bundle/base/cordis.patch.yml:218-232` |
| required 行 id | `packages/boot/app-boot/src/index.ts:951-960` |
| drain 改名 | `dsh-subagent/lib/types/index.d.ts:207, 218` |
| 升级指南 | `docs/upgrade-guide/v0.2.1-alpha.1/working-directory`、`v0.2.1-alpha.1/plugin-option-placement`、`v0.2.1-alpha.3/plugin-engines-dsh` |

## 附录 B：验证记录（本机）

1. 基线类型检查：原始源码 × 0.1.0-rc.6 → 0 错误。
2. 断裂类型检查：原始源码 × 0.2.1-rc.2 → 6 错误（见 §3.2）。
3. 修复类型检查：修复源码 × 0.2.1-rc.2 → 0 错误（`skipLibCheck: false`）。
4. 门禁：原始 manifest → 8 项 unmet；修复 manifest → `undefined`（通过）。
5. 端到端：原始插件 `--probe` → bundle 被 skip、无输出、超时 124；修复插件 `--probe` → 协议帧、退出 0；`--list-models` → `{"type":"models","models":[]}`、退出 0。
6. 安装流程：隔离 `DSH_HOME` 中 `dsh plugin --profile multica add <path>` 成功，记录为 `link:` 并自动追加 `dsh.profile.bundles`；随后 `--probe` 通过。
7. 本机真实环境（`~/.dsh/profiles/multica`，link 到本仓库）：`--probe` 返回协议帧；`--list-models` 返回 `deepseek-v4-pro` / `deepseek-flash`；`--stdio` 跑真实小任务得到 `ready → session → text "OK" → usage → result(completed)`，再用同一 session `resume` 得到 `resumed:true`。冒烟测试同时暴露并修复了 `drainDescendants` 的 receiver 问题。

更细的逐条证据（含运行时探针、源码行号）保存在工作区 `.multica-compat/findings-session.md`、`findings-llm-mcp.md`、`findings-bundle.md`；修复对照副本在 `.multica-compat/fixed-plugin`。
