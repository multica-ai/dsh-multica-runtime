import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('Linux and macOS installation guide', () => {
  it('documents the supported single-machine multica profile workflow', async () => {
    const guide = await readFile(resolve(root, 'docs/install-agent-runtime.md'), 'utf8')

    for (const required of [
      '^22.19.0 || >=24.0.0',
      'npm install --global @deepseek-ai/dsh@latest',
      'corepack enable pnpm',
      'pnpm install',
      'pnpm check',
      'dsh plugin --profile multica add',
      'DEEPSEEK_API_KEY',
      'dsh --profile multica --probe',
      'dsh --profile multica --list-models',
      'multica daemon restart',
      'multica daemon status --output json',
      'DSH_HOME',
      '~/.dsh',
    ]) {
      expect(guide).toContain(required)
    }

    // No lockfile is committed, so the guide must not ask for a frozen install.
    expect(guide).not.toContain('frozen-lockfile')

    expect(guide).toMatch(/Linux/i)
    expect(guide).toMatch(/macOS/i)
    expect(guide).toMatch(/npm (?:prefix|config get prefix)/)
    expect(guide).toMatch(/PATH/)
    expect(guide).toMatch(/sudo/)
    expect(guide).toMatch(/protocol_version[^\n]*1/)
  })

  it('links the guide from the README', async () => {
    const readme = await readFile(resolve(root, 'README.md'), 'utf8')

    expect(readme).toContain('[Linux/macOS installation guide](docs/install-agent-runtime.md)')
  })
})
