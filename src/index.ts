import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  encodeFrame,
  normalizeMcpServerName,
  parseInboundCommand,
  PROTOCOL_VERSION,
  truncateUtf8,
  type ExecuteCommand,
  type McpServerInput,
  type OutboundFrame,
  type RuntimeModelFrame,
} from './protocol.js'
import { installMulticaTerminalEnvironment } from './environment.js'

export const name = 'multica-dsh-runtime'
export const inject = ['cmdlineArgs', 'agents', 'agentDefaultModel', 'sessions', 'llm']

const PLUGIN_VERSION = '0.1.0-private.1'

interface ActiveRun {
  command: ExecuteCommand
  agent?: Agent
  firstSeq: number
  cancelRequested: boolean
  lastText: string
  endReason?: TurnEndReason
  toolNames: Map<string, string>
}

class ResumeRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResumeRejectedError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeFrame(frame: OutboundFrame): void {
  process.stdout.write(encodeFrame(frame))
}

function writeDiagnostic(message: string): void {
  process.stderr.write(`multica-dsh-runtime: ${message}\n`)
}

function protocolError(code: string, message: string): void {
  writeFrame({ v: PROTOCOL_VERSION, type: 'protocol_error', code, message })
}

function parseMode(args: readonly string[]): 'stdio' | 'probe' | 'list-models' {
  if (args.length !== 1) {
    throw new Error('expected exactly one mode: --stdio, --probe, or --list-models')
  }
  switch (args[0]) {
    case '--stdio': return 'stdio'
    case '--probe': return 'probe'
    case '--list-models': return 'list-models'
    default: throw new Error(`unsupported mode: ${String(args[0])}`)
  }
}

function encodeModelId(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}

async function listModels(ctx: Context): Promise<RuntimeModelFrame[]> {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  if (llm === undefined || defaultModel === undefined) throw new Error('DSH model services are unavailable')
  const selected = defaultModel.currentSelection()
  const result: RuntimeModelFrame[] = []
  for (const provider of llm.listProviders()) {
    let models
    try {
      models = await llm.listModels(provider.id)
    } catch (error: unknown) {
      writeDiagnostic(`model discovery failed for ${provider.id}: ${errorMessage(error)}`)
      continue
    }
    for (const model of models) {
      let resolved
      try {
        resolved = await llm.resolveModelInfo(provider.id, model.id)
      } catch (error: unknown) {
        writeDiagnostic(`model capability lookup failed for ${provider.id}/${model.id}: ${errorMessage(error)}`)
      }
      const reasoning = resolved?.reasoning
      result.push({
        id: encodeModelId(provider.id, model.id),
        label: model.name,
        provider: provider.name,
        ...selected.provider === provider.id && selected.model === model.id ? { default: true } : {},
        ...reasoning === undefined
          ? {}
          : {
              thinking: {
                supported_levels: reasoning.efforts.map(effort => ({
                  value: String(effort.id),
                  label: effort.name,
                  ...effort.description === undefined ? {} : { description: effort.description },
                })),
                ...reasoning.defaultEffort === undefined
                  ? {}
                  : { default_level: String(reasoning.defaultEffort) },
              },
            },
      })
    }
  }
  return result.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label))
}

async function resolveSelection(ctx: Context, command: ExecuteCommand): Promise<ModelSelection> {
  const defaultModel = ctx.get('agentDefaultModel')
  const llm = ctx.get('llm')
  if (defaultModel === undefined || llm === undefined) throw new Error('DSH model services are unavailable')
  const base = command.model === undefined
    ? defaultModel.currentSelection()
    : { provider: command.model.provider, model: command.model.id }
  const info = await llm.resolveModelInfo(base.provider, base.model)
  const effort = command.reasoning_effort ?? command.model?.reasoning_effort
  if (effort !== undefined && !info.reasoning?.efforts.some(item => String(item.id) === effort)) {
    throw new Error(`reasoning effort ${effort} is not supported by ${base.provider}/${base.model}`)
  }
  return {
    provider: base.provider,
    model: base.model,
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }
}

