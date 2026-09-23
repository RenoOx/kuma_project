import { AlertTriangle, FileText, FlaskConical, RotateCcw, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SimulatorAttachment, SimulatorTurn } from '../api/types.js'
import { Badge } from '../components/ui/badge.js'
import { Button } from '../components/ui/button.js'
import { Textarea } from '../components/ui/textarea.js'
import { useConversationCatalog } from '../hooks/useSettings.js'
import { type SimulatorEntry, useSimulatorChat, useSimulatorStatus } from '../hooks/useSimulator.js'
import { cn } from '../lib/utils.js'

/**
 * Probar Emma: una conversación de prueba sin WhatsApp.
 *
 * Vos sos el cliente. Cada respuesta trae abajo lo que pasó para llegar a ella
 * —en qué paso estaba, a cuál pasó, qué tools usó y qué le devolvieron— porque
 * eso es lo que hace falta ver para entender POR QUÉ respondió así, y en el
 * Inbox no se ve.
 */
export function SimulatorPage(): React.JSX.Element {
  const status = useSimulatorStatus()

  if (status.isLoading) {
    return <p className="text-muted-foreground p-4 text-sm">Cargando…</p>
  }
  if (!status.data?.enabled) {
    return (
      <div className="mx-auto max-w-xl p-4">
        <Notice title="El simulador no está habilitado en este servidor">
          Se prende con <code>SIMULATOR_ENABLED=true</code>. Está apagado en producción a propósito:
          cada prueba crea clientes, mensajes y hasta citas en la base.
        </Notice>
      </div>
    )
  }
  return <SimulatorChatView />
}

function SimulatorChatView(): React.JSX.Element {
  const { entries, sending, send, reset } = useSimulatorChat()
  const catalog = useConversationCatalog()
  const [draft, setDraft] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  const labelOf = (id: string): string =>
    catalog.data?.nodes.find((node) => node.id === id)?.label ?? id

  // Cada mensaje nuevo o respuesta que llega baja la vista hasta el final.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el disparador es el cambio de entries, no su uso
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [entries])

  const submit = (): void => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    void send(text)
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <FlaskConical size={18} aria-hidden />
            Probar Emma
          </h1>
          <p className="text-muted-foreground text-xs">
            Vos sos el cliente. No se envía nada por WhatsApp, pero la conversación, los datos y las
            citas de prueba sí quedan guardados en esta base.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reset} disabled={sending}>
          <RotateCcw size={14} aria-hidden />
          Nueva conversación
        </Button>
      </header>

      <p className="text-muted-foreground rounded-md border border-emma-border bg-emma-elevated px-3 py-2 text-xs">
        Lo que esta vista no prueba: el agrupado de mensajes seguidos, la pausa, el control humano,
        el horario de atención y el envío de fotos (capturas de pago).
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-lg border border-emma-border bg-emma-bg-secondary p-3">
        {entries.length === 0 && (
          <p className="text-muted-foreground m-auto text-sm">
            Escribí como si fueras un cliente. Por ejemplo: "hola, qué cursos tienen?"
          </p>
        )}
        {entries.map((entry) => (
          <Exchange key={entry.id} entry={entry} labelOf={labelOf} />
        ))}
        <div ref={bottom} />
      </div>

      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          rows={2}
          maxLength={2000}
          placeholder="Escribí tu mensaje… (Enter envía, Shift+Enter hace un salto de línea)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <Button onClick={submit} disabled={sending || draft.trim() === ''}>
          <Send size={14} aria-hidden />
          Enviar
        </Button>
      </div>
    </div>
  )
}

function Exchange({
  entry,
  labelOf,
}: {
  entry: SimulatorEntry
  labelOf: (id: string) => string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col items-start gap-1">
        <span className="text-muted-foreground px-1 text-[11px]">Vos (cliente)</span>
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-emma-border bg-emma-elevated px-3.5 py-2 text-sm whitespace-pre-wrap text-emma-text md:max-w-[70%]">
          {entry.text}
        </div>
      </div>

      {entry.error ? (
        <p className="text-destructive flex items-center gap-1.5 self-end text-xs">
          <AlertTriangle size={13} aria-hidden />
          {entry.error}
        </p>
      ) : entry.turn ? (
        <EmmaTurn turn={entry.turn} labelOf={labelOf} />
      ) : (
        <p className="text-muted-foreground self-end text-xs">Emma está escribiendo…</p>
      )}
    </div>
  )
}

