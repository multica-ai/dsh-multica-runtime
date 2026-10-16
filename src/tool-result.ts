import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { PROTOCOL_VERSION, truncateUtf8, type OutboundFrame } from './protocol.js'

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'image':
    case 'file':
      return `[${block.type} attachment ${block.attachment.attachmentId}]`
    case 'tool-call':
      return `[tool call ${block.name}: ${block.arguments}]`
    default:
      return JSON.stringify(block)
  }
}

export function toolResultFrame(
  requestId: string,
  message: ToolResultMessage,
  toolNames: ReadonlyMap<string, string>,
): Extract<OutboundFrame, { type: 'tool_result' }> {
  // DSH 0.2 puts the call id and error status on the message, and the
  // result blocks directly in message.content.
  const callId = String(message.toolCallId)
  const rendered = truncateUtf8(message.content.map(renderBlock).join(''))
  return {
    v: PROTOCOL_VERSION,
    type: 'tool_result',
    request_id: requestId,
    call_id: callId,
    name: toolNames.get(callId) ?? 'unknown',
    output: rendered.value,
    is_error: message.isError === true,
    ...rendered.truncated ? { truncated: true } : {},
  }
}