function mcpConfig(server: McpServerInput, taskCwd: string): McpClient.Config {
  const common = {
    serverName: normalizeMcpServerName(server.name),
    toolCallTimeoutMs: server.tool_call_timeout_ms ?? 60_000,
    failOnStartupError: true,
  }
  if (server.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd ?? taskCwd,
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: server.url,
    headers: server.headers,
  }
}

async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch {
    return resolve(left) === resolve(right)
  }
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'image':
      return `[image attachment ${block.attachment.attachmentId}]`
    case 'tool-call':
      return `[tool call ${block.name}: ${block.arguments}]`
    case 'tool-result':
      return block.content.map(renderBlock).join('')
    default:
      return JSON.stringify(block)
  }
}

function observeSessionEvent(active: ActiveRun, session: Agent['session'], event: SessionEvent): void {
  if (active.agent?.session !== session || event.seq < active.firstSeq) return
  const requestId = active.command.request_id
  if (event.type === 'assistant/message') {
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text !== '') {
      active.lastText = text
      writeFrame({ v: PROTOCOL_VERSION, type: 'text', request_id: requestId, content: text })
    }
    for (const block of event.data.message.content) {
      if (block.type === 'reasoning' && block.text !== '') {
        writeFrame({ v: PROTOCOL_VERSION, type: 'thinking', request_id: requestId, content: block.text })
      }
    }
    const usage = event.data.usage
    if (usage !== undefined) {
      writeFrame({
        v: PROTOCOL_VERSION,
        type: 'usage',
        request_id: requestId,
        provider: event.data.message.source.provider,
        model: event.data.message.source.model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        ...usage.cacheReadTokens === undefined ? {} : { cache_read_tokens: usage.cacheReadTokens },
        ...usage.cacheWriteTokens === undefined ? {} : { cache_write_tokens: usage.cacheWriteTokens },
        ...usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens },
      })
    }
    return
  }
  if (event.type === 'tool/call') {
    const callId = String(event.data.callId)
    active.toolNames.set(callId, event.data.name)
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'tool_call',
      request_id: requestId,
      call_id: callId,
      name: event.data.name,
      arguments: event.data.arguments,
    })
    return
  }
  if (event.type === 'tool/result') {
    const result = event.data.message.content[0]
    const rendered = truncateUtf8(result.content.map(renderBlock).join(''))
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'tool_result',
      request_id: requestId,
      call_id: String(result.toolCallId),
      name: active.toolNames.get(String(result.toolCallId)) ?? 'unknown',
      output: rendered.value,
      is_error: result.isError === true,
      ...rendered.truncated ? { truncated: true } : {},
    })
    return
  }
  if (event.type === 'turn/end') active.endReason = event.data.reason
}

async function drainContinuableSubagents(ctx: Context, agent: Agent): Promise<void> {
  const subagents = ctx.get('subagents') as {
    drainContinuableDescendants?(parents: readonly Agent[]): Promise<void>
  } | undefined
  await subagents?.drainContinuableDescendants?.([agent])
}

function resultFromReason(active: ActiveRun): Omit<Extract<OutboundFrame, { type: 'result' }>, 'v' | 'type' | 'request_id' | 'session_id'> {
  const reason = active.endReason
  if (active.cancelRequested) {
    return { status: 'cancelled', output: active.lastText, stop_reason: 'cancelled', resume_rejected: false }
  }
  if (reason?.kind === 'completed' || reason?.kind === 'max-tokens') {
    return { status: 'completed', output: active.lastText, stop_reason: reason.kind, resume_rejected: false }
  }
  if (reason?.kind === 'aborted') {
    return { status: 'aborted', output: active.lastText, stop_reason: reason.kind, resume_rejected: false }
  }
  if (reason?.kind === 'error') {
    return {
      status: 'failed',
      output: active.lastText,
      stop_reason: reason.kind,
      resume_rejected: false,
      error: { code: reason.error.code, message: reason.error.message },
    }
  }
  const stopReason = reason?.kind ?? 'no-turn-result'
  return {
    status: 'failed',
    output: active.lastText,
    stop_reason: stopReason,
    resume_rejected: false,
    error: { code: 'DSH_TURN_FAILED', message: `DSH turn ended with ${stopReason}` },
  }
}

