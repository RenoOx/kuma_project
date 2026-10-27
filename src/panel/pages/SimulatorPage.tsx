import {
  AlertTriangle,
  FileText,
  FlaskConical,
  ImagePlus,
  PauseCircle,
  Power,
  RotateCcw,
  Send,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type {
  SimulatorAttachment,
  SimulatorFixedMessage,
  SimulatorImageOutcome,
  SimulatorTurn,
  SimulatorVersion,
} from '../api/types.js'
import { Badge } from '../components/ui/badge.js'
import { Button } from '../components/ui/button.js'
import { Textarea } from '../components/ui/textarea.js'
import { useConversationCatalog } from '../hooks/useSettings.js'
import { type SimulatorEntry, useSimulatorChat, useSimulatorStatus } from '../hooks/useSimulator.js'
import { cn } from '../lib/utils.js'

// El mismo tope que acepta el servidor: un grupo de fotos, no un álbum.
const MAX_IMAGES_PER_SEND = 10

/**
 * Pruebas: una conversación de prueba sin WhatsApp, con la versión del flujo que
 * corre hoy o con una versión en prueba (que WhatsApp no corre).
 *
 * Eres el cliente. Cada respuesta trae abajo lo que pasó para llegar a ella
 * —en qué paso estaba, a cuál pasó, qué tools usó y qué le devolvieron— porque
 * eso es lo que hace falta ver para entender POR QUÉ respondió así, y en el
 * Inbox no se ve.
 */
export function SimulatorPage(): React.JSX.Element {
  const status = useSimulatorStatus()
  // En la URL: así un link puede abrir directo la versión en prueba.
  const [params, setParams] = useSearchParams()

  if (status.isLoading) {
    return <p className="text-muted-foreground p-4 text-sm">Cargando…</p>
  }
  if (!status.data?.enabled) {
    return (
      <div className="mx-auto max-w-xl p-4">
        <Notice title="Las pruebas no están habilitadas para este negocio">
          Aparecen cuando el negocio tiene una versión en prueba del flujo, o en un servidor con{' '}
          <code>SIMULATOR_ENABLED=true</code>.
        </Notice>
      </div>
    )
  }

  const versions = status.data.versions
  const requested = params.get('version')
  // Una versión que ya no existe (se publicó) vuelve a la de siempre.
  const version = versions.some((v) => v.id === requested) ? requested : null
  const choose = (id: string | null): void => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('version', id)
      else next.delete('version')
      return next
    })
  }

  // La key monta una conversación nueva al cambiar de versión: mezclar dos
  // flujos en el mismo chat no prueba ninguno.
  return (
    <SimulatorChatView
      key={version ?? 'live'}
      versions={versions}
      version={version}
      onChooseVersion={choose}
    />
  )
}

