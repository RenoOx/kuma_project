export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GenerateReplyParams {
  businessId: string
  conversationId: string
  userMessage: string
  // Conversation state this reply starts from — it decides which tools the
  // model is offered and what the step adds to the system prompt.
  // Optional: when the caller omits it, the service falls back to the value
  // stored on the conversation row, which it loads anyway.
  state?: string
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
