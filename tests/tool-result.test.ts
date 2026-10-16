import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { MAX_TOOL_OUTPUT_BYTES } from '../src/protocol.js'
import { toolResultFrame } from '../src/tool-result.js'

describe('DSH 0.2 tool result forwarding', () => {
  it('reads all result blocks and the call id from the message envelope', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'first\n' }, { type: 'text', text: 'second' }], isError: false,
    })
    expect(toolResultFrame('request-1', message, new Map([['call-1', 'pwsh']]))).toEqual({
      v: 1, type: 'tool_result', request_id: 'request-1', call_id: 'call-1',
      name: 'pwsh', output: 'first\nsecond', is_error: false,
    })
  })

  it('preserves error status and accepts an empty result', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('call-2'),
      content: [], isError: true,
    })
    expect(toolResultFrame('request-2', message, new Map())).toMatchObject({
      call_id: 'call-2', name: 'unknown', output: '', is_error: true,
    })
  })

  it('limits large tool output while preserving UTF-8', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('call-3'),
      content: [{ type: 'text', text: '你'.repeat(MAX_TOOL_OUTPUT_BYTES) }], isError: false,
    })
    const frame = toolResultFrame('request-3', message, new Map())
    expect(frame.truncated).toBe(true)
    expect(frame.output).not.toContain('\uFFFD')
    expect(Buffer.byteLength(frame.output)).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 30)
  })
})
