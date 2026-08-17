import { describe, expect, it } from 'vitest'
import { runAcceptanceCheck, runAcceptanceChecks } from '../src/acceptance.js'

describe('runAcceptanceCheck', () => {
  it('reports a successful command as passed', async () => {
    const result = await runAcceptanceCheck('exit 0', process.cwd())
    expect(result.passed).toBe(true)
    expect(result.exit_code).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('reports a failing command with its exit code', async () => {
    const result = await runAcceptanceCheck('echo nope && exit 3', process.cwd())
    expect(result.passed).toBe(false)
    expect(result.exit_code).toBe(3)
    expect(result.output).toContain('nope')
  })
})

describe('runAcceptanceChecks', () => {
  it('runs checks in order and invokes the callback per check', async () => {
    const seen: number[] = []
    const results = await runAcceptanceChecks(['exit 0', 'exit 0'], process.cwd(), (result, index) => {
      seen.push(index)
      expect(result.passed).toBe(true)
    })
    expect(results).toHaveLength(2)
    expect(seen).toEqual([0, 1])
  })
})
