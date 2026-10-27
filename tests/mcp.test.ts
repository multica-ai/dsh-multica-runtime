import { once } from 'node:events'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '@deepseek-ai/dsh-mcp-client'
import { describe, expect, it } from 'vitest'
import { installMcpDiagnostics, mcpConfig } from '../src/mcp.js'

describe('task MCP startup', () => {
  it('keeps authentication failures visible without rejecting task startup', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401)
      response.end('Authentication required')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const context = new Context()
    const diagnostics: string[] = []
    installMcpDiagnostics(context, message => diagnostics.push(message))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('TCP listener is unavailable')
      const config = mcpConfig({
        name: 'Sentry',
        transport: 'streamable-http',
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: {},
      }, process.cwd())

      await expect(apply(context, { ...config, reconnect: { enabled: false } })).resolves.toBeUndefined()
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.stringMatching(/mcp-client\(Sentry\): connection failed/),
      ]))
    } finally {
      await context.fiber.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    }
  })
})
