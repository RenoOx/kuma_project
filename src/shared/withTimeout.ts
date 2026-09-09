/**
 * Bounds a promise that has no timeout of its own.
 *
 * Written for Baileys IQ calls. The socket's `defaultQueryTimeoutMs` is
 * deliberately 3 minutes — it is what stopped a slow init query from tearing the
 * whole stream down — but that leash is far too long for a query sitting in a
 * serialized critical path, where one hung call stalls every message behind it.
 *
 * Rejects rather than resolving to a sentinel: callers already treat these
 * queries as best-effort inside try/catch, so a rejection lands on a path that
 * is written and tested, and the label says which call gave up.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
