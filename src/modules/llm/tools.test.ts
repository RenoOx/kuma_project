import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions.js'
import { describe, expect, it } from 'vitest'
import { executeTool } from './toolExecutor.js'
import { kumaTools } from './tools.js'

// ChatCompletionTool is a union (function | custom) in the SDK, so the lookup
// has to narrow before it can read `.function`.
function toolNamed(name: string): ChatCompletionFunctionTool {
  const tool = kumaTools.find((t) => t.type === 'function' && t.function.name === name)
  if (!tool || tool.type !== 'function') throw new Error(`tool ${name} is not registered`)
  return tool
}

describe('kuma tool definitions', () => {
  it('book_appointment requires customer_name', () => {
    // The push name WhatsApp gives us is unusable as a patient name, so the
    // model has to collect a real one before it can file anything. Marking the
    // field required is what stops it from skipping the question.
    const params = toolNamed('book_appointment').function.parameters as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(params.properties).toHaveProperty('customer_name')
    expect(params.required).toContain('customer_name')
    expect(params.required).toEqual(
      expect.arrayContaining(['datetime_iso', 'service', 'customer_name']),
    )
  })
})

describe('book_appointment name guard', () => {
  // No DB is touched: the guard returns before the service is ever called.
  const context = { businessId: 'b1', conversationId: 'c1', customerId: 'cu1' }

  const args = (customerName: string) => ({
    datetime_iso: '2027-07-05T10:00:00-05:00',
    service: 'corte',
    customer_name: customerName,
  })

  it.each([
    '.',
    '-',
    '💕',
    'J',
    '  ',
  ])('rejects %j and tells the model to ask for the name', async (placeholder) => {
    const result = await executeTool('book_appointment', args(placeholder), context)

    expect(result.error).toBe('missing_customer_name')
    const payload = JSON.parse(result.result) as { error: string; instruction: string }
    expect(payload.error).toBe('missing_customer_name')
    expect(payload.instruction).toContain('nombre')
  })

  it('lets a real name through to the service', async () => {
    // Reaching the service means the guard passed. The booking itself fails
    // (this business id does not exist), which is exactly the boundary we want
    // to assert: not a name error.
    const result = await executeTool('book_appointment', args('Juan Pérez'), context)
    expect(result.error).not.toBe('missing_customer_name')
  })
})
