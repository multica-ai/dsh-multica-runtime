import type { Config } from '@deepseek-ai/dsh-mcp-client'
import type { Context } from '@deepseek-ai/cordis'
import { normalizeMcpServerName, type McpServerInput } from './protocol.js'

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * Forwards MCP warnings to the headless runtime's diagnostic stream.
 * @param context Agent context owning the exporter's lifetime.
 * @param report Callback writing diagnostics without contaminating JSONL stdout.
 * @returns Nothing; context disposal removes the exporter.
 */
export function installMcpDiagnostics(context: Context, report: (message: string) => void): void {
  context.logger.exporter({
    export(message) {
      if (message.type !== 'warn' && message.type !== 'error') return
      const rendered = message.args.map((value: unknown) => String(value)).join(' ')
      if (rendered.startsWith('mcp-client(')) report(rendered)
    },
  })
}

/**
 * Maps a Multica MCP server into the DSH client configuration.
 * @param server Canonical task-scoped server configuration.
 * @param taskCwd Working directory used when stdio has no explicit directory.
 * @returns Transport settings that retain connection diagnostics.
 */
export function mcpConfig(server: McpServerInput, taskCwd: string): Config {
  const common = {
    serverName: normalizeMcpServerName(server.name),
    toolCallTimeoutMs: server.tool_call_timeout_ms ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    // MCP is an auxiliary capability; the client logs startup failures and
    // manages reconnection without rejecting the agent's activation.
    failOnStartupError: false,
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
