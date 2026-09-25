import type { ConversationFixedMessage } from '../../api/types.js'
import { MediaField } from '../media/MediaField.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js'

/**
 * Las fotos de los mensajes automáticos que sí pueden llevar galería.
 *
 * A diferencia de las demás cards de Asistente, esta NO está bloqueada: el
 * texto y la lógica de un mensaje fijo los decide Vamvu en el archivo del
 * negocio, pero la foto nunca vive en el repo — todas entran por acá, sin
 * excepción, igual que las de un servicio. Por eso escribe directo (como
 * `KnowledgeList`) y no tiene botón Guardar: no hay nada que batchear.
 *
 * Solo se muestran los mensajes que el archivo declaró `images: true` — uno de
 * puro texto ni aparece, para no ofrecer un cajón vacío que no significa nada.
 */
export function FixedMessageMedia({
  messages,
}: {
  messages: ConversationFixedMessage[]
}): React.JSX.Element | null {
  if (messages.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fotos de tus mensajes automáticos</CardTitle>
        <CardDescription>
          El texto de estos mensajes lo escribe Vamvu, pero las fotos son tuyas: subilas, ordenalas
          o cambialas cuando quieras.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {messages.map((message) => (
          <MediaField
            key={message.id}
            owner={{ kind: 'fixedMessage', id: message.id }}
            label={message.when ?? message.id}
            unsavedHint="Este mensaje todavía no está disponible."
            // Sin tope: un mensaje fijo manda su galería entera, no las
            // primeras dos — eso es de las fotos de un servicio.
            orderNotice={null}
          />
        ))}
      </CardContent>
    </Card>
  )
}
