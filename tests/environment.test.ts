import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { exemptTaskTokenOn, installMulticaTerminalEnvironment } from '../src/environment.js'

/** DSH's own credential-name matcher, cloned so a test never patches the real one. */
function scrubPattern(): RegExp {
  return /KEY|PASSWORD|SECRET|TOKEN/i
}

/** A Cordis stand-in that records effect disposers so a test can unwind them. */
function fakeContext(): { context: Context, disposers: (() => void)[], dispose: () => void } {
  const disposers: (() => void)[] = []
  const context = {
    effect(callback: () => () => void) {
      disposers.push(callback())
    },
  } as unknown as Context
  return {
    context,
    disposers,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('exemptTaskTokenOn', () => {
  it('exempts the task token on every distinct scrub instance', () => {
    const bridgeCopy = scrubPattern()
    const hostCopy = scrubPattern()

    const { patched, dispose } = exemptTaskTokenOn([bridgeCopy, hostCopy])

    // The MUL-6186 regression: patching one loaded copy of dsh-subprocess
    // leaves any other loaded copy — the one DSH actually spawns through —
    // still scrubbing the token.
    expect(patched).toBe(2)
    expect(bridgeCopy.test('MULTICA_TOKEN')).toBe(false)
    expect(hostCopy.test('MULTICA_TOKEN')).toBe(false)

    dispose()
    expect(bridgeCopy.test('MULTICA_TOKEN')).toBe(true)
    expect(hostCopy.test('MULTICA_TOKEN')).toBe(true)
  })

  it('patches a repeated instance once', () => {
    const pattern = scrubPattern()

    const { patched, dispose } = exemptTaskTokenOn([pattern, pattern])
    dispose()

    expect(patched).toBe(1)
    expect(pattern.test('MULTICA_TOKEN')).toBe(true)
  })

  it('keeps every other credential-shaped name scrubbed', () => {
    const pattern = scrubPattern()

    const { dispose } = exemptTaskTokenOn([pattern])

    expect(pattern.test('DEEPSEEK_API_KEY')).toBe(true)
    expect(pattern.test('MULTICA_USER_TOKEN')).toBe(true)
    expect(pattern.test('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(pattern.test('DB_PASSWORD')).toBe(true)
    expect(pattern.test('PATH')).toBe(false)
    dispose()
  })
})

describe('installMulticaTerminalEnvironment', () => {
  it('forwards the task token through the scrub the shell tools call', async () => {
    vi.stubEnv('MULTICA_TOKEN', 'mat_task-token')
    vi.stubEnv('DEEPSEEK_API_KEY', 'provider-secret')
    const ctx = fakeContext()

    const report = await installMulticaTerminalEnvironment(ctx.context)

    expect(report?.forwarded).toBe(true)
    expect(report?.patched).toBeGreaterThanOrEqual(1)
    const env = scrubbedParentEnv()
    expect(env.MULTICA_TOKEN).toBe('mat_task-token')
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()

    ctx.dispose()
    expect(scrubbedParentEnv().MULTICA_TOKEN).toBeUndefined()
  })

  it('installs nothing when the token is not task-scoped', async () => {
    vi.stubEnv('MULTICA_TOKEN', 'mul_user-token')
    const ctx = fakeContext()

    await expect(installMulticaTerminalEnvironment(ctx.context)).resolves.toBeUndefined()

    expect(ctx.disposers).toHaveLength(0)
    expect(scrubbedParentEnv().MULTICA_TOKEN).toBeUndefined()
  })

  it('still exempts the imported scrub when the launcher cannot be resolved', async () => {
    vi.stubEnv('MULTICA_TOKEN', 'mat_task-token')
    const ctx = fakeContext()

    const report = await installMulticaTerminalEnvironment(ctx.context, '/nonexistent/dsh')

    expect(report).toEqual({ patched: 1, forwarded: true })
    ctx.dispose()
  })
})
