// Minimal local type shim. The published `qrcode-terminal` package has no
// types and the `@types/qrcode-terminal` package is unmaintained, so we
// declare only the surface we use.
declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean
  }
  export function generate(text: string, opts?: GenerateOptions): void
  export function generate(text: string, opts: GenerateOptions, cb: (qr: string) => void): void
  const _default: { generate: typeof generate }
  export default _default
}
