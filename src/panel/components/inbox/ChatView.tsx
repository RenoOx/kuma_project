import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ChatMessage, ConversationListItem } from '../../api/types.js'
import { useMessages } from '../../hooks/useMessages.js'
import { useReply, useReturnToEmma, useSetQualification } from '../../hooks/useReply.js'
import {
  MANUAL_QUALIFICATIONS,
  QUALIFICATION_META,
  type Qualification,
} from '../../lib/constants.js'
import { cn, formatPhone } from '../../lib/utils.js'
import { NameTags } from '../NameTags.js'
import { Button } from '../ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js'
import { MessageBubble } from './MessageBubble.js'
import { QualificationBadge } from './QualificationBadge.js'
import { ReplyInput } from './ReplyInput.js'

// How close to the bottom still counts as "reading the latest". Anything above
// this and the owner is reading history, so we leave their scroll alone.
const STICK_TO_BOTTOM_PX = 120

export function ChatView({
  conversation,
  ownerName,
  onBack,
}: {
  conversation: ConversationListItem
  ownerName: string | null
  onBack: () => void
}): React.JSX.Element {
  const { messages, qualification, isLoading, isError, hasEarlier, loadEarlier, isLoadingEarlier } =
    useMessages(conversation.id)
  const { pending, send, retry, dismiss, isSending } = useReply(conversation.id)
  const returnMutation = useReturnToEmma(conversation.id)
  const qualificationMutation = useSetQualification(conversation.id)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const previousConversation = useRef(conversation.id)

  const all: ChatMessage[] = [...messages, ...pending]

  // Whether the owner is at the bottom is read BEFORE React paints the new
  // messages, because once they are in the DOM the scroll position has already
  // moved and the question can no longer be answered.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom.current = distance < STICK_TO_BOTTOM_PX
  }

  // Opening a different conversation always lands at the newest message.
  useEffect(() => {
    if (previousConversation.current !== conversation.id) {
      previousConversation.current = conversation.id
      stickToBottom.current = true
    }
  }, [conversation.id])

  // all.length is the trigger, not an input: the effect scrolls BECAUSE the
  // count changed, and reading it inside the body would not change what it does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger dependency, intentional
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Only follow along when they were already at the bottom. Yanking the view
    // down every five seconds would make reading anything older impossible,
    // which is exactly what a 5s poll would otherwise do.
    if (stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [all.length])

  // The badge flips the moment the owner sends, not when the server confirms:
  // replying IS taking the conversation over, and showing the two a second
  // apart reads as a glitch.
  const shownQualification: Qualification =
    pending.length > 0 ? 'human_takeover' : (qualification ?? conversation.qualification)
  const isTakenOver = shownQualification === 'human_takeover'

  return (
    // The one block that keeps the page's own fill instead of the lighter block
    // surface: the customer's bubbles are that lighter surface, and a chat
    // painted the same colour would swallow them. Border and radius are what
    // make it a block here.
    <div className="bg-emma-bg border-border flex h-full min-h-0 flex-col overflow-hidden rounded-xl border">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Volver a la lista"
          className="text-muted-foreground -ml-1 size-8 md:hidden"
        >
          <ArrowLeft size={18} aria-hidden />
        </Button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {formatPhone(conversation.phone)}
          </p>
          <NameTags names={conversation.appointmentNames} />
        </div>

        {/* The badge is the control: the owner reads the label here, so this is
            where they reach to correct it. The two event-backed labels are not
            in the list — see MANUAL_QUALIFICATIONS. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={qualificationMutation.isPending}
            aria-label="Cambiar etiqueta"
            className="rounded-full transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            <QualificationBadge qualification={shownQualification} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Cambiar etiqueta</DropdownMenuLabel>
            {MANUAL_QUALIFICATIONS.map((option) => (
              <DropdownMenuItem
                key={option}
                onSelect={() => qualificationMutation.mutate(option)}
                className={cn(option === shownQualification && 'font-medium')}
              >
                <span
                  className={cn('size-2 rounded-full', QUALIFICATION_META[option].dotClassName)}
                />
                {QUALIFICATION_META[option].label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {isTakenOver && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => returnMutation.mutate()}
            disabled={returnMutation.isPending}
            className="text-muted-foreground hover:border-primary hover:text-primary shrink-0 text-xs"
          >
            <RotateCcw size={13} aria-hidden />
            <span className="hidden sm:inline">
              {returnMutation.isPending ? 'Devolviendo…' : 'Devolver a Emma'}
            </span>
          </Button>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-3">
        {hasEarlier && (
          <div className="mb-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={loadEarlier}
              disabled={isLoadingEarlier}
              className="text-muted-foreground hover:text-foreground rounded-full text-xs"
            >
              {isLoadingEarlier ? 'Cargando…' : 'Ver mensajes anteriores'}
            </Button>
          </div>
        )}

        {isLoading && <Notice>Cargando mensajes…</Notice>}
        {isError && <Notice>No pudimos cargar esta conversación.</Notice>}
        {!isLoading && !isError && all.length === 0 && <Notice>No hay mensajes todavía.</Notice>}

        <div className="flex flex-col gap-3">
          {all.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              ownerName={ownerName}
              onRetry={retry}
              onDismiss={dismiss}
            />
          ))}
        </div>
      </div>

      {qualificationMutation.isError && (
        <p className="text-destructive shrink-0 px-3 py-1.5 text-center text-xs">
          No pudimos cambiar la etiqueta. Intentá de nuevo.
        </p>
      )}

      {returnMutation.isError && (
        <p className="text-destructive shrink-0 px-3 py-1.5 text-center text-xs">
          No pudimos devolver la conversación a Emma. Intentá de nuevo.
        </p>
      )}

      <ReplyInput ownerName={ownerName} disabled={isSending} onSend={send} />
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-muted-foreground py-8 text-center text-sm">{children}</p>
}
