export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GenerateReplyParams {
  businessId: string
  conversationId: string
  userMessage: string
}

export interface ExecutedToolCall {
  name: string
  args: unknown
  result: string
  error?: string
}

export interface LLMResponse {
  content: string
  tokensInput: number
  tokensOutput: number
  toolCallsExecuted: ExecutedToolCall[]
  // True if the final iteration ended with an escalation tool call. The handler
  // uses this to decide whether to keep responding in this conversation.
  escalated: boolean
  // True if we hit the safety net (MAX_TOOL_ITERATIONS) without a final reply.
  maxIterationsHit: boolean
}
