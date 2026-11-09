import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { resolveSelection, selectRunModel } from '../src/model-selection.js'
import type { ExecuteCommand } from '../src/protocol.js'

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string) {
    return {
      id: model, name: model, provider,
      reasoning: {
        efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('low'),
      },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const command: ExecuteCommand = {
  v: 1, type: 'execute', request_id: 'selection', cwd: process.cwd(), prompt: 'hello', mcp_servers: [],
}

async function turn(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
}

it('selects before real step preparation on create, multiple turns, resume and route changes', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const events: SessionEvent[] = []
    let header: SessionHeader
    const storageHandle = () => ({
      get id() { return header.id },
      get header() { return header },
      inheritedEventCount: SessionLogOffset(0),
      access: 'write',
      read: async () => ({ events: structuredClone(events), eventState: 'detached' }),
      append: async (batch: readonly SessionEvent[]) => { events.push(...structuredClone(batch)) },
      flush: async () => {}, close: async () => {}, [Symbol.asyncDispose]: async () => {},
    })
    ctx.provide('sessionPersistence', {
      identity: Symbol(),
      create: async (meta: SessionHeader) => { header = meta; return storageHandle() },
      open: async () => storageHandle(),
    })
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['test', 'other'], adapter)
    await mountAgentLoopTestHarness(ctx)
    const initial = { provider: 'test', model: 'model', reasoningEffort: ReasoningEffortId('high') }
    const setup = (selection: ModelSelection) => (child: Context, agent: Agent) => selectRunModel(child, agent, selection)
    let handle = await ctx.agents.create({ sessionId: SessionId('selection'), agentOptions: initial, setup: setup(initial) })
    await turn(handle.agent)
    await turn(handle.agent)
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()

    // Restored selection wins over AgentOptions unless setup records the new choice.
    const resumed = { provider: 'other', model: 'switched' }
    handle = await ctx.agents.resume({ resumeSessionId: SessionId('selection'), agentOptions: resumed, setup: setup(resumed) })
    await turn(handle.agent)
    await turn(handle.agent)
    expect(adapter.requests.map(r => [r.provider, r.model, r.reasoningEffort])).toEqual([
      ['test', 'model', 'high'], ['test', 'model', 'high'],
      ['other', 'switched', 'low'], ['other', 'switched', 'low'],
    ])
    expect(handle.agent.model.current()).toEqual(resumed)
    expect(handle.agent.session.snapshotEvents().filter(e => e.type === 'model/selection').map(e => e.data).at(-1)).toEqual(resumed)
    await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('honors profile effort, explicit overrides and adapter defaults, and rejects unsupported effort', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['test'], new Adapter())
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'model', reasoningEffort: ReasoningEffortId('high') }),
    } as Context['agentDefaultModel'])
    expect(await resolveSelection(ctx, command)).toEqual({ provider: 'test', model: 'model', reasoningEffort: 'high' })
    expect(await resolveSelection(ctx, { ...command, reasoning_effort: 'low' })).toEqual({ provider: 'test', model: 'model', reasoningEffort: 'low' })
    const model = { provider: 'test', id: 'another' }
    expect(await resolveSelection(ctx, { ...command, model })).toEqual({ provider: 'test', model: 'another' })
    expect(await resolveSelection(ctx, { ...command, model: { ...model, reasoning_effort: 'low' }, reasoning_effort: 'high' })).toEqual({ provider: 'test', model: 'another', reasoningEffort: 'high' })
    await expect(resolveSelection(ctx, { ...command, reasoning_effort: 'invalid' })).rejects.toThrow('not supported')
  } finally {
    await ctx.fiber.dispose()
  }
})
