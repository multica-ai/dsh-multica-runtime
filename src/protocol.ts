import { createHash } from 'node:crypto'

export const PROTOCOL_VERSION = 1 as const
export const MAX_COMMAND_BYTES = 8 * 1024 * 1024
export const MAX_TOOL_OUTPUT_BYTES = 256 * 1024

export interface ModelSelectionInput {
  provider: string
  id: string
  reasoning_effort?: string
}

interface McpServerBase {
  name: string
  tool_call_timeout_ms?: number
}

export interface StdioMcpServer extends McpServerBase {
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

export interface StreamableHttpMcpServer extends McpServerBase {
  transport: 'streamable-http'
  url: string
  headers: Record<string, string>
}

export type McpServerInput = StdioMcpServer | StreamableHttpMcpServer

export interface TaskContractInput {
  goal: string
  acceptance?: string[]
  state_file?: string
  required_checks?: string[]
}

export interface AcceptanceCheckResult {
  command: string
  exit_code: number
  passed: boolean
  output: string
  truncated?: boolean
  error?: { code: string; message: string }
}

export interface ExecuteCommand {
  v: typeof PROTOCOL_VERSION
  type: 'execute'
  request_id: string
  cwd: string
  prompt: string
  resume_session_id?: string
  issue_id?: string
  model?: ModelSelectionInput
  reasoning_effort?: string
  mcp_servers: McpServerInput[]
  task_contract?: TaskContractInput
}

export interface CancelCommand {
  v: typeof PROTOCOL_VERSION
  type: 'cancel'
  request_id: string
}

export type InboundCommand = ExecuteCommand | CancelCommand

export interface RuntimeModelFrame {
  id: string
  label: string
  provider: string
  default?: boolean
  thinking?: {
    supported_levels: Array<{ value: string; label: string; description?: string }>
    default_level?: string
  }
}

export type OutboundFrame =
  | {
    v: typeof PROTOCOL_VERSION
    type: 'ready'
    runtime: 'dsh'
    plugin_version: string
    capabilities: {
      resume: true
      cancel: true
      models: true
      thinking: true
      usage: true
      tools: true
      progress: true
      acceptance: true
      mcp: ['stdio', 'streamable-http']
      issue_id: true
      task_contract: true
    }
  }
  | { v: typeof PROTOCOL_VERSION; type: 'probe'; runtime: 'dsh'; plugin_version: string; protocol_version: number }
  | { v: typeof PROTOCOL_VERSION; type: 'models'; models: RuntimeModelFrame[] }
  | { v: typeof PROTOCOL_VERSION; type: 'session'; request_id: string; session_id: string; resumed: boolean }
  | { v: typeof PROTOCOL_VERSION; type: 'text'; request_id: string; content: string }
  | { v: typeof PROTOCOL_VERSION; type: 'thinking'; request_id: string; content: string }
  | {
    v: typeof PROTOCOL_VERSION
    type: 'progress'
    request_id: string
    phase: string
    message?: string
    data?: Record<string, unknown>
  }
  | { v: typeof PROTOCOL_VERSION; type: 'tool_call'; request_id: string; call_id: string; name: string; arguments: string }
  | {
    v: typeof PROTOCOL_VERSION
    type: 'tool_result'
    request_id: string
    call_id: string
    name: string
    output: string
    is_error: boolean
    truncated?: boolean
  }
  | {
    v: typeof PROTOCOL_VERSION
    type: 'usage'
    request_id: string
    provider: string
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens?: number
    cache_write_tokens?: number
    reasoning_tokens?: number
  }
  | {
    v: typeof PROTOCOL_VERSION
    type: 'result'
    request_id: string
    status: 'completed' | 'failed' | 'aborted' | 'cancelled'
    session_id?: string
    output: string
    stop_reason?: string
    resume_rejected: boolean
    error?: { code: string; message: string }
    acceptance?: { passed: boolean; checks: AcceptanceCheckResult[] }
  }
  | { v: typeof PROTOCOL_VERSION; type: 'protocol_error'; code: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return value
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(value).filter(key => !allowedSet.has(key))
  if (extra.length > 0) throw new Error(`${field} contains unsupported field: ${extra.sort().join(', ')}`)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, field)
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return [...value]
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return [...value]
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {}
  const record = assertRecord(value, field)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string`)
    result[key] = item
  }
  return result
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive integer`)
  return Number(value)
}

function parseModel(value: unknown): ModelSelectionInput | undefined {
  if (value === undefined || value === null) return undefined
  const model = assertRecord(value, 'model')
  assertOnlyKeys(model, ['provider', 'id', 'reasoning_effort'], 'model')
  return {
    provider: requiredString(model.provider, 'model.provider'),
    id: requiredString(model.id, 'model.id'),
    ...optionalString(model.reasoning_effort, 'model.reasoning_effort') === undefined
      ? {}
      : { reasoning_effort: optionalString(model.reasoning_effort, 'model.reasoning_effort') },
  }
}