async function createOrResumeAgent(
  ctx: Context,
  active: ActiveRun,
  selection: ModelSelection,
): Promise<{ handle: AgentHandle; resumed: boolean }> {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new Error('DSH agent registry is unavailable')
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  const setup = async (agentCtx: Context): Promise<void> => {
    installModelSelection(agentCtx, selected)
    agentCtx.on('approval/request', (_request, next) => {
      if (active.cancelRequested) return Promise.resolve<ApprovalOutcome>('cancelled')
      return Promise.resolve<ApprovalOutcome>('allowed-once').catch(() => next())
    })
    for (const server of active.command.mcp_servers) {
      await agentCtx.plugin(McpClient, mcpConfig(server, active.command.cwd))
    }
  }
  const options = { provider: selection.provider, model: selection.model }
  if (active.command.resume_session_id === undefined) {
    const handle = await agents.create({
      sessionId: SessionId(`multica-${randomUUID()}`),
      meta: { cwd: active.command.cwd },
      agentOptions: options,
      setup,
    })
    return { handle, resumed: false }
  }
  let handle: AgentHandle
  try {
    handle = await agents.resume({
      resumeSessionId: SessionId(active.command.resume_session_id),
      agentOptions: options,
      setup,
    })
  } catch (error: unknown) {
    throw new ResumeRejectedError(`could not resume DSH session ${active.command.resume_session_id}`, { cause: error })
  }
  if (!await sameDirectory(handle.agent.session.header.cwd, active.command.cwd)) {
    await handle.dispose()
    throw new ResumeRejectedError('the resumed DSH session belongs to a different working directory')
  }
  return { handle, resumed: true }
}

async function execute(ctx: Context, active: ActiveRun): Promise<number> {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('DSH session service is unavailable')
  let handle: AgentHandle | undefined
  try {
    if (!isAbsolute(active.command.cwd)) throw new Error('execute.cwd must be an absolute path')
    const selection = await resolveSelection(ctx, active.command)
    const created = await createOrResumeAgent(ctx, active, selection)
    handle = created.handle
    active.agent = handle.agent
    await handle.agent.whenIdle()
    active.firstSeq = handle.agent.session.seq
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'session',
      request_id: active.command.request_id,
      session_id: String(handle.agent.session.id),
      resumed: created.resumed,
    })
    if (!active.cancelRequested) {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: active.command.prompt }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
    }
    await drainContinuableSubagents(ctx, handle.agent)
    await sessions.flush(handle.agent.session)
    const sessionId = String(handle.agent.session.id)
    const result = resultFromReason(active)
    await handle.dispose()
    handle = undefined
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: active.command.request_id,
      session_id: sessionId,
      ...result,
    })
    return result.status === 'completed' || result.status === 'cancelled' ? 0 : 1
  } catch (error: unknown) {
    if (handle !== undefined) {
      try {
        handle.agent.cancel({ kind: 'user' })
        await handle.agent.whenIdle()
        await sessions.flush(handle.agent.session)
        await handle.dispose()
      } catch (cleanupError: unknown) {
        writeDiagnostic(`cleanup failed: ${errorMessage(cleanupError)}`)
      }
    }
    const resumeRejected = error instanceof ResumeRejectedError
    const cause = error instanceof Error && error.cause !== undefined ? `: ${errorMessage(error.cause)}` : ''
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: active.command.request_id,
      status: active.cancelRequested ? 'cancelled' : 'failed',
      output: active.lastText,
      resume_rejected: resumeRejected,
      error: {
        code: resumeRejected ? 'DSH_RESUME_REJECTED' : 'DSH_RUNTIME_ERROR',
        message: `${errorMessage(error)}${cause}`,
      },
    })
    return active.cancelRequested ? 0 : 1
  }
}

