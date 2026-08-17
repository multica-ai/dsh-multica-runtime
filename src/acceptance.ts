import { spawn } from 'node:child_process'
import {
  MAX_TOOL_OUTPUT_BYTES,
  truncateUtf8,
  type AcceptanceCheckResult,
} from './protocol.js'

const ACCEPTANCE_CHECK_TIMEOUT_MS = 120_000
const ACCEPTANCE_SHELL = '/bin/sh'

function combineOutput(stdout: string, stderr: string): string {
  if (stderr === '') return stdout
  if (stdout === '') return stderr
  return `${stdout}\n${stderr}`
}

export function runAcceptanceCheck(command: string, cwd: string): Promise<AcceptanceCheckResult> {
  return new Promise(resolve => {
    const child = spawn(ACCEPTANCE_SHELL, ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, ACCEPTANCE_CHECK_TIMEOUT_MS)

    const finish = (result: AcceptanceCheckResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      const rendered = truncateUtf8(combineOutput(stdout, stderr), MAX_TOOL_OUTPUT_BYTES)
      finish({
        command,
        exit_code: -1,
        passed: false,
        output: rendered.value,
        ...rendered.truncated ? { truncated: true } : {},
        error: { code: 'ACCEPTANCE_SPAWN_FAILED', message: error.message },
      })
    })
    child.on('close', code => {
      const rendered = truncateUtf8(combineOutput(stdout, stderr), MAX_TOOL_OUTPUT_BYTES)
      if (timedOut) {
        finish({
          command,
          exit_code: code ?? -1,
          passed: false,
          output: rendered.value,
          ...rendered.truncated ? { truncated: true } : {},
          error: { code: 'ACCEPTANCE_TIMEOUT', message: 'acceptance check exceeded the timeout' },
        })
        return
      }
      finish({
        command,
        exit_code: code ?? -1,
        passed: code === 0,
        output: rendered.value,
        ...rendered.truncated ? { truncated: true } : {},
      })
    })
  })
}

export async function runAcceptanceChecks(
  commands: readonly string[],
  cwd: string,
  onCheck?: (result: AcceptanceCheckResult, index: number) => void,
): Promise<AcceptanceCheckResult[]> {
  const results: AcceptanceCheckResult[] = []
  for (const [index, command] of commands.entries()) {
    const result = await runAcceptanceCheck(command, cwd)
    results.push(result)
    onCheck?.(result, index)
  }
  return results
}
