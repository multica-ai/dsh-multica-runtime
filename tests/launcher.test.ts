import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const repository = fileURLToPath(new URL('..', import.meta.url))
const launcher = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
const home = mkdtempSync(join(tmpdir(), 'dsh-multica-runtime-test-'))
const profile = join(home, 'profiles', 'multica')
const bundleLink = join(profile, 'node_modules', '@multica-ai', 'dsh-runtime')

beforeAll(() => {
  mkdirSync(dirname(bundleLink), { recursive: true })
  symlinkSync(repository, bundleLink, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'multica-runtime-test', private: true,
    dependencies: { '@multica-ai/dsh-runtime': `link:${repository}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@multica-ai/dsh-runtime'] } },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), `
- id: llm-pi-ai
  config:
    providers:
      runtime-fixture:
        displayName: Runtime fixture
        apiKeyEnv: MULTICA_RUNTIME_TEST_API_KEY
        api: openai-completions
        baseURL: https://example.invalid/v1
        models:
          - id: fixture-model
            name: Fixture model
            input: [text, image]
            reasoningEfforts:
              off: null
              low: low
              high: high
- id: agent-default-model
  config:
    provider: runtime-fixture
    model: fixture-model
`)
})

afterAll(() => {
  const resolved = realpathSync(home)
  if (!resolved.startsWith(realpathSync(tmpdir()) + sep) ||
      !basename(resolved).startsWith('dsh-multica-runtime-test-')) {
    throw new Error('refusing to remove a directory outside the test temp root')
  }
  unlinkSync(bundleLink)
  rmSync(home, { recursive: true, force: true })
})

async function run(mode: string, input = '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) && !/^(DSH_|MULTICA_)/.test(key)))
  const child = spawn(process.execPath, [launcher, '--profile', 'multica', mode], {
    cwd: home, windowsHide: true,
    env: { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
      MULTICA_DSH_SESSION_ROOT: join(home, 'sessions'), MULTICA_RUNTIME_TEST_API_KEY: 'test-only' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdin.end(input)
  const timeout = setTimeout(() => child.kill(), 30_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const frames = stdout.trim().split(/\r?\n/).filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    return { code, stderr, frames }
  } finally {
    clearTimeout(timeout)
  }
}

describe('DSH 0.2.1 launcher compatibility', () => {
  it('loads the bundle without an incompatible-version exemption', async () => {
    const result = await run('--probe')
    expect(result.code).toBe(0)
    expect(result.stderr).not.toMatch(/incompatible|skipping profile bundle|patch: entry .* not found/)
    expect(result.frames).toEqual([expect.objectContaining({
      v: 1, type: 'probe', runtime: 'dsh', protocol_version: 1,
    })])
  }, 35_000)

  it('discovers the configured default model and its reasoning levels', async () => {
    const result = await run('--list-models')
    expect(result.code).toBe(0)
    expect(result.frames).toContainEqual(expect.objectContaining({
      type: 'models', models: expect.arrayContaining([expect.objectContaining({
        id: 'runtime-fixture/fixture-model', label: 'Fixture model', default: true,
        thinking: expect.objectContaining({ supported_levels: expect.arrayContaining([
          expect.objectContaining({ value: 'off' }), expect.objectContaining({ value: 'high' }),
        ]) }),
      })]),
    }))
  }, 35_000)

  it('advertises stdio capabilities and rejects an invalid command without a model request', async () => {
    const result = await run('--stdio', '{"v":1,"type":"invalid"}\n')
    expect(result.code).toBe(1)
    expect(result.frames).toContainEqual(expect.objectContaining({
      type: 'ready', capabilities: expect.objectContaining({ resume: true, cancel: true, tools: true }),
    }))
    expect(result.frames).toContainEqual(expect.objectContaining({
      type: 'protocol_error', code: 'INVALID_COMMAND',
    }))
  }, 35_000)
})
