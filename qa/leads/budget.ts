import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// El contador de gasto de OpenAI del test masivo. Es GLOBAL entre corridas y
// etapas (simular, carga): vive en un archivo, así que el tope de $2.00 cubre
// todo el test y no cada comando por separado.
//
// Corta antes de llamar, no después: una vez que el gasto acumulado llega a
// STOP_AT_USD, la siguiente llamada se niega. Las llamadas que ya estaban en
// vuelo en ese momento terminan, así que el total puede pasarse por unos
// centavos — nunca por una corrida entera.

/** Precios de gpt-4o-mini por token (USD). */
export const PRICE = {
  input: 0.15 / 1_000_000,
  cachedInput: 0.075 / 1_000_000,
  output: 0.6 / 1_000_000,
}

export const BUDGET_USD = 2.0
export const STOP_AT_USD = 1.8

export type Caller = 'emma' | 'lead'

/** Quién está llamando: se propaga por async/await sin pasarlo a mano. */
export const callContext = new AsyncLocalStorage<{ caller: Caller; convKey: string }>()

interface Ledger {
  totalUsd: number
  calls: number
  byStage: Record<string, number>
  /** Contador de teléfonos de prueba: cada conversación es un cliente nuevo. */
  nextPhone: number
}

export interface Usage {
  calls: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  usd: number
}

export class BudgetExceededError extends Error {
  constructor(spent: number) {
    super(`Presupuesto de OpenAI agotado: $${spent.toFixed(4)} ≥ $${STOP_AT_USD}`)
    this.name = 'BudgetExceededError'
  }
}

function emptyUsage(): Usage {
  return { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, usd: 0 }
}

export class Budget {
  private ledger: Ledger
  private readonly perConversation = new Map<string, Record<Caller, Usage>>()
  private readonly stageUsage: Record<Caller, Usage> = { emma: emptyUsage(), lead: emptyUsage() }
  exceeded = false

  constructor(
    private readonly ledgerPath: string,
    private readonly stage: string,
  ) {
    this.ledger = existsSync(ledgerPath)
      ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger)
      : { totalUsd: 0, calls: 0, byStage: {}, nextPhone: 1 }
  }

  get totalUsd(): number {
    return this.ledger.totalUsd
  }

  /** Antes de cada llamada: si ya se llegó al corte, no se llama. */
  assertCanSpend(): void {
    if (this.ledger.totalUsd >= STOP_AT_USD) {
      this.exceeded = true
      throw new BudgetExceededError(this.ledger.totalUsd)
    }
  }

  record(
    caller: Caller,
    convKey: string,
    usage: { prompt_tokens?: number; completion_tokens?: number; cached?: number },
  ): void {
    const input = usage.prompt_tokens ?? 0
    const cached = usage.cached ?? 0
    const output = usage.completion_tokens ?? 0
    const usd = (input - cached) * PRICE.input + cached * PRICE.cachedInput + output * PRICE.output

    const add = (u: Usage): void => {
      u.calls++
      u.inputTokens += input
      u.cachedTokens += cached
      u.outputTokens += output
      u.usd += usd
    }
    add(this.stageUsage[caller])
    const conv = this.perConversation.get(convKey) ?? { emma: emptyUsage(), lead: emptyUsage() }
    add(conv[caller])
    this.perConversation.set(convKey, conv)

    this.ledger.totalUsd += usd
    this.ledger.calls++
    this.ledger.byStage[this.stage] = (this.ledger.byStage[this.stage] ?? 0) + usd
    this.save()
  }

  conversationUsage(convKey: string): Record<Caller, Usage> {
    return this.perConversation.get(convKey) ?? { emma: emptyUsage(), lead: emptyUsage() }
  }

  stageTotals(): Record<Caller, Usage> {
    return this.stageUsage
  }

  allocatePhone(): number {
    const n = this.ledger.nextPhone
    this.ledger.nextPhone = n + 1
    this.save()
    return n
  }

  private save(): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true })
    writeFileSync(this.ledgerPath, JSON.stringify(this.ledger, null, 2))
  }
}