function EmmaTurn({
  turn,
  labelOf,
}: {
  turn: SimulatorTurn
  labelOf: (id: string) => string
}): React.JSX.Element {
  const moved = turn.stateBefore !== turn.stateAfter
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-muted-foreground px-1 text-[11px]">Emma</span>
      {turn.reply && (
        <div className="bg-emma-bubble-bot max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap text-white md:max-w-[70%]">
          {turn.reply}
        </div>
      )}
      {turn.attachments.map((attachment, index) => (
        <AttachmentPreview
          // Los adjuntos de un turno no tienen id propio y su orden no cambia.
          // biome-ignore lint/suspicious/noArrayIndexKey: lista inmutable del turno
          key={index}
          attachment={attachment}
        />
      ))}

      <details className="w-full max-w-[85%] text-xs md:max-w-[70%]">
        <summary className="text-muted-foreground hover:text-emma-text cursor-pointer text-right">
          {moved
            ? `Paso: ${labelOf(turn.stateBefore)} → ${labelOf(turn.stateAfter)}`
            : `Paso: ${labelOf(turn.stateAfter)}`}
          {turn.tools.length > 0 &&
            ` · ${turn.tools.length} ${turn.tools.length === 1 ? 'tool' : 'tools'}`}
          {turn.escalated && ' · escaló'}
        </summary>
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-emma-border bg-emma-bg p-2.5">
          <div className="flex flex-wrap gap-1.5">
            {turn.escalated && <Badge variant="secondary">Escaló a un humano</Badge>}
            {turn.maxIterationsHit && (
              <Badge variant="destructive">
                Se quedó sin vueltas: respondió el texto de respaldo
              </Badge>
            )}
            <Badge variant="outline">
              {turn.tokens.input.toLocaleString('es-PE')} tokens de entrada ·{' '}
              {turn.tokens.output.toLocaleString('es-PE')} de salida
            </Badge>
          </div>
          {turn.tools.length === 0 ? (
            <p className="text-muted-foreground">No usó ninguna tool en este turno.</p>
          ) : (
            turn.tools.map((tool, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: la misma tool puede repetirse en un turno
              <div key={index} className="flex flex-col gap-1">
                <p className={cn('font-medium', tool.error && 'text-destructive')}>
                  {tool.name}
                  {tool.error && ` — error: ${tool.error}`}
                </p>
                <pre className="bg-emma-elevated overflow-x-auto rounded p-2 text-[11px] whitespace-pre-wrap">
                  {JSON.stringify(tool.args, null, 2)}
                </pre>
                <pre className="text-muted-foreground max-h-40 overflow-y-auto rounded border border-emma-border p-2 text-[11px] whitespace-pre-wrap">
                  {tool.result}
                </pre>
              </div>
            ))
          )}
        </div>
      </details>
    </div>
  )
}

function AttachmentPreview({ attachment }: { attachment: SimulatorAttachment }): React.JSX.Element {
  const { url, type, filename, caption } = attachment
  return (
    <div className="flex max-w-[85%] flex-col gap-1 rounded-lg border border-emma-border bg-emma-bg-secondary p-2 md:max-w-[70%]">
      {!url ? (
        <p className="text-muted-foreground text-xs">
          {filename} — sin vista previa (el almacenamiento no está configurado)
        </p>
      ) : type === 'image' ? (
        <img src={url} alt={filename} className="max-h-64 rounded object-contain" />
      ) : type === 'audio' ? (
        // biome-ignore lint/a11y/useMediaCaption: es material que subió el dueño, no tenemos subtítulos
        <audio src={url} controls />
      ) : type === 'video' ? (
        // biome-ignore lint/a11y/useMediaCaption: es material que subió el dueño, no tenemos subtítulos
        <video src={url} controls className="max-h-64 rounded" />
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-emma-accent flex items-center gap-1.5 text-sm underline"
        >
          <FileText size={14} aria-hidden />
          {filename}
        </a>
      )}
      {caption && <p className="text-xs whitespace-pre-wrap">{caption}</p>}
    </div>
  )
}

function Notice({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-emma-border bg-emma-bg-secondary p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-sm">{children}</p>
    </div>
  )
}