async function stdio(ctx: Context): Promise<number> {
  const forwarding = await installMulticaTerminalEnvironment(ctx)
  if (forwarding !== undefined && !forwarding.forwarded) {
    // Fail loudly at boot instead of twenty seconds later, as an opaque
    // "requires a task-scoped mat_ token" refusal on the agent's first
    // `multica` call (MUL-6186).
    writeDiagnostic(
      'MULTICA_TOKEN is not reaching model-spawned subprocesses; in-task multica commands will be refused',
    )
  }
  const activeRef: { current?: ActiveRun; finished: boolean } = { finished: false }
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (activeRef.current !== undefined) observeSessionEvent(activeRef.current, session, event)
  })

  const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
  let resolveExecute: ((command: ExecuteCommand) => void) | undefined
  let rejectExecute: ((error: Error) => void) | undefined
  const firstExecute = new Promise<ExecuteCommand>((resolveCommand, rejectCommand) => {
    resolveExecute = resolveCommand
    rejectExecute = rejectCommand
  })
  input.on('line', (line) => {
    try {
      const command = parseInboundCommand(line)
      if (command.type === 'execute') {
        if (activeRef.current !== undefined || resolveExecute === undefined) {
          protocolError('DUPLICATE_EXECUTE', 'this DSH process accepts exactly one execute command')
          return
        }
        const active: ActiveRun = {
          command,
          firstSeq: Number.MAX_SAFE_INTEGER,
          cancelRequested: false,
          lastText: '',
          toolNames: new Map(),
        }
        activeRef.current = active
        const resolveCommand = resolveExecute
        resolveExecute = undefined
        rejectExecute = undefined
        resolveCommand(command)
        return
      }
      const active = activeRef.current
      if (active === undefined || command.request_id !== active.command.request_id || activeRef.finished) return
      active.cancelRequested = true
      active.agent?.cancel({ kind: 'user' })
    } catch (error: unknown) {
      protocolError('INVALID_COMMAND', errorMessage(error))
      const active = activeRef.current
      if (active === undefined && rejectExecute !== undefined) {
        rejectExecute(new Error(errorMessage(error)))
        resolveExecute = undefined
        rejectExecute = undefined
      } else if (active !== undefined) {
        active.cancelRequested = true
        active.agent?.cancel({ kind: 'user' })
      }
    }
  })
  input.on('close', () => {
    if (activeRef.current === undefined && rejectExecute !== undefined) {
      rejectExecute(new Error('stdin closed before execute'))
    }
  })

  writeFrame({
    v: PROTOCOL_VERSION,
    type: 'ready',
    runtime: 'dsh',
    plugin_version: PLUGIN_VERSION,
    capabilities: {
      resume: true,
      cancel: true,
      models: true,
      thinking: true,
      usage: true,
      tools: true,
      mcp: ['stdio', 'streamable-http'],
    },
  })
  try {
    await firstExecute
  } catch (error: unknown) {
    writeDiagnostic(errorMessage(error))
    input.close()
    return 1
  }
  const active = activeRef.current
  if (active === undefined) return 1
  const code = await execute(ctx, active)
  activeRef.finished = true
  input.close()
  return code
}

async function run(ctx: Context): Promise<void> {
  await ctx.get('loader')?.await()
  const appExit = ctx.get('appExit')
  const cmdlineArgs = ctx.get('cmdlineArgs')
  if (appExit === undefined || cmdlineArgs === undefined) {
    throw new Error('the DSH launcher did not provide cmdlineArgs/appExit')
  }
  let code = 1
  try {
    const mode = parseMode(cmdlineArgs.get())
    if (mode === 'probe') {
      writeFrame({
        v: PROTOCOL_VERSION,
        type: 'probe',
        runtime: 'dsh',
        plugin_version: PLUGIN_VERSION,
        protocol_version: PROTOCOL_VERSION,
      })
      code = 0
    } else if (mode === 'list-models') {
      writeFrame({ v: PROTOCOL_VERSION, type: 'models', models: await listModels(ctx) })
      code = 0
    } else {
      code = await stdio(ctx)
    }
  } catch (error: unknown) {
    writeDiagnostic(errorMessage(error))
    protocolError('STARTUP_FAILED', errorMessage(error))
  }
  appExit(code)
}

export function apply(ctx: Context): void {
  void run(ctx).catch((error: unknown) => {
    writeDiagnostic(errorMessage(error))
    ctx.get('appExit')?.(1)
  })
}

export * from './protocol.js'
export * from './environment.js'
