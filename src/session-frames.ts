import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { PROTOCOL_VERSION, truncateUtf8, type OutboundFrame } from './protocol.js'

/**
 * Renders one typed content block for Multica's text tool-result surface.
 * @param block A block committed in a DSH tool message.
 * @returns Text preserving the block or identifying its non-text payload.
 */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'image':
      return `[image attachment ${block.attachment.attachmentId}]`
    case 'file':
      return `[file attachment ${block.attachment.name} (${block.attachment.attachmentId})]`
    case 'tool-call':
      return `[tool call ${block.name}: ${block.arguments}]`
    case 'tool-addition':
    case 'tool-removal':
      // Developer-message bookkeeping about the tool set, never tool output.
      return ''
    default:
      return JSON.stringify(block)
  }
}

/**
 * Converts DSH's tool-role message into the Multica JSONL result contract.
 * @param requestId Active Multica execution request.
 * @param message Committed DSH tool-role message with call identity and outcome.
 * @param toolName Name recorded from the corresponding tool-call event.
 * @returns A bounded result frame preserving the tool's failure status.
 */
export function toolResultFrame(
  requestId: string,
  message: ToolResultMessage,
  toolName: string,
): Extract<OutboundFrame, { type: 'tool_result' }> {
  const rendered = truncateUtf8(message.content.map(renderBlock).join(''))
  return {
    v: PROTOCOL_VERSION,
    type: 'tool_result',
    request_id: requestId,
    call_id: String(message.toolCallId),
    name: toolName,
    output: rendered.value,
    is_error: message.isError === true,
    ...rendered.truncated ? { truncated: true } : {},
  }
}
