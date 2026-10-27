import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { toolResultFrame } from '../src/session-frames.js'

describe('tool-result messages', () => {
  it.each([false, true])('preserves the committed result with isError=%s', (isError: boolean) => {
    const message = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'DSH_TOOL_SMOKE_OK' }],
      isError,
    })

    expect(toolResultFrame('request-1', message, 'bash')).toEqual({
      v: 1,
      type: 'tool_result',
      request_id: 'request-1',
      call_id: 'call-1',
      name: 'bash',
      output: 'DSH_TOOL_SMOKE_OK',
      is_error: isError,
    })
  })

  it('omits developer tool bookkeeping from tool output', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('call-2'),
      isError: false,
      content: [
        { type: 'tool-addition', toolName: 'bash' },
        { type: 'text', text: 'command output' },
        { type: 'tool-removal', toolName: 'bash' },
      ],
    })

    expect(toolResultFrame('request-2', message, 'bash').output).toBe('command output')
  })
})
