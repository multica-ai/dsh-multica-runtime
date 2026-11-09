import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ExecuteCommand } from './protocol.js'

export async function resolveSelection(ctx: Context, command: ExecuteCommand): Promise<ModelSelection> {
  const defaultModel = ctx.get('agentDefaultModel')
  const llm = ctx.get('llm')
  if (defaultModel === undefined || llm === undefined) throw new Error('DSH model services are unavailable')
  const base: ModelSelection = command.model === undefined
    ? defaultModel.currentSelection()
    : { provider: command.model.provider, model: command.model.id }
  const info = await llm.resolveModelInfo(base.provider, base.model)
  const effort = command.reasoning_effort ?? command.model?.reasoning_effort ?? base.reasoningEffort
  if (effort !== undefined && !info.reasoning?.efforts.some(item => String(item.id) === effort)) {
    throw new Error(`reasoning effort ${effort} is not supported by ${base.provider}/${base.model}`)
  }
  return {
    provider: base.provider,
    model: base.model,
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }
}

export function selectRunModel(ctx: Context, agent: Agent, selection: ModelSelection): void {
  agent.model.select(selection)
  installModelSelection(ctx)
}
