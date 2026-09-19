import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { SENSITIVE_ENV_PATTERN, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { forwardedEnvironmentNames } from './task-env.js'

/** The slice of `@deepseek-ai/dsh-subprocess` this module patches and probes. */
interface ScrubModule {
  SENSITIVE_ENV_PATTERN: RegExp
  scrubbedParentEnv(): Record<string, string>
}

/** What {@link installMulticaTerminalEnvironment} actually achieved. */
export interface TerminalEnvironmentReport {
  /** How many distinct scrub instances were patched. */
  patched: number
  /** Whether every forwarded name survives the scrub DSH is going to apply. */
  forwarded: boolean
  /** The environment names this install exempted from the scrub. */
  names: readonly string[]
}

/**
 * DSH deliberately removes credential-shaped ambient variables from every
 * model-spawned subprocess. Multica forwards a narrow, explicitly-authorized
 * set through that scrub: the server-minted `mat_` task token, plus any names
 * an agent lists in `FORWARD_ENV_NAMES` (for example a third-party skill
 * credential such as `WEKNORA_API_KEY`). A user PAT or model-provider
 * credential must never pass through this path.
 */

/**
 * Exempt a set of environment names from one scrub pattern. This is installed
 * at the scrub policy itself because agent-local PTY realms resolve the
 * subprocess service through a scoped proxy; decorating the host service does
 * not affect those already-composed realms. Every non-exempt `*TOKEN*`,
 * `*KEY*`, `*SECRET*`, and `*PASSWORD*` name remains scrubbed.
 *
 * One patch per pattern is load-bearing: stacking one patch per name would
 * chain the matchers, so a later disposer could not restore the original
 * matcher once an earlier name's patch had been unwound.
 * @param pattern - the `SENSITIVE_ENV_PATTERN` of one loaded dsh-subprocess.
 * @param names - environment names to exempt (case-insensitive).
 * @returns a disposer restoring the untouched matcher.
 */
function exemptEnvNames(pattern: RegExp, names: readonly string[]): () => void {
  const exempt = new Set(names.map(name => name.toUpperCase()))
  const originalTest = pattern.test
  const patchedTest = function (this: RegExp, value: string): boolean {
    if (exempt.has(value.toUpperCase())) return false
    return originalTest.call(this, value)
  }
  pattern.test = patchedTest
  return () => {
    if (pattern.test === patchedTest) pattern.test = originalTest
  }
}

/**
 * Exempt each supplied name on every scrub instance supplied, deduplicated by
 * object identity and name.
 *
 * The plural matters. Patching a matcher only affects the module instance that
 * matcher belongs to, and a bridge loaded through a `link:` dependency resolves
 * its own copy of `@deepseek-ai/dsh-subprocess` rather than the copy the DSH
 * launcher loaded. Patching only the statically imported one left the real
 * scrub untouched, the token stripped, and every in-task `multica` command
 * refused for want of a `mat_` credential (MUL-6186). Nothing about that
 * failure was visible until an agent tried to use the CLI.
 * @param patterns - scrub matchers to exempt; duplicates are patched once.
 * @param names - environment names to exempt; duplicates are patched once.
 * @returns the patch count and a disposer restoring all of them.
 */
export function exemptEnvNamesOn(
  patterns: Iterable<RegExp>,
  names: Iterable<string>,
): { patched: number, dispose: () => void } {
  const distinctNames = [...new Set(names)]
  const disposers: (() => void)[] = []
  for (const pattern of new Set(patterns)) {
    disposers.push(exemptEnvNames(pattern, distinctNames))
  }
  return {
    patched: disposers.length,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

/**
 * Single-name convenience for the task token, kept for backwards compatibility
 * with callers and tests that exercised the original narrow exemption.
 */
export function exemptTaskTokenOn(
  patterns: Iterable<RegExp>,
): { patched: number, dispose: () => void } {
  return exemptEnvNamesOn(patterns, ['MULTICA_TOKEN'])
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
 * Let the explicitly-authorized Multica terminal environment — and nothing
 * else — reach the shell tools, on whichever dsh-subprocess instances are
 * reachable from here.
 * @param ctx - the Cordis context whose disposal restores the scrub.
 * @param entrypoint - the launcher script to resolve DSH's own copy from.
 * @returns what was installed, or undefined when there is nothing to forward.
 */
export async function installMulticaTerminalEnvironment(
  ctx: Context,
  entrypoint: string | undefined = process.argv[1],
): Promise<TerminalEnvironmentReport | undefined> {
  const names = forwardedEnvironmentNames(process.env)
  if (names.length === 0) return undefined

  const host = await hostScrubModule(entrypoint)
  const { patched, dispose } = exemptEnvNamesOn(
    host === undefined
      ? [SENSITIVE_ENV_PATTERN]
      : [SENSITIVE_ENV_PATTERN, host.SENSITIVE_ENV_PATTERN],
    names,
  )
  ctx.effect(() => dispose, 'multica task environment forwarding')

  // Probe the scrub the shell tools will really call rather than trusting that
  // the patch landed. A silent miss here costs the whole task.
  const scrub = host?.scrubbedParentEnv ?? scrubbedParentEnv
  const scrubbed = scrub()
  const forwarded = names.every(name => scrubbed[name] !== undefined)
  return { patched, forwarded, names }
}

export { multicaTerminalEnvironment, TASK_TOKEN_KEY, FORWARD_ENV_KEYS_KEY } from './task-env.js'