function parseMcpServer(value: unknown, index: number): McpServerInput {
  const field = `mcp_servers[${index}]`
  const server = assertRecord(value, field)
  const transport = requiredString(server.transport, `${field}.transport`)
  const timeout = optionalPositiveInteger(server.tool_call_timeout_ms, `${field}.tool_call_timeout_ms`)
  if (transport === 'stdio') {
    assertOnlyKeys(server, ['name', 'transport', 'command', 'args', 'env', 'cwd', 'tool_call_timeout_ms'], field)
    return {
      name: requiredString(server.name, `${field}.name`),
      transport,
      command: requiredString(server.command, `${field}.command`),
      args: stringArray(server.args, `${field}.args`),
      env: stringMap(server.env, `${field}.env`),
      ...optionalString(server.cwd, `${field}.cwd`) === undefined
        ? {}
        : { cwd: optionalString(server.cwd, `${field}.cwd`) },
      ...timeout === undefined ? {} : { tool_call_timeout_ms: timeout },
    }
  }
  if (transport === 'streamable-http') {
    assertOnlyKeys(server, ['name', 'transport', 'url', 'headers', 'tool_call_timeout_ms'], field)
    return {
      name: requiredString(server.name, `${field}.name`),
      transport,
      url: requiredString(server.url, `${field}.url`),
      headers: stringMap(server.headers, `${field}.headers`),
      ...timeout === undefined ? {} : { tool_call_timeout_ms: timeout },
    }
  }
  throw new Error(`${field}.transport must be stdio or streamable-http`)
}

function parseMcpServers(value: unknown): McpServerInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('mcp_servers must be an array')
  const servers = value.map(parseMcpServer)
  const names = new Set<string>()
  for (const server of servers) {
    const normalized = normalizeMcpServerName(server.name)
    if (names.has(normalized)) throw new Error(`mcp_servers contains duplicate normalized name: ${normalized}`)
    names.add(normalized)
  }
  return servers
}

function parseTaskContract(value: unknown): TaskContractInput | undefined {
  if (value === undefined || value === null) return undefined
  const contract = assertRecord(value, 'task_contract')
  assertOnlyKeys(contract, ['goal', 'acceptance', 'state_file', 'required_checks'], 'task_contract')
  const acceptance = optionalStringArray(contract.acceptance, 'task_contract.acceptance')
  const requiredChecks = optionalStringArray(contract.required_checks, 'task_contract.required_checks')
  return {
    goal: requiredString(contract.goal, 'task_contract.goal'),
    ...acceptance === undefined ? {} : { acceptance },
    ...optionalString(contract.state_file, 'task_contract.state_file') === undefined
      ? {}
      : { state_file: optionalString(contract.state_file, 'task_contract.state_file') },
    ...requiredChecks === undefined ? {} : { required_checks: requiredChecks },
  }
}

export function parseInboundCommand(line: string): InboundCommand {
  if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) throw new Error('protocol command exceeds 8 MiB')
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('protocol command is not valid JSON')
  }
  const command = assertRecord(parsed, 'command')
  if (command.v !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version: ${String(command.v)}`)
  const type = requiredString(command.type, 'command.type')
  if (type === 'cancel') {
    assertOnlyKeys(command, ['v', 'type', 'request_id'], 'cancel command')
    return {
      v: PROTOCOL_VERSION,
      type,
      request_id: requiredString(command.request_id, 'cancel.request_id'),
    }
  }
  if (type === 'execute') {
    assertOnlyKeys(
      command,
      ['v', 'type', 'request_id', 'cwd', 'prompt', 'resume_session_id', 'issue_id', 'model', 'reasoning_effort', 'mcp_servers', 'task_contract'],
      'execute command',
    )
    return {
      v: PROTOCOL_VERSION,
      type,
      request_id: requiredString(command.request_id, 'execute.request_id'),
      cwd: requiredString(command.cwd, 'execute.cwd'),
      prompt: requiredString(command.prompt, 'execute.prompt'),
      ...optionalString(command.resume_session_id, 'execute.resume_session_id') === undefined
        ? {}
        : { resume_session_id: optionalString(command.resume_session_id, 'execute.resume_session_id') },
      ...optionalString(command.issue_id, 'execute.issue_id') === undefined
        ? {}
        : { issue_id: optionalString(command.issue_id, 'execute.issue_id') },
      ...parseModel(command.model) === undefined ? {} : { model: parseModel(command.model) },
      ...optionalString(command.reasoning_effort, 'execute.reasoning_effort') === undefined
        ? {}
        : { reasoning_effort: optionalString(command.reasoning_effort, 'execute.reasoning_effort') },
      mcp_servers: parseMcpServers(command.mcp_servers),
      ...parseTaskContract(command.task_contract) === undefined
        ? {}
        : { task_contract: parseTaskContract(command.task_contract) },
    }
  }
  throw new Error(`unsupported protocol command type: ${type}`)
}

const VALID_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

export function normalizeMcpServerName(name: string): string {
  if (VALID_MCP_SERVER_NAME.test(name)) return name
  const slug = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

export function truncateUtf8(value: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return { value, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xC0) end--
  return { value: `${bytes.subarray(0, end).toString('utf8')}\n[output truncated]`, truncated: true }
}

export function encodeFrame(frame: OutboundFrame): string {
  return `${JSON.stringify(frame)}\n`
}
