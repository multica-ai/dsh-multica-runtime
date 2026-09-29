import type { Context } from '@deepseek-ai/cordis'
import {
  encodeFrame,
  PROTOCOL_VERSION,
} from './protocol.js'
import { PLUGIN_VERSION } from './version.js'

export const name = 'multica-dsh-runtime'

// Probe must be able to run before the full DSH runtime graph is imported.
// Non-probe modes load the runtime lazily and wait for the loader there.
export const inject = ['cmdlineArgs']

function writeDiagnostic(message: string): void {
  process.stderr.write(`multica-dsh-runtime: ${message}\n`)
}

function parseMode(args: readonly string[]): 'stdio' | 'probe' | 'list-models' {
  if (args.length !== 1) {
    throw new Error('expected exactly one mode: --stdio, --probe, or --list-models')
  }
  switch (args[0]) {
    case '--stdio': return 'stdio'
    case '--probe': return 'probe'
    case '--list-models': return 'list-models'
    default: throw new Error(`unsupported mode: ${String(args[0])}`)
  }
}

export function apply(ctx: Context): void {
  try {
    const appExit = ctx.get('appExit')
    const cmdlineArgs = ctx.get('cmdlineArgs')
    if (appExit === undefined || cmdlineArgs === undefined) {
      throw new Error('the DSH launcher did not provide cmdlineArgs/appExit')
    }
    const mode = parseMode(cmdlineArgs.get())
    if (mode === 'probe') {
      const frame = encodeFrame({
        v: PROTOCOL_VERSION,
        type: 'probe',
        runtime: 'dsh',
        plugin_version: PLUGIN_VERSION,
        protocol_version: PROTOCOL_VERSION,
      })
      // Probe is a one-shot: nothing is mounted, so a direct exit is safe. Going
      // through ctx.appExit here would route into the launcher's graceful
      // shutdown, which only sets process.exitCode after disposing the tree and
      // otherwise leaves the process alive until its 5 s
      // PROCESS_SHUTDOWN_TIMEOUT_MS fallback force-exits it — a fixed stall on
      // every probe.
      process.stdout.write(frame, () => process.exit(0))
      return
    }
    void import('./runtime.js').then(({ run }) => run(ctx)).catch((error: unknown) => {
      writeDiagnostic(error instanceof Error ? error.message : String(error))
      appExit(1)
    })
  } catch (error: unknown) {
    writeDiagnostic(error instanceof Error ? error.message : String(error))
    ctx.get('appExit')?.(1)
  }
}

export * from './protocol.js'
export * from './environment.js'
