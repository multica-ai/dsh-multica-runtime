import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { SENSITIVE_ENV_PATTERN, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { multicaTerminalEnvironment } from './task-env.js'

/** The one credential name Multica forwards through DSH's scrub. */
const TASK_TOKEN_KEY = 'MULTICA_TOKEN'

/** The slice of `@deepseek-ai/dsh-subprocess` this module patches and probes. */
interface ScrubModule {
  SENSITIVE_ENV_PATTERN: RegExp
  scrubbedParentEnv(): Record<string, string>
}

/** What {@link installMulticaTerminalEnvironment} actually achieved. */
export interface TerminalEnvironmentReport {
  /** How many distinct scrub instances now exempt the task token. */
  patched: number
  /** Whether the task token survives the scrub DSH is going to apply. */
  forwarded: boolean
}

/**
 * DSH deliberately removes credential-shaped ambient variables from every
 * model-spawned subprocess. Multica's task token is the one narrow exception:
 * its CLI requires the server-minted `mat_` credential to attribute agent
 * reads and writes to the current task. A user PAT or model-provider
 * credential must never pass through this path.
 */

/**
 * Exempt the exact task-token name from one scrub pattern. This is installed
 * at the scrub policy itself because agent-local PTY realms resolve the
 * subprocess service through a scoped proxy; decorating the host service does
 * not affect those already-composed realms. Every other `*TOKEN*`, `*KEY*`,
 * `*SECRET*`, and `*PASSWORD*` variable remains scrubbed.
 * @param pattern - the `SENSITIVE_ENV_PATTERN` of one loaded dsh-subprocess.
 * @returns a disposer restoring the untouched matcher.
 */
function exemptTaskToken(pattern: RegExp): () => void {
  const originalTest = pattern.test
  const patchedTest = function (this: RegExp, value: string): boolean {
    if (value.toUpperCase() === TASK_TOKEN_KEY) return false
    return originalTest.call(this, value)
  }
  pattern.test = patchedTest
  return () => {
    if (pattern.test === patchedTest) pattern.test = originalTest
  }
}

/**
 * Exempt the task token on every scrub instance supplied, deduplicated by
 * object identity.
 *
 * The plural matters. Patching a matcher only affects the module instance that
 * matcher belongs to, and a bridge loaded through a `link:` dependency resolves
 * its own copy of `@deepseek-ai/dsh-subprocess` rather than the copy the DSH
 * launcher loaded. Patching only the statically imported one left the real
 * scrub untouched, the token stripped, and every in-task `multica` command
 * refused for want of a `mat_` credential (MUL-6186). Nothing about that
 * failure was visible until an agent tried to use the CLI.
 * @param patterns - scrub matchers to exempt; duplicates are patched once.
 * @returns the instance count and a disposer restoring all of them.
 */
export function exemptTaskTokenOn(
  patterns: Iterable<RegExp>,
): { patched: number, dispose: () => void } {
  const disposers = [...new Set(patterns)].map(exemptTaskToken)
  return {
    patched: disposers.length,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

/**
 * Resolve the dsh-subprocess instance the DSH launcher itself loaded, so the
 * exemption reaches the scrub that actually runs no matter how this plugin was
 * installed.
 * @param entrypoint - the launcher script, normally `process.argv[1]`.
 * @returns the launcher's module, or undefined when it cannot be reached.
 */
async function hostScrubModule(entrypoint: string | undefined): Promise<ScrubModule | undefined> {
  if (entrypoint === undefined || entrypoint.trim() === '') return undefined
  try {
    // realpathSync is load-bearing: `dsh` is normally a bin symlink, Node
    // leaves argv[1] as the link, and a link in a bare bin directory resolves
    // no node_modules chain of its own.
    const specifier = createRequire(realpathSync(entrypoint)).resolve('@deepseek-ai/dsh-subprocess')
    return await import(pathToFileURL(specifier).href) as ScrubModule
  } catch {
    return undefined
  }
}

/**
 * Let the current task's `mat_` token — and nothing else — reach the shell
 * tools, on whichever dsh-subprocess instances are reachable from here.
 * @param ctx - the Cordis context whose disposal restores the scrub.
 * @param entrypoint - the launcher script to resolve DSH's own copy from.
 * @returns what was installed, or undefined when there is no task token to forward.
 */
export async function installMulticaTerminalEnvironment(
  ctx: Context,
  entrypoint: string | undefined = process.argv[1],
): Promise<TerminalEnvironmentReport | undefined> {
  const explicitEnvironment = multicaTerminalEnvironment(process.env)
  if (explicitEnvironment[TASK_TOKEN_KEY] === undefined) return undefined

  const host = await hostScrubModule(entrypoint)
  const { patched, dispose } = exemptTaskTokenOn(
    host === undefined
      ? [SENSITIVE_ENV_PATTERN]
      : [SENSITIVE_ENV_PATTERN, host.SENSITIVE_ENV_PATTERN],
  )
  ctx.effect(() => dispose, 'multica task environment forwarding')

  // Probe the scrub the shell tools will really call rather than trusting that
  // the patch landed. A silent miss here costs the whole task.
  const scrub = host?.scrubbedParentEnv ?? scrubbedParentEnv
  return { patched, forwarded: scrub()[TASK_TOKEN_KEY] !== undefined }
}

export { multicaTerminalEnvironment } from './task-env.js'