function SimulatorChatView({
  versions,
  version,
  onChooseVersion,
}: {
  versions: SimulatorVersion[]
  version: string | null
  onChooseVersion: (id: string | null) => void
}): React.JSX.Element {
  const { entries, sending, emmaPaused, resumeError, send, sendImages, resume, reset } =
    useSimulatorChat(version)
  const catalog = useConversationCatalog()
  const [draft, setDraft] = useState('')
  const [pickError, setPickError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)

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

  // Lo escrito en el cuadro viaja como el texto de la foto, igual que en WhatsApp.
  const pickImages = (list: FileList | null): void => {
    const files = Array.from(list ?? []).filter((file) => file.type.startsWith('image/'))
    if (filePicker.current) filePicker.current.value = ''
    if (files.length === 0 || sending) return
    if (files.length > MAX_IMAGES_PER_SEND) {
      setPickError(`Máximo ${MAX_IMAGES_PER_SEND} fotos a la vez.`)
      return
    }
    setPickError(null)
    const caption = draft
    setDraft('')
    void sendImages(files, caption)
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <FlaskConical size={18} aria-hidden />
            Pruebas
          </h1>
          <p className="text-muted-foreground text-xs">
            Eres el cliente. No se envía nada por WhatsApp, ni a ti ni al dueño. La conversación
            queda guardada, pero no aparece en el Inbox, Contactos, Dashboard ni el embudo.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reset} disabled={sending}>
          <RotateCcw size={14} aria-hidden />
          Nueva conversación
        </Button>
      </header>

      {versions.length > 0 && (
        <VersionPicker
          versions={versions}
          version={version}
          disabled={sending}
          onChoose={onChooseVersion}
        />
      )}

      <p className="text-muted-foreground rounded-md border border-emma-border bg-emma-elevated px-3 py-2 text-xs">
        Lo que esta vista no prueba: el agrupado de mensajes seguidos, el control humano, el horario
        de atención y la captura de pago de una cita con adelanto. Las fotos se ven solo acá: no se
        suben ni se le reenvían a nadie.
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-lg border border-emma-border bg-emma-bg-secondary p-3">
        {entries.length === 0 && (
          <p className="text-muted-foreground m-auto text-sm">
            Escribe como si fueras un cliente. Por ejemplo: "hola, qué cursos tienen?"
          </p>
        )}
        {entries.map((entry) => (
          <Exchange key={entry.id} entry={entry} labelOf={labelOf} />
        ))}
        <div ref={bottom} />
      </div>

      {emmaPaused && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emma-border bg-emma-elevated px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5">
            <PauseCircle size={14} aria-hidden />
            Emma está apagada en este chat: lo que escribas se guarda y nadie responde, como en
            WhatsApp.
          </span>
          <Button size="sm" variant="outline" onClick={() => void resume()} disabled={sending}>
            <Power size={14} aria-hidden />
            Reactivar Emma
          </Button>
          {resumeError && <span className="text-destructive w-full">{resumeError}</span>}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-end gap-2">
          <input
            ref={filePicker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => pickImages(e.target.files)}
          />
          <Button
            variant="outline"
            onClick={() => filePicker.current?.click()}
            disabled={sending}
            aria-label="Enviar imagen"
            title="Enviar imagen (lo escrito va como texto de la foto)"
          >
            <ImagePlus size={14} aria-hidden />
            <span className="hidden sm:inline">Imagen</span>
          </Button>
          <Textarea
            value={draft}
            rows={2}
            maxLength={2000}
            placeholder="Escribe tu mensaje… (Enter envía, Shift+Enter hace un salto de línea)"
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
        {pickError && <p className="text-destructive text-xs">{pickError}</p>}
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
        <span className="text-muted-foreground px-1 text-[11px]">
          Tú (cliente)
          {entry.images.length > 0 &&
            ` · ${entry.images.length === 1 ? 'envío de imagen' : `envío de ${entry.images.length} imágenes`}`}
        </span>
        {entry.images.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap gap-1.5 md:max-w-[70%]">
            {entry.images.map((url) => (
              <img
                key={url}
                src={url}
                alt="Foto enviada por el cliente de prueba"
                className="h-32 rounded-lg border border-emma-border object-cover"
              />
            ))}
          </div>
        )}
        {entry.text && (
          <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-emma-border bg-emma-elevated px-3.5 py-2 text-sm whitespace-pre-wrap text-emma-text md:max-w-[70%]">
            {entry.text}
          </div>
        )}
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
  const attachments = turn.attachments.map((attachment, index) => (
    // Los adjuntos de un turno no tienen id propio y su orden no cambia.
    // biome-ignore lint/suspicious/noArrayIndexKey: lista inmutable del turno
    <AttachmentPreview key={index} attachment={attachment} />
  ))
  const silent = turn.fixedMessages.length === 0 && !turn.reply && turn.attachments.length === 0

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-muted-foreground px-1 text-[11px]">Emma</span>
      {turn.image && <ImageOutcomeNote outcome={turn.image} />}
      {silent && !turn.image && turn.emmaPaused && (
        <p className="text-muted-foreground text-xs">
          Emma está apagada en este chat: no respondió.
        </p>
      )}

      {/* El orden es el de WhatsApp: mensajes fijos, después los adjuntos si el
          paso los pone antes (mediaFirst), el texto de Emma y el resto. */}
      {turn.fixedMessages.map((fixed, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lista inmutable del turno
        <FixedMessageView key={index} fixed={fixed} />
      ))}
      {turn.mediaFirst && attachments}
      {turn.reply && (
        <div className="bg-emma-bubble-bot max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap text-white md:max-w-[70%]">
          {turn.reply}
        </div>
      )}
      {!turn.mediaFirst && attachments}

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

/** Un mensaje fijo, marcado para distinguirlo de lo que redactó la IA. */
function FixedMessageView({ fixed }: { fixed: SimulatorFixedMessage }): React.JSX.Element {
  // La galería completa, en el mismo orden en que WhatsApp las recibe: una
  // foto por mensaje, una atrás de otra, antes o después del texto.
  const gallery =
    fixed.images.length > 0 ? (
      <div className="flex flex-wrap justify-end gap-1.5">
        {fixed.images.map((img, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lista inmutable del turno
          <div key={i}>
            {img.url ? (
              <img
                src={img.url}
                alt=""
                className="h-32 rounded-lg border border-emma-border object-cover"
              />
            ) : (
              <span className="text-muted-foreground text-[11px]">
                Una foto no se pudo cargar (almacenamiento no configurado)
              </span>
            )}
          </div>
        ))}
      </div>
    ) : null

  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1 md:max-w-[70%]">
      {fixed.imagesFirst && gallery}
      <div className="bg-emma-bubble-bot rounded-2xl rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap text-white ring-2 ring-offset-1 ring-emma-accent/40">
        {fixed.text}
      </div>
      {!fixed.imagesFirst && gallery}
      <span className="text-muted-foreground text-[11px]">Mensaje fijo · lo manda el código</span>
    </div>
  )
}

