export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GenerateReplyParams {
  businessId: string
  conversationId: string
  userMessage: string
}

export interface LLMResponse {
  content: string
  tokensInput: number
  tokensOutput: number
}
