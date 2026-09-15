import { useSetEmmaEnabled } from '../../hooks/useTags.js'
import { Label } from '../ui/label.js'
import { Switch } from '../ui/switch.js'

/**
 * Switches Emma on or off for this conversation.
 *
 * Distinct from "Devolver a Emma" next to it, and the difference is worth
 * keeping straight: the takeover is temporary and expires on its own after 30
 * minutes, while this stays off until the owner turns it back on. Nothing in
 * the system flips it — not the timeout worker, not handing the thread back.
 */
export function EmmaToggle({
  conversationId,
  enabled,
}: {
  conversationId: string
  enabled: boolean
}): React.JSX.Element {
  const mutation = useSetEmmaEnabled(conversationId)

  // While the request is in flight, show what the owner just clicked. Rendering
  // the server's stale value would flick the switch back under their finger.
  const shown = mutation.isPending ? (mutation.variables ?? enabled) : enabled

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Label htmlFor="emma-toggle" className="text-muted-foreground hidden text-xs sm:inline">
        Emma
      </Label>
      <Switch
        id="emma-toggle"
        checked={shown}
        disabled={mutation.isPending}
        onCheckedChange={(next) => mutation.mutate(next)}
        aria-label={shown ? 'Apagar Emma en este chat' : 'Prender Emma en este chat'}
      />
    </div>
  )
}
