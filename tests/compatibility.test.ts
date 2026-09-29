import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/index.js'
import { PLUGIN_VERSION } from '../src/version.js'

const root = resolve(import.meta.dirname, '..')

const dshPackages = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-user-approval',
]

const cordisPackages = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
]

// pnpm is the only package manager this repo uses, so pnpm-lock.yaml is the
// only lockfile name that could reappear here.
const lockfiles = ['pnpm-lock.yaml']

type Manifest = {
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as Manifest
}

describe('DSH dependency compatibility contract', () => {
  it('only gates plugin application on launcher arguments', () => {
    expect(inject).toEqual(['cmdlineArgs'])
  })

  // The DSH package family must resolve as one in-step set: a caret range so
  // patch releases float in, identical in both sections so a local install and
  // a host install cannot drift apart, and converging on a single range so no
  // two DSH packages can be mixed across versions.
  it('keeps every DSH package on one caret range across both dependency sections', async () => {
    const manifest = await readManifest()
    const ranges = new Set<string>()

    for (const packageName of dshPackages) {
      const peer = manifest.peerDependencies[packageName]
      const dev = manifest.devDependencies[packageName]

      expect(peer, `${packageName} peer range`).toMatch(/^\^/)
      expect(dev, `${packageName} dev range`).toBe(peer)
      ranges.add(peer)
    }

    expect([...ranges], 'DSH packages share one version range').toHaveLength(1)
  })

  it('keeps the Cordis runtime on caret ranges in both dependency sections', async () => {
    const manifest = await readManifest()

    for (const packageName of cordisPackages) {
      const peer = manifest.peerDependencies[packageName]
      expect(peer, `${packageName} peer range`).toMatch(/^\^/)
      expect(manifest.devDependencies[packageName], `${packageName} dev range`).toBe(peer)
    }
  })

  // Dependency locking is deliberately dropped: the runtime tracks the current
  // DSH release channel instead of a pinned resolution. pnpm regenerates a
  // lockfile on every install, so the guarantee is that it is ignored and never
  // committed — not that it is absent from the working tree.
  it('ignores every lockfile so no resolution is ever committed', async () => {
    const ignored = (await readFile(resolve(root, '.gitignore'), 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))

    for (const name of lockfiles) expect(ignored, `${name} is ignored`).toContain(name)
  })

  it('disables the renamed session telemetry plugin without changing other plugin ids', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: session-telemetry-otel\n  disabled: true')
    expect(patch).not.toMatch(/^- id: telemetry-otel$/m)
    for (const id of ['hmr', 'session-persistence-jsonl', 'system-prompt', 'headless-runner']) {
      expect(patch).toContain(id)
    }
  })

  it('reports the plugin version on the probe protocol frame', () => {
    const output: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error) => void) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      callback?.()
      return true
    }) as typeof process.stdout.write)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit)
    const appExit = vi.fn()
    const context = {
      get(key: string) {
        if (key === 'cmdlineArgs') return { get: () => ['--probe'] }
        if (key === 'appExit') return appExit
        return undefined
      },
    } as unknown as Context

    apply(context)

    expect(JSON.parse(output.join(''))).toMatchObject({
      type: 'probe',
      protocol_version: 1,
      plugin_version: PLUGIN_VERSION,
    })
    expect(exit).toHaveBeenCalledWith(0)
    expect(appExit).not.toHaveBeenCalled()
  })

  it('does not await the loader before returning the probe frame', () => {
    const output: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error) => void) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      callback?.()
      return true
    }) as typeof process.stdout.write)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit)
    const appExit = vi.fn()
    const loaderAwait = vi.fn(() => new Promise<void>(() => {}))
    const context = {
      get(key: string) {
        if (key === 'cmdlineArgs') return { get: () => ['--probe'] }
        if (key === 'loader') return { await: loaderAwait }
        if (key === 'appExit') return appExit
        return undefined
      },
    } as unknown as Context

    apply(context)

    expect(loaderAwait).not.toHaveBeenCalled()
    expect(JSON.parse(output.join(''))).toMatchObject({ type: 'probe', protocol_version: 1 })
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('awaits the loader before listing models', async () => {
    const output: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write)
    const appExit = vi.fn()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit)
    let releaseLoader: (() => void) | undefined
    const loaderAwait = vi.fn(() => new Promise<void>((resolve) => {
      releaseLoader = resolve
    }))
    const context = {
      get(key: string) {
        if (key === 'cmdlineArgs') return { get: () => ['--list-models'] }
        if (key === 'loader') return { await: loaderAwait }
        if (key === 'appExit') return appExit
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'model' }) }
        if (key === 'llm') {
          return {
            listProviders: () => [{ id: 'test', name: 'Test' }],
            listModels: async () => [{ id: 'model', name: 'Model' }],
            resolveModelInfo: async () => ({}),
          }
        }
        return undefined
      },
    } as unknown as Context

    // 预热 runtime 模块缓存：apply() 内部会动态 import('./runtime.js') 并拉起
    // 一整套 DSH 重依赖，冷加载在慢机器上可能超过 vi.waitFor 的默认 1s 超时。
    await import('../src/runtime.js')
    apply(context)
    await vi.waitFor(() => expect(loaderAwait).toHaveBeenCalledOnce())
    expect(exit).not.toHaveBeenCalled()

    releaseLoader?.()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(JSON.parse(output.join(''))).toMatchObject({
      type: 'models',
      models: [{ id: 'test/model', label: 'Model', provider: 'Test', default: true }],
    })
    write.mockRestore()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
