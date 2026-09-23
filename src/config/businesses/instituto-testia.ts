import { defineBusinessConfig } from './define.js'

// Instituto TestIA (dev): el ensayo de Instituto Tecmin. Negocio de prueba (+999),
// se prueba con "Probar Emma". Este archivo manda sobre lo que diga el panel en la
// tarjeta Conversación; los cursos, el saludo y los datos a pedir siguen en la base
// (npm run business:show:dev -- 10jPkBrN_wkFkCkJYKPYF para ver todo junto).
//
// La IA solo lee la intención del alumno. Los montos se dicen tal cual: nunca se
// suman, restan ni combinan. Por eso están acá escritos, y no se le pide calcular.

// Cómo se paga un curso. Se repite en los pasos donde Emma puede dar precios de
// cursos: las indicaciones solo valen en el paso en que está la conversación.
// (informing ya no lo lleva: ahí solo se decide el camino.)
const PRECIOS_CURSOS = [
  'Cómo se paga un curso, tal cual y sin hacer cuentas:',
  '- Para empezar se paga la matrícula de S/ 150 (es la misma para los tres cursos).',
  '- Después, cada curso tiene su mensualidad: el precio de la lista es POR MES. Decí siempre "S/ X al mes".',
  '- Si se inscribe esta semana tiene un descuento: BÁSICO S/ 100, AVANZADO S/ 300, OPERACIÓN MÚLTIPLE S/ 800.',
  '- Si pregunta cuánto paga ahora: la matrícula de S/ 150.',
  '- Si pide un total o "cuánto queda con el descuento": decile los montos por separado, tal cual. Nunca restes ni sumes.',
].join('\n')

export default defineBusinessConfig({
  businessId: '10jPkBrN_wkFkCkJYKPYF',
  name: 'Instituto TestIA (dev)',
  flowType: 'sales',

  flow: [
    { node: 'idle' },

    // El saludo es el mensaje configurado ("¿tienes experiencia en maquinaria
    // pesada?"), que Emma manda tal cual en el primer mensaje.
    { node: 'greeting' },

    // La bifurcación del diagrama: acá solo se decide el camino. Lo que se le
    // ofrece a cada uno vive en su propio paso.
    {
      node: 'informing',
      extraInstructions: [
        'El saludo ya le preguntó si tiene experiencia en maquinaria pesada. Tu único trabajo acá es saber la respuesta.',
        '- Si TIENE experiencia: pasá al paso de certificación. No le ofrezcas cursos.',
        '- Si NO tiene experiencia: pasá al paso de cursos.',
        '- Si la respuesta no es clara, preguntale de nuevo si tiene experiencia manejando maquinaria pesada.',
      ].join('\n'),
      routes: [
        {
          id: 'con-experiencia',
          when: 'El alumno dice que tiene experiencia manejando maquinaria pesada.',
          to: 'asesoria_perfil',
        },
        {
          id: 'sin-experiencia',
          when: 'El alumno no tiene experiencia en maquinaria pesada.',
          to: 'listado_servicios',
        },
      ],
    },

    {
      node: 'listado_servicios',
      extraInstructions: [
        'Mostrá los cursos de la categoría Cursos con show_services, cada uno por separado: no los agrupes ni los resumas.',
        '',
        PRECIOS_CURSOS,
      ].join('\n'),
      cta: '¿Cuál te gustaría iniciar?',
      routes: [
        {
          id: 'ruta-cierre',
          when: 'El alumno eligió un curso concreto y quiere inscribirse.',
          to: 'collect_data',
        },
      ],
    },

    // Camino con experiencia. La IA solo elige el tramo por el número de máquinas;
    // el texto de la oferta y el precio los pone el código (ofertaCertificacion).
    {
      node: 'asesoria_perfil',
      label: 'Asesoría con experiencia',
      extraInstructions: [
        'La pregunta clave es "¿Cuántas maquinarias manejas?".',
        'Con ese número elegí la certificación de su tramo, con el nombre exacto de la lista:',
        '- 1 o 2 máquinas → Certificación - 1 a 2 máquinas',
        '- 3 o 4 máquinas → Certificación - 3 a 4 máquinas',
        '- 5 o más → Certificación - 5 máquinas o más',
        'Mandá la oferta con send_fixed_message (mensaje "ofertaCertificacion" y esa certificación). No escribas el precio vos: ya va en el mensaje.',
        'Después del mensaje fijo, solo preguntale si quiere avanzar con su certificación.',
        'A este alumno no le ofrezcas los cursos.',
      ].join('\n'),
      fixedMessages: ['ofertaCertificacion'],
      routes: [
        {
          id: 'quiere-certificarse',
          when: 'El alumno quiere avanzar con la certificación que se le ofreció.',
          to: 'collect_data',
        },
      ],
    },

    {
      node: 'collect_data',
      extraInstructions: [
        'Según lo que eligió:',
        '- Si eligió una CERTIFICACIÓN, dale los requisitos tal cual: 1. Envíame la foto de tu DNI, ambas caras, para realizar todos tus documentos. 2. Te enviaré los certificados para que verifiques que tus datos son correctos. 3. Realizas el pago por Yape, Plin, transferencia bancaria o depósito.',
        '- Si eligió un CURSO: preguntale "¿Deseas activar el cupón de descuento?". Si acepta, decile el descuento de su curso tal cual. Después pedile que te mande la captura del pago de la matrícula.',
        'Guardá el curso o la certificación elegida con su nombre exacto de la lista.',
        '',
        PRECIOS_CURSOS,
      ].join('\n'),
      // Con la primera foto (DNI o voucher): se la reenvía al dueño y Emma se
      // pausa en ese chat. El dueño la vuelve a prender desde el Inbox.
      onImage: { forward: true, pause: true },
    },

    { node: 'confirmed' },
  ],

  fixedMessages: {
    // {precio} sale del servicio elegido en el panel: si el dueño cambia el precio
    // de una certificación, la oferta cambia sola. Imagen del carnet: pendiente
    // (cuando esté en images/, agregar `image: 'carnet-qr.png'`).
    ofertaCertificacion: {
      when: 'Cuando ya sabés cuántas máquinas maneja y elegiste su certificación.',
      text: [
        'Por solo S/. {precio} obtienes tus certificados y la inversión incluye:',
        '📜 Certificados físicos y digitales de cada equipo.',
        '🎞️ 10 clases teóricas en video.',
        'Recuerda que la inversión incluye:',
        '📖 01 manual digital de cada equipo.',
        '🪪 01 carnet con código QR para que puedas verificar que tu certificado esta registrado y subido al sistema como este 👇😃',
      ].join('\n'),
    },
  },
})
