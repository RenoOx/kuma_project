export interface OwnerContext {
  businessId: string
  conversationId: string
  ownerName: string
  currentDate: string // YYYY-MM-DD in business timezone
  currentDayOfWeek: string // localized day name, eg "martes"
  businessTimezone: string
}

export interface OwnerToolExecutionResult {
  result: string
  error?: string
}

export interface OwnerReply {
  content: string
  tokensInput: number
  tokensOutput: number
  toolsExecuted: string[]
  maxIterationsHit: boolean
}
