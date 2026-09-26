import { defineBusinessConfig } from './define.js'

// Instituto Tecmin (prod, 4aIwSdMZBY12B06MSSovj): el negocio real, con WhatsApp
// ya conectado. Este archivo manda sobre la base en el flujo, el saludo, los
// datos a pedir y los mensajes fijos. Los cursos, las certificaciones y sus
// precios siguen en la base, editables desde el panel
// (npm run business:show:prod -- 4aIwSdMZBY12B06MSSovj para ver todo junto).
//
// Es el mismo diseño que Instituto TestIA (dev) — su ensayo — con dos
// diferencias reales, no cosméticas:
//
// 1. Los 4 cursos de Tecmin tienen precio ÚNICO (S/100, S/200, S/300, S/200):
//    sin matrícula aparte, sin mensualidad, sin descuento por inscribirse esta
//    semana. Por eso este archivo NO lleva el bloque "cómo se paga" de TestIA —
//    no hay nada que explicar, `show_services` ya muestra el precio y la regla
//    general de "no hagas cuentas" alcanza.
// 2. Por lo mismo, collect_data no le pregunta por un cupón de descuento a
//    quien elige un curso: ese paso solo existe en el modelo de TestIA.
//
// Antes de que esto corra tal cual en prod hacen falta dos cambios en el panel
// de Tecmin, del lado del dueño — no los hace este archivo:
// Las 3 certificaciones (2026-09-25, ya creadas en el panel de Tecmin):
// "Certificación - 1 a 2 máquinas" S/295, "Certificación - 3 a 4 máquinas"
// S/350, "Certificación - 5 máquinas o más" S/500. asesoria_perfil las nombra
// tal cual — sin ellas, send_fixed_message fallaría.
//
// El adelanto de S/30 por Yape sigue prendido en la fila real: "Formas de pago
// y adelanto" quedó bloqueado en el panel (lo configura Vamvu), así que el
// dueño no puede apagarlo ahí. `requiresDeposit: false` abajo lo apaga PARA
// ESTE FLUJO sin tocar esa fila — el mismo mecanismo que ya usan greeting y
// collectData.

export default defineBusinessConfig({
  businessId: '4aIwSdMZBY12B06MSSovj',
  name: 'Instituto Tecmin',
  flowType: 'sales',

  // Lo primero que dice Emma, tal cual. Hace la pregunta de la bifurcación, así
  // que en el primer mensaje no se agrega otra invitación (ver greetingAsks).
  greeting:
    '¡Hola! ¿Cómo estás? Para apoyarte necesito saber si tienes experiencia en maquinaria pesada.',

  // Por ahora, sin precio en el listado (2026-09-26): cuando lista VARIAS
  // opciones no dice el monto de cada una — solo cuando el cliente pregunta por
  // UNA en particular, o cuando ya lo trae un mensaje fijo. Revertir borrando
  // esto: el motor por defecto sí muestra precio en el listado.
  instructions:
    'Cuando LISTES varias opciones juntas (cursos o certificaciones), no digas el precio de cada una — solo el nombre. El precio se lo das recién cuando pregunta por UNA en particular, o cuando ya viene en un mensaje fijo.',

  // Lo que Emma pide y guarda en collect_data, en este orden.
  collectData: ['nombre completo', 'curso o certificación elegida'],

  // El flujo nuevo cobra directo: sin esto, la fila real de Tecmin (adelanto
  // de S/30 por Yape) le agregaría al prompt un bloque de "para separar el
  // cupo" que este flujo no maneja en ningún paso.
  requiresDeposit: false,

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
      extraInstructions:
        'Apenas sepas que no tiene experiencia, llamá show_services con category "Cursos" UNA sola vez y mostrá los 3 cursos completos de una — cada uno con su ficha (imagen + detalle), todos juntos en el mismo turno. Nunca de a uno ni repartido en varios mensajes. Tu texto es solo una intro corta: el precio y el detalle ya van en cada ficha, no los repitas vos.',
      cta: '¿Cuál te gustaría iniciar?',
      routes: [
        {
          id: 'ruta-cierre',
          when: 'El alumno eligió un curso concreto y quiere inscribirse.',
          to: 'mostrar_beneficios',
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
        'No le OFREZCAS los cursos vos primero. Pero si el alumno pregunta por ellos o dice que prefiere uno, respondele bien (send_service_media para el detalle) y avanzalo con esa elección.',
      ].join('\n'),
      fixedMessages: ['ofertaCertificacion'],
      routes: [
        {
          id: 'quiere-certificarse',
          when: 'El alumno quiere avanzar con la certificación que se le ofreció.',
          to: 'mostrar_beneficios',
        },
        {
          id: 'prefiere-curso',
          when: 'El alumno prefiere un curso concreto en vez de la certificación y quiere inscribirse.',
          to: 'mostrar_beneficios',
        },
      ],
    },

    // Entre "ya eligió" y "dame tus datos": le muestra lo que recibe al
    // terminar antes de pedirle el nombre. Cruzan los dos caminos.
    {
      node: 'mostrar_beneficios',
      extraInstructions: [
        'Mandá la galería con send_fixed_message:',
        '- "beneficiosCertificado" si eligió una certificación.',
        '- "beneficiosCurso" si eligió un curso.',
      ].join('\n'),
      fixedMessages: ['beneficiosCurso', 'beneficiosCertificado'],
      routes: [
        {
          id: 'continua',
          when: 'El alumno quiere seguir con la inscripción después de ver la galería.',
          to: 'collect_data',
        },
      ],
    },

    {
      node: 'collect_data',
      extraInstructions: [
        'Según lo que eligió:',
        '- Si eligió una CERTIFICACIÓN, dale los requisitos tal cual: 1. Envíame la foto de tu DNI, ambas caras, para realizar todos tus documentos. 2. Te enviaré los certificados para que verifiques que tus datos son correctos. 3. Realizas el pago por Yape, Plin, transferencia bancaria o depósito.',
        '- Si eligió un CURSO: pedile que te mande la captura del pago del curso, con el precio que ya le diste.',
        'Guardá el curso o la certificación elegida con su nombre exacto de la lista.',
      ].join('\n'),
      // Con la primera foto (DNI o voucher): se la reenvía al dueño y Emma se
      // pausa en ese chat. El dueño la vuelve a prender desde el Inbox.
      onImage: { forward: true, pause: true },
    },

    { node: 'confirmed' },
  ],

  fixedMessages: {
    // {precio} sale del servicio elegido en el panel: si el dueño cambia el precio
    // de una certificación, la oferta cambia sola. La foto del carnet se sube
    // desde /asistente ("Fotos de tus mensajes automáticos") — no vive acá.
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
      images: true,
    },
    // Las dos galerías de beneficios se suben desde el panel — el instituto
    // todavía no cargó las fotos; send_fixed_message manda el texto solo hasta
    // que lo haga.
    beneficiosCurso: {
      when: 'Eligió un CURSO y ya le mostraste la ruta de cierre.',
      text: 'Esto es lo que vas a tener al terminar tu curso:',
      images: true,
    },
    beneficiosCertificado: {
      when: 'Eligió una CERTIFICACIÓN y ya le mostraste la ruta de cierre.',
      text: 'Esto es lo que vas a tener con tu certificación:',
      images: true,
    },
  },
})
