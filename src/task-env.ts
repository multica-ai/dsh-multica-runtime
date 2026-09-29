/** The one credential name Multica always forwards through DSH's scrub. */
export const TASK_TOKEN_KEY = 'MULTICA_TOKEN'

/**
 * Comma-separated variable names an agent has explicitly configured for shell
 * access. Each listed name is exempted from DSH's credential scrub, exactly
 * like {@link TASK_TOKEN_KEY}. List only variables the agent genuinely needs
 * (for example a third-party skill credential such as `WEKNORA_API_KEY`);
 * never list model-provider credentials (`DEEPSEEK_API_KEY` and friends).
 */
export const FORWARD_ENV_KEYS_KEY = 'FORWARD_ENV_NAMES'

/**
 * The one credential DSH child tools may receive from Multica, unchanged from
 * the original single-token contract: a server-minted `mat_` task token.
 */
export function multicaTerminalEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const token = environment[TASK_TOKEN_KEY]
  return token?.startsWith('mat_') === true && token.length > 4
    ? { [TASK_TOKEN_KEY]: token }
    : {}
}

/**
 * Environment names the runtime must exempt from DSH's credential scrub.
 * Combines the task-scoped `mat_` token with any names listed in
 * `FORWARD_ENV_NAMES`, trimmed and deduplicated.
 */
export function forwardedEnvironmentNames(
  environment: NodeJS.ProcessEnv,
): string[] {
  const names = new Set<string>()
  const token = environment[TASK_TOKEN_KEY]
  if (token?.startsWith('mat_') === true && token.length > 4) names.add(TASK_TOKEN_KEY)
  const list = environment[FORWARD_ENV_KEYS_KEY]
  if (list !== undefined) {
    for (const item of list.split(',')) {
      const name = item.trim()
      if (name !== '') names.add(name)
    }
  }
  return [...names]
}
