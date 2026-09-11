import { cn } from '../../lib/utils.js'

/**
 * Emma's mark in the panel.
 *
 * The wordmark is a placeholder: `src` is the seam for the real logo, so
 * dropping in an image later is one prop at the call site rather than a hunt
 * through the layout. Sized by height so a wide or narrow image both sit on the
 * same baseline as the text it replaces.
 */
export function Logo({ src, className }: { src?: string; className?: string }): React.JSX.Element {
  if (src) {
    return <img src={src} alt="Emma" className={cn('h-6 w-auto', className)} />
  }

  return (
    <span className={cn('text-emma-cream text-lg font-bold tracking-tight', className)}>Emma</span>
  )
}
