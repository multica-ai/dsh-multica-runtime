import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  normalizeMcpServerName,
  parseInboundCommand,
  PROTOCOL_VERSION,
  truncateUtf8,
} from '../src/protocol.js'
import { multicaTerminalEnvironment } from '../src/task-env.js'

describe('Multica terminal environment', () => {
  it('forwards only a task-scoped Multica token', () => {
    expect(multicaTerminalEnvironment({
      MULTICA_TOKEN: 'mat_task-token',
      DEEPSEEK_API_KEY: 'provider-secret',
      OTHER_TOKEN: 'other-secret',
    })).toEqual({ MULTICA_TOKEN: 'mat_task-token' })
  })

  it('does not forward a user PAT or arbitrary credentials', () => {
    expect(multicaTerminalEnvironment({
      MULTICA_TOKEN: 'mul_user-token',
      DEEPSEEK_API_KEY: 'provider-secret',
    })).toEqual({})
  })
})

describe('parseInboundCommand', () => {
  it('parses an execute command with model and MCP servers', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'run tests',
      model: { provider: 'deepseek-official', id: 'deepseek-v4-flash', reasoning_effort: 'high' },
      reasoning_effort: 'max',
      mcp_servers: [{
        name: 'filesystem',
        transport: 'stdio',
        command: 'mcp-filesystem',
        args: ['/work'],
        env: { MODE: 'read-write' },
      }],
    }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'run tests',
      model: { provider: 'deepseek-official', id: 'deepseek-v4-flash', reasoning_effort: 'high' },
      reasoning_effort: 'max',
      mcp_servers: [{
        name: 'filesystem',
        transport: 'stdio',
        command: 'mcp-filesystem',
        args: ['/work'],
        env: { MODE: 'read-write' },
      }],
    })
  })

  it('parses an optional task contract', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-2',
      cwd: '/work',
      prompt: 'implement feature',
      task_contract: {
        goal: 'make tests pass',
        acceptance: ['tests pass'],
        state_file: '.multica/progress.jsonl',
        required_checks: ['pnpm test'],
      },
    }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'execute',
      request_id: 'request-2',
      cwd: '/work',
      prompt: 'implement feature',
      mcp_servers: [],
      task_contract: {
        goal: 'make tests pass',
        acceptance: ['tests pass'],
        state_file: '.multica/progress.jsonl',
        required_checks: ['pnpm test'],
      },
    })
  })

  it('rejects malformed task contract fields', () => {
    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-3',
      cwd: '/work',
      prompt: 'hello',
      task_contract: { goal: 123 },
    }))).toThrow('task_contract.goal must be a non-empty string')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-4',
      cwd: '/work',
      prompt: 'hello',
      task_contract: { goal: 'ok', unexpected: true },
    }))).toThrow('task_contract contains unsupported field')
  })

  it('defaults the MCP list and rejects unknown fields', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'hello',
    }))).toMatchObject({ mcp_servers: [] })

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'cancel',
      request_id: 'request-1',
      secret: true,
    }))).toThrow('unsupported field')
  })

  it('rejects unsupported transports and protocol versions', () => {
    expect(() => parseInboundCommand(JSON.stringify({
      v: 2,
      type: 'cancel',
      request_id: 'request-1',
    }))).toThrow('unsupported protocol version')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'hello',
      mcp_servers: [{ name: 'legacy', transport: 'sse', url: 'https://example.test/sse' }],
    }))).toThrow('stdio or streamable-http')
  })
})

describe('wire helpers', () => {
  it('normalizes MCP names deterministically', () => {
    expect(normalizeMcpServerName('already_valid')).toBe('already_valid')
    expect(normalizeMcpServerName('My GitHub MCP!')).toMatch(/^My_GitHub_MCP_[0-9a-f]{8}$/)
    expect(normalizeMcpServerName('My GitHub MCP!')).toBe(normalizeMcpServerName('My GitHub MCP!'))
  })

  it('truncates output on a UTF-8 boundary', () => {
    const result = truncateUtf8('你好世界', 7)
    expect(result.truncated).toBe(true)
    expect(result.value).toBe('你好\n[output truncated]')
  })

  it('encodes exactly one JSON line', () => {
    const line = encodeFrame({
      v: 1,
      type: 'protocol_error',
      code: 'BAD_INPUT',
      message: 'bad input',
    })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
  })
})