/** Lo que pasó con las fotos del cliente de prueba, con la regla de WhatsApp. */
function ImageOutcomeNote({ outcome }: { outcome: SimulatorImageOutcome }): React.JSX.Element {
  const box =
    'flex w-full max-w-[85%] flex-col gap-1.5 rounded-md border border-emma-border bg-emma-bg p-2.5 text-xs md:max-w-[70%]'

  if (outcome.kind === 'handled') {
    return (
      <div className={box}>
        {outcome.forwardNotice ? (
          <>
            <p className="font-medium">Se le reenviaría al dueño con este aviso:</p>
            <pre className="bg-emma-elevated rounded p-2 text-[11px] whitespace-pre-wrap">
              {outcome.forwardNotice}
            </pre>
          </>
        ) : (
          <p className="text-muted-foreground">
            No se le reenvía al dueño: el paso no lo pide o el negocio no tiene su número.
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {outcome.paused && <Badge variant="secondary">Emma se pausó en este chat</Badge>}
          {outcome.tagged && <Badge variant="outline">Etiqueta: Por validar</Badge>}
        </div>
      </div>
    )
  }

  const text: Record<Exclude<SimulatorImageOutcome['kind'], 'handled'>, string> = {
    emma_paused: 'Emma está apagada en este chat: la foto se guardó y nadie respondió.',
    ignored: 'Este paso no pide fotos: se guarda en el Inbox y Emma no responde.',
    continued:
      'Este paso no pide fotos: no se le reenvía a nadie y Emma sigue el paso sabiendo que llegó.',
    not_simulated:
      'La captura de pago de una cita con adelanto no se simula todavía: esa prueba va por WhatsApp.',
  }
  return (
    <div className={box}>
      <p className="text-muted-foreground">{text[outcome.kind]}</p>
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

/**
 * Con qué versión del flujo se prueba. "Flujo actual" es el que reciben los
 * clientes por WhatsApp; las demás son versiones en prueba que WhatsApp no corre.
 */
function VersionPicker({
  versions,
  version,
  disabled,
  onChoose,
}: {
  versions: SimulatorVersion[]
  version: string | null
  disabled: boolean
  onChoose: (id: string | null) => void
}): React.JSX.Element {
  const options = [{ id: null, label: 'Flujo actual (WhatsApp)' }, ...versions]
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="Versión del flujo" className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = option.id === version
          return (
            <Button
              key={option.id ?? 'live'}
              role="radio"
              aria-checked={active}
              size="sm"
              variant={active ? 'default' : 'outline'}
              disabled={disabled}
              onClick={() => onChoose(option.id)}
            >
              {option.label}
              {option.id !== null && (
                <Badge variant="secondary" className="ml-1">
                  en prueba
                </Badge>
              )}
            </Button>
          )
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        {version === null
          ? 'Es el flujo que reciben hoy los clientes por WhatsApp.'
          : 'WhatsApp no corre esta versión: solo se ve acá. Cambiar de versión empieza una conversación nueva.'}
      </p>
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
