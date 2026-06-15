export interface AppErrorParams {
  code: string
  message: string
  userMessage: string
  logContext?: Record<string, unknown>
  cause?: unknown
}

export class AppError extends Error {
  readonly code: string
  readonly userMessage: string
  readonly logContext: Record<string, unknown>

  constructor(params: AppErrorParams) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined)
    this.name = this.constructor.name
    this.code = params.code
    this.userMessage = params.userMessage
    this.logContext = params.logContext ?? {}
  }
}

export interface NotFoundParams {
  resource: string
  userMessage?: string
  logContext?: Record<string, unknown>
  cause?: unknown
}

export class NotFoundError extends AppError {
  constructor(params: NotFoundParams) {
    super({
      code: 'not_found',
      message: `${params.resource} not found`,
      userMessage: params.userMessage ?? 'No encontramos lo que buscas.',
      logContext: { resource: params.resource, ...params.logContext },
      cause: params.cause,
    })
  }
}

export interface ValidationParams {
  message: string
  userMessage?: string
  logContext?: Record<string, unknown>
  cause?: unknown
}

export class ValidationError extends AppError {
  constructor(params: ValidationParams) {
    super({
      code: 'validation_error',
      message: params.message,
      userMessage: params.userMessage ?? 'Los datos enviados no son válidos.',
      logContext: params.logContext,
      cause: params.cause,
    })
  }
}

export interface ConflictParams {
  message: string
  userMessage?: string
  logContext?: Record<string, unknown>
  cause?: unknown
}

export class ConflictError extends AppError {
  constructor(params: ConflictParams) {
    super({
      code: 'conflict',
      message: params.message,
      userMessage: params.userMessage ?? 'Conflicto con un recurso existente.',
      logContext: params.logContext,
      cause: params.cause,
    })
  }
}

export interface NotConfiguredParams {
  businessId: string
  missing: string[]
  userMessage?: string
  cause?: unknown
}

export class NotConfiguredError extends AppError {
  constructor(params: NotConfiguredParams) {
    super({
      code: 'not_configured',
      message: `business ${params.businessId} missing settings: ${params.missing.join(', ')}`,
      userMessage: params.userMessage ?? 'Este negocio aún no terminó su configuración.',
      logContext: { businessId: params.businessId, missing: params.missing },
      cause: params.cause,
    })
  }
}

export function toLogObject(error: AppError): Record<string, unknown> {
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    ...error.logContext,
  }
}
