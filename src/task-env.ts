const TASK_TOKEN_KEY = 'MULTICA_TOKEN'
export const TASK_ISSUE_ID_KEY = 'MULTICA_ISSUE_ID'

/**
 * Return the task identity Multica may expose to DSH child tools.
 *
 * The token is the only credential passed through: it must be server-minted
 * (`mat_`) and never a user PAT. The issue id is not a credential, but is
 * still gated to a non-empty value so an absent id leaves the environment
 * untouched rather than exporting `MULTICA_ISSUE_ID=undefined`.
 */
export function multicaTerminalEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {}
  const token = environment[TASK_TOKEN_KEY]
  if (token?.startsWith('mat_') === true && token.length > 4) {
    result[TASK_TOKEN_KEY] = token
  }
  const issueId = environment[TASK_ISSUE_ID_KEY]
  if (issueId !== undefined && issueId.trim() !== '') {
    result[TASK_ISSUE_ID_KEY] = issueId
  }
  return result
}
