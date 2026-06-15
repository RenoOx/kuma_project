import type { AppError } from './errors.js'

export type Ok<T> = { ok: true; data: T }
export type Err<E> = { ok: false; error: E }
export type Result<T, E = AppError> = Ok<T> | Err<E>

export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok
}
