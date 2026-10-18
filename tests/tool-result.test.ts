import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { toolResultPayload } from '../src/index.js'

describe('toolResultPayload', () => {
  it('reads the tool-role result message fields DSH 0.2.1 emits', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      isError: false,
    })

    expect(toolResultPayload(message, new Map([['call-1', 'bash']]))).toEqual({
      call_id: 'call-1',
      name: 'bash',
      output: 'line oneline two',
      is_error: false,
    })
  })

  it('keeps an unknown tool name and the error flag', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('call-2'),
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    })

    expect(toolResultPayload(message, new Map())).toEqual({
      call_id: 'call-2',
      name: 'unknown',
      output: 'boom',
      is_error: true,
    })
  })
})
