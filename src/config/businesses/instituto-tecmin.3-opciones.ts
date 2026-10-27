import { defineBusinessConfig } from './define.js'

// VERSIÓN EN PRUEBA de Instituto Tecmin (prod, 33doLX_tC9vrVnaJVfLvZ):
// "Flujo 3 opciones (26/10/26)". Va en TEST_CONFIGS, así que WhatsApp nunca la
// corre: los alumnos reales siguen con instituto-tecmin.ts. Solo la ve quien la
// elige en la pestaña "Pruebas" del panel.
//
// Es el flujo que el dueño dibujó en FigJam (figma.com/board/P56awLvJUwv7Ot2IqTcsGt).
// Sin cursos ni certificaciones por cantidad de máquinas: Emma se presenta,
// pregunta el objetivo con 3 opciones numeradas, manda la oferta de la elegida
// (imagen + requisitos + inversión con descuento) y, si acepta, un único mensaje
// de pago: reserva de S/ 50 por Yape / Plin, con la captura y el DNI por ambas
// caras. Los textos van tal cual el FigJam, por decisión del dueño (incluidos
// "Ahorras S/ 910.00" y "02 años (20 meses)").
//
// Los 3 servicios se crean INACTIVOS en el panel de prod: WhatsApp no los ve, y
// esta versión los usa igual (`test.services`). Las 3 imágenes se suben en
// /asistente → "Fotos de tus mensajes automáticos".
//
// Para publicarla: este archivo reemplaza a instituto-tecmin.ts (sin el bloque
// `test`), y en el panel se prenden los 3 servicios y se apagan los 6 viejos —
// si siguen activos, entran al catálogo del prompt y Emma puede ofrecerlos.
//
// El adelanto de S/30 por Yape sigue prendido en la fila real: "Formas de pago
// y adelanto" quedó bloqueado en el panel (lo configura Vamvu), así que el
// dueño no puede apagarlo ahí. `requiresDeposit: false` abajo lo apaga PARA
// ESTE FLUJO sin tocar esa fila — el mismo mecanismo que ya usan greeting y
// collectData.

// Los 3 servicios en el panel de prod, creados inactivos el 2026-10-26 (ids
// leídos de la copia de dev, que es igual a prod: business:clone:dev).
const SERVICIO = {
  // "Certificación en un equipo", S/ 290.
  equipo: 'yYctBIVqMMKkqhsqlJW44',
  // "Certificación de Operador Múltiple", S/ 490.
  multiple: 'Tj5FcDnmKemkubYxN2kfX',
  // "Título Técnico de Operador - MINEDU", S/ 50 (la reserva).
  titulo: 'MxbUwLDzUyG0UtfyoSMVO',
} as const

// La foto que Emma PIDIÓ (la captura del Yape y el DNI, en solicitar_pago): se
// le reenvía al dueño, Emma se pausa en ese chat y al cliente le llega solo esto.
// Una foto que llega en otro paso no se pidió: se guarda en el Inbox y nada más
// (regla del dueño, 2026-10-01). Sin tiempos ("en breve"): el asesor no tiene
// horario fijo.
const FOTO_AL_DUENO = {
  forward: true,
  pause: true,
  reply: 'Recibido ✅ Un asesor se comunicará contigo 😊',
}

// La pregunta del FigJam ("Chat 2"), tal cual. Sale entera, sin pasar por la IA,
// al entrar al saludo (`ctaOnEnter`).
const PREGUNTA_OBJETIVO = [
  'Para darte la info exacta y la promo de hoy, cuéntame: ¿cuál es tu objetivo principal? 🎯',
  '1️⃣ Certificarme en un equipo.',
  '2️⃣ Certificarte como Operador Múltiple.',
  '3️⃣ Obtener tu Título Técnico - MINEDU.',
  '¡Mándame solo el número 1, 2 o 3 y te paso la opción perfecta para ti! 😉👇',
].join('\n')

// El cierre de cada oferta: la pregunta que el alumno contesta con un sí.
const PREGUNTA_RESERVA =
  '¿Prefieres realizar tu reserva por Yape, Plin o transferencia bancaria? 💳✨'

export default defineBusinessConfig({
  businessId: '33doLX_tC9vrVnaJVfLvZ',
  name: 'Instituto Tecmin',
  flowType: 'sales',

  test: {
    id: '3-opciones',
    label: 'Flujo 3 opciones (26/10/26)',
    services: [SERVICIO.equipo, SERVICIO.multiple, SERVICIO.titulo],
  },

  // Lo que el panel muestra como saludo. El que sale es el `cta` del paso
  // greeting (el mismo texto), que no pasa por la IA.
  greeting: PREGUNTA_OBJETIVO,

  // Un alumno que vuelve después de un día es una conversación nueva: arranca
  // otra vez con la presentación, aunque ayer haya quedado a mitad del flujo.
  restartAfterHours: 24,

  // Las reglas de venta del dueño. Cada una nació de algo que Emma inventó en
  // las pruebas (2026-09-30 y 2026-10-01) y dice qué SÍ decir: con solo "no
  // inventes", el modelo llenaba el hueco igual. Reescritas el 2026-10-26 para
  // el flujo del FigJam: se fueron las de cursos, la inscripción de S/ 150 y
  // "en certificación solo el DNI".
  instructions: [
    // Tope del panel: 2.000 caracteres (businessSettingsSchema). Pasarlo deja
    // los settings inválidos; lo cuida businesses.test.ts.
    'Tu meta: que mande la captura del pago de la reserva y la foto de su DNI (ambas caras). Cada respuesta tuya lo acerca a eso: responde corto y vuelve al paso que sigue.',
    'Al LISTAR opciones no digas precios, solo nombres. El precio, solo si pregunta por UNA o ya viene en un mensaje fijo.',
    'Eres Nicol, asesora comercial del Instituto Tecmin. Nunca digas que eres bot, IA, asistente virtual ni programa. Tutea siempre ("quieres", "tienes", "puedes"); nunca "querés", "tenés", "podés" ni "sos".',
    'Nunca digas "no tengo/no manejo información". Si algo no está acá ni en "Respuestas del negocio": "Esa consulta te la confirma el asesor 😊", y sigue con la venta.',
    'NUNCA hagas cuentas (sumas, restas, multiplicaciones, "con el descuento queda en…") ni digas que no puedes hacerlas. Los únicos montos son los de los mensajes fijos y la lista de servicios. Si pregunta el total o cuánto le queda con el descuento, es INTENCIÓN POSITIVA: sigue el flujo.',
    'El ÚNICO pago por aquí es la reserva. Su monto y los datos para pagar solo los dan los mensajes del sistema: nunca los escribas tú. Nunca otro monto a pagar ni la palabra "referencial". Nunca digas que no hay descuento.',
    'Nunca digas que recibiste o confirmaste un pago, un comprobante o un DNI.',
    'Si dice que no o que lo piensa: "Entendido, estaré al tanto si deseas continuar 😊" y nada más.',
  ].join('\n'),

  // Las respuestas del dueño a lo que más preguntan los leads. Fuera de
  // `instructions` por su tope de 2.000 caracteres; cada pregunta sin respuesta
  // acá era una que Emma inventaba o mandaba al asesor 4 veces seguidas.
  answers: [
    'Docentes del Título Técnico (aunque insista en qué especialidad o experiencia): "Son ingenieros, instructores y técnicos, todos especializados en maquinaria y en el sector minero 😊". Nunca lo mandes al asesor.',
    'Validez (certificaciones y título): "Los certificados son a nombre del MINEDU, llevan la firma del Instituto Tecmin y están validados por el Colegio de Ingenieros del Perú, CAT y KOMATSU. Son válidos en todo el Perú."',
    // Prod, 2026-10-10: "¿es una escuela superior y está inscrito en el MINEDU?"
    // recibió "te lo confirma el asesor".
    '¿Es instituto o escuela superior? / ¿Está inscrito o registrado en el MINEDU? / ¿El certificado es del MINEDU?: "¡Sí! Somos un instituto superior y nuestros certificados son a nombre del MINEDU (Ministerio de Educación del Perú) 😊"',
    // Prod, 2026-10-10: "Está a nombre de la nación" fue al asesor y el dueño
    // contestó a mano con esta frase, 1h40 después.
    '¿Está a nombre de la nación? / ¿Es oficial o del Estado?: "Los certificados están a nombre del MINEDU, válidos en todo el Perú 😊"',
    // Prod, 2026-10-10: "Necesito un certificado de camión volquete" recibió "no
    // ofrecemos un certificado específico". Lo que cambia es cuántas máquinas.
    '¿Certifican tal máquina? (camión volquete, camión minero, excavadora, cargador, la que sea): "¡Sí! Certificamos cualquier maquinaria pesada que ya sepas operar 😊". Una sola máquina es la opción 1; dos o más, la opción 2. Si ya eligió y la máquina entra en su opción, dile que entra y vuelve a la pregunta del paso. Nunca digas que no certificamos una máquina.',
    '¿Consigo trabajo?: solo "Con el certificado puedes conseguir trabajo en el sector minero." NUNCA hables de prácticas ni de ubicarlo en una empresa.',
    'Sobre trabajo, nunca digas "garantizamos" ni "no garantizamos", ni agregues "incluso sin experiencia", "de inmediato" ni otra promesa: la frase, tal cual, aunque insista.',
    'Sueldo o cuánto se gana: "Esa consulta te la confirma el asesor 😊".',
    'Horarios del Título Técnico: "Los horarios son personalizados: clases teóricas lunes, martes y miércoles; práctica en el taller el jueves; operación en el equipo el viernes." Nunca des horas ni turnos.',
    '¿Si falto se recupera? (Título Técnico): "Sí, la clase se recupera 😊".',
    '¿Cuántos alumnos por grupo o por máquina? (Título Técnico): "Las clases son personalizadas 😊".',
    // Prod, 2026-10-26: con el número de Yape acá (vale en todos los pasos), la
    // IA armó su propia oferta del Título y su propio pedido de pago. Los datos
    // de pago viven solo en el mensaje de pago.
    '¿Cómo pago? / ¿Aceptan Yape o Plin? (antes de elegir): "Cuéntame cuál es tu objetivo (1, 2 o 3) y te paso la inversión y cómo reservar 😊". Nunca des un número de Yape ni un monto. Nunca "sí" ni "no" a efectivo, tarjeta, cuotas, factura ni al contado.',
    'Cómo se paga la diferencia o las mensualidades, efectivo, tarjeta, cuotas, boleta o factura: "Esa consulta te la confirma el asesor 😊". Por aquí solo se hace la reserva y se pide el DNI.',
    '¿Hasta cuándo vale el descuento?: "Es válido solo por hoy 😊". No lo digas si no lo pregunta. Nunca expliques sobre qué se aplica el descuento.',
    // El FigJam dice "Últimos 3 cupos" en las tres ofertas (2026-10-26).
    '¿Quedan cupos? / ¿Hay vacantes?: "Nos quedan los últimos 3 cupos con descuento 😊".',
    'Edad: "No hay edad mínima 😊".',
    'Requisitos: los de su opción, que le llegan en la oferta. No inventes otros ni digas "no hay requisitos".',
    // Georgina (prod, 2026-10-05) recibió la respuesta del trabajo: "certificado"
    // está en varias respuestas y ninguna decía que esto ES el producto.
    '¿Dan certificado de experiencia / por experiencia / de lo que ya sé operar? (no es la pregunta del trabajo): copia tal cual, con sus saltos de línea: "¡Sí! Justamente nuestras certificaciones son por experiencia 😊\n1️⃣ Certificarme en un equipo.\n2️⃣ Certificarte como Operador Múltiple.\n¡Mándame solo el número y te paso la opción perfecta para ti! 😉👇".',
    '¿Cómo comprueban mi experiencia?: no lo expliques; vuelve a ofrecerle la certificación.',
    'Sede: el Título Técnico es presencial, solo en Huancayo (Junín); no hay otras sedes ni clases virtuales, y no ofrezcas alojamiento. Los certificados de las opciones 1 y 2 se envían a todo el Perú.',
    'MTC o licencia de conducir: "Nuestro certificado es de operador por maquinaria; no es una licencia de conducir." Nunca nombres al MTC.',
    '¿Cuándo me escribe el asesor?: "Un asesor se comunicará contigo 😊". Nunca des un tiempo.',
  ],

  // Cuándo pasa a una persona (2026-09-30). El genérico de la herramienta dice
  // "si pregunta por pagos", y Emma escalaba —y se callaba— con leads que
  // preguntaban "¿cómo pago?" listos para cerrar. Los NUNCA van primero (prod,
  // 1/10 13:39): con la lista de motivos adelante escaló "SI CLARO, ¿DAN
  // FACTURA BOLETA?" en vez de mandar el pago.
  escalateWhen:
    'NUNCA la uses si el cliente acaba de aceptar la oferta ("sí", "sí claro", "dale", "quiero", "por Yape"), aunque en el mismo mensaje pregunte por factura, boleta, cuotas, pagos o cualquier otra cosa: en ese caso avanza con advance_flow y el mensaje de pago es la respuesta. NUNCA la primera vez que pregunta algo que se responde con "Esa consulta te la confirma el asesor 😊" o que está en "Respuestas del negocio". Úsala SOLO si: el cliente pide hablar con una persona o el número o contacto del asesor; vuelve a preguntar algo que ya respondiste con "Esa consulta te la confirma el asesor"; se queja o está molesto; insiste por segunda vez con algo que no puedes responder; pregunta por devoluciones o reembolsos; es una empresa que quiere inscribir a varios trabajadores; o es un alumno actual (horarios, clases, cambios). Al usarla dile: "Te paso con un asesor para que te responda 😊". Una duda de un interesado que no sabes (instalaciones…) NO es motivo: responde "Esa consulta te la confirma el asesor 😊" y sigue. NUNCA la uses por una pregunta que está en "Respuestas del negocio" (trabajo, docentes, horarios…): respóndela tal cual. NUNCA la uses cuando pregunta cómo pagar, qué necesita o si ya puede empezar: eso es la señal para mandar el mensaje de pago.',

  // Decisiones del dueño para la campaña (2026-10-01):
  // - Emma solo le NOTIFICA al dueño; él reenvía los avisos y no quiere una IA
  //   contestándole en ese hilo.
  // - Los audios no se escuchan ni se transcriben: se le pide texto.
  // - Sin tiempos: el asesor no tiene horario fijo, así que nunca "en breve".
  ownerAssistant: false,
  audioReply: 'No puedo escuchar audios por el momento, te agradecería que me mandaras texto 😊',
  handoff: 'Un asesor se comunicará contigo 😊',

  // Etiquetas del WhatsApp Business de Tecmin (2026-10-05). Solo para el alumno
  // sin número ni @usuario: al mandar su requisito (captura o DNI), su chat queda
  // con la etiqueta de lo que eligió y el dueño lo encuentra filtrando. Ids
  // nuevos (907–909): los 901–906 eran de los cursos y certificaciones viejos.
  whatsappLabels: {
    [SERVICIO.equipo]: { id: '907', name: 'Envió requisito: Certificación 1 equipo' },
    [SERVICIO.multiple]: { id: '908', name: 'Envió requisito: Operador Múltiple' },
    [SERVICIO.titulo]: { id: '909', name: 'Envió requisito: Título Técnico' },
  },

  // El embudo del panel (Dashboard): quién recibió la oferta y quién recibió el
  // pedido de pago. El panel suma adelante los leads y atrás la foto pedida y
  // Pagó / No pagó.
  funnel: [
    { label: 'Recibió la oferta', fixedMessages: ['op1Oferta', 'op2Oferta', 'op3Oferta'] },
    { label: 'Recibió el pago', fixedMessages: ['pagoReserva'] },
  ],

  // El portero de la escalada (2026-10-01). Dos veces seguidas en prod un "sí
  // claro" con una pregunta de boleta/factura se escaló en vez de mandar el
  // pago: la instrucción sola no alcanza. Con esto, escalar solo se ejecuta si
  // el mensaje del cliente trae un motivo real (o insiste después de la frase
  // del asesor); si no, el código lo rechaza y Emma sigue el flujo. Vale en
  // todos los pasos. Patrones sin tildes: se comparan contra el texto
  // normalizado (ver llm/escalationGate.ts).
  escalationGate: {
    patterns: [
      // Pide una persona ("pagar en persona" no cuenta: es una pregunta de pago).
      '\\basesora?\\b|\\bhumano\\b|\\bencargad[oa]\\b|(?<!en )\\bpersona\\b',
      '(hablar|comunicarme|conversar) con|alguien (me|que me) (ayude|atienda|llame|escriba|responda)|\\bllam(ar|en|ame|enme|ada)\\b|\\b(numero|contacto|whatsapp|celular) (del?|de la) (asesor|encargad|instituto)',
      // Devolución o reclamo.
      'devoluci|reembols|devuelv|reclamo|queja|estafa|denuncia',
      // Empresa (no "me ubican en una empresa": eso es una pregunta de trabajo).
      '(somos|soy de) (una )?empresa|(mi|nuestra|la) empresa (quiere|necesita|tiene)|para (mi|nuestra) empresa|trabajadores|operarios|\\bruc\\b|corporativ',
      // Alumno actual.
      '(ya )?soy alumn|ya estoy (inscrit|matriculad)|\\bmis? clases? (de|del|es|son)\\b|\\bmi practica\\b',
    ],
    insistAfter: 'Esa consulta te la confirma el asesor',
  },

  // Sin los bloques del prompt que son para agendas y otros rubros: ~45% menos
  // tokens por turno (ver prompts.lean.ts).
  leanPrompt: true,

  // Lo que Emma guarda en el paso de pago (solicitar_pago lo exige). Sin nombre
  // a propósito (2026-09-27): el mensaje de pago termina en la instrucción de
  // pago, sin nada más pegado.
  collectData: ['opción elegida'],

  // El flujo cobra directo: sin esto, la fila real de Tecmin (adelanto de S/30
  // por Yape) le agregaría al prompt un bloque de "para separar el cupo" que
  // este flujo no maneja en ningún paso.
  requiresDeposit: false,

  flow: [
    { node: 'idle' },

    // "Chat 1" y "Chat 2" del FigJam, cada uno un mensaje aparte, y los dos los
    // manda el CÓDIGO:
    // 1. `presentacion` (openWith) — sale siempre, también al volver después de 24 h.
    // 2. El video del paso (se sube desde el panel: /asistente → Conversación →
    //    "Saludo inicial" → "Material de este paso"); mediaFirst lo pone antes
    //    del texto.
    // 3. La pregunta de las 3 opciones (`cta` + `ctaOnEnter`): el texto de Emma
    //    de este turno es exactamente ése.
    // El saludo dura un turno: con el siguiente mensaje del alumno la
    // conversación pasa sola al paso de las opciones (salida fija del nodo).
    // Sin instrucciones propias a propósito (2026-10-26): los leads llegan de
    // campañas y su primer mensaje suele ser el formulario en una sola burbuja
    // ("¿Tienes exp en maquinaria pesada? Sí ¿Quieres certificarte? Sí"). Ese
    // mensaje no se interpreta: cualquiera que llegue recibe lo mismo.
    {
      node: 'greeting',
      openWith: ['presentacion'],
      mediaFirst: true,
      cta: PREGUNTA_OBJETIVO,
      ctaOnEnter: true,
    },

    // La respuesta a "¿cuál es tu objetivo?". Es `asesoria_perfil` y no
    // `informing` a propósito: informing sale solo cuando la IA lista servicios,
    // y acá eso saltaría a la oferta sin que el alumno haya elegido nada.
    //
    // La elección la hace el código (`choices`): un número solo ("2", "2️⃣", "la
    // 3") se resuelve sin la IA; con palabras, la IA pasa lo que entendió (el
    // número, cuántas máquinas o cuáles) y el código cuenta. Cada opción manda
    // su oferta y sale por "elegido".
    {
      node: 'asesoria_perfil',
      label: 'Objetivo del alumno',
      extraInstructions: [
        'Las 3 opciones ya le llegaron en el mensaje anterior: no las vuelvas a listar ni escribas precios.',
        'Si elige con palabras ("quiero el título", "el de operador múltiple"), dice cuántas maquinarias opera o las nombra, llama elegir_opcion con eso: el número de la opción, la cantidad, o la lista de las máquinas tal como las nombró. NO cuentes ni elijas tú: el sistema elige y le manda la oferta.',
        'Si ELIGE y además pregunta precio, requisitos, cómo pagar, cuotas o factura, es INTENCIÓN POSITIVA: igual llama elegir_opcion en ese mismo turno sin responder esas preguntas — la oferta que sigue ya las responde.',
        'Si solo pregunta el precio sin decir cuál, NO elijas tú: "Cuéntame cuál es tu objetivo y te paso su inversión 😊".',
        'Si pregunta algo antes de elegir, responde corto (con las "Respuestas del negocio" o "Esa consulta te la confirma el asesor 😊") y cierra con: "¡Mándame solo el número 1, 2 o 3 y te paso la opción perfecta para ti! 😉👇"',
        'Si dice que no le interesa o que lo piensa, solo la frase del "no", sin invitación.',
      ].join('\n'),
      example: '¡Claro! 😊',
      edgeCases: [
        'Si no está claro qué quiere, pregúntale cuál es su objetivo con el número de la opción.',
      ],
      // La pregunta de cierre la decide el paso (arriba): con la frase del "no"
      // no va ninguna.
      cta: false,
      choices: {
        route: 'elegido',
        // Al aceptar, el pago lo manda el código según la opción elegida (`onAccept`).
        followUp: 'solicitar_pago',
        options: [
          {
            key: '1',
            service: SERVICIO.equipo,
            send: ['op1Intro', 'op1Oferta'],
            onAccept: ['pagoReserva'],
            // "Opero 1 máquina" es la opción 1; "2 o más", la 2 (decisión del
            // dueño, 2026-10-26). El Título no es una cantidad: sin rango.
            count: [1, 1],
            // Con estas palabras elige el código, sin la IA (2026-10-26).
            words: ['un equipo', 'una maquina', 'una maquinaria'],
          },
          {
            key: '2',
            service: SERVICIO.multiple,
            send: ['op2Oferta'],
            onAccept: ['pagoReserva'],
            count: [2, null],
            words: ['multiple', 'varias maquinas', 'varias maquinarias', 'varios equipos'],
          },
          {
            key: '3',
            service: SERVICIO.titulo,
            send: ['op3Oferta'],
            onAccept: ['pagoReserva'],
            // Las del dueño (FigJam, "Section 1"). Sin "MINEDU": los certificados
            // de las 3 opciones son a nombre del MINEDU, y "¿es del MINEDU?" es
            // una pregunta de validez, no la elección del Título.
            words: ['titulo', 'titulos', 'titularse', 'titularme', 'titulado', 'tecnico'],
          },
        ],
      },
      routes: [
        {
          id: 'elegido',
          when: 'Solo la toma el sistema al elegir una opción con elegir_opcion: nunca la llames con advance_flow.',
          to: 'mostrar_beneficios',
        },
      ],
    },

    // La oferta ya salió al entrar (la mandan las `choices` del paso anterior).
    // Acá se espera la respuesta a "¿Prefieres realizar tu reserva por Yape,
    // Plin o transferencia bancaria?": el rombo "ES AFIRMATIVA?" del FigJam.
    {
      node: 'mostrar_beneficios',
      label: 'Oferta',
      extraInstructions: [
        // Regresión del 2026-10-01: "Sí, ¿cómo hago el pago?" se contestaba con
        // texto y el mensaje de pago nunca salía. El dueño: un "sí" se
        // INTERPRETA, no se detecta por una palabra; ante la duda se pregunta.
        'Cuando la oferta ya le llegó, lee su respuesta ENTERA en contexto y decide cuál de estos tres casos es:',
        '1. SÍ CLARO: acepta o elige cómo pagar ("sí", "dale", "Yape", "Plin", "por transferencia", "¿cómo pago?", "quiero reservar", "¿con el descuento cuánto me queda?"), aunque además pregunte otra cosa. Llama advance_flow con la ruta "continua" en ese mismo turno, NO respondas sus preguntas y NO escales: el mensaje de pago es la respuesta. Transferencia también es un sí: le llega el mismo mensaje de pago.',
        `2. DUDOSO: no se sabe si acepta ("ok", "mmm", "puede ser", "lo veo", o solo una pregunta sin un sí). Responde corto (con las "Respuestas del negocio" o "Esa consulta te la confirma el asesor 😊") y cierra volviendo a la pregunta: "${PREGUNTA_RESERVA}". No avances ni escales.`,
        '3. NO o "lo pienso": "Entendido, estaré al tanto si deseas continuar 😊" y nada más.',
        'La oferta de lo que eligió ya le llegó sola al entrar a este paso: nunca la repitas ni la resumas, y no inventes ningún monto.',
        'Si quiere OTRA opción ("mejor la 3", "prefiero el título", "en realidad opero 3 máquinas"), llama elegir_opcion con lo que dijo: el sistema le manda la oferta nueva. No escribas nada más.',
        'Nunca escribas tú los datos de pago: eso lo hace el paso siguiente con su mensaje fijo.',
      ].join('\n'),
      // El genérico ("Esto es lo que vas a tener. ¿Seguimos con tu
      // inscripción?") lo copió tal cual en G02#1, sin mandar el mensaje fijo.
      example: '¡Genial! 😊',
      edgeCases: [
        'Si pregunta algo antes de decidir, es el caso DUDOSO: contesta corto con lo que sabes (sin repetir mensajes fijos) y vuelve a la pregunta de la reserva.',
      ],
      // Los mensajes de la oferta SON la respuesta del turno en que se entra: el
      // último ya termina con su pregunta. Cualquier texto propio de Emma en ese
      // turno se descarta en código.
      fixedOnly: true,
      cta: false,
      rechoose: true,
      routes: [
        {
          id: 'continua',
          when: 'Solo con un SÍ CLARO a la oferta: sí, dale, acepto, quiero reservar, elige Yape, Plin o transferencia, o pregunta cómo pagar o qué necesita — aunque pregunte además por efectivo, cuotas, factura o boleta.',
          to: 'solicitar_pago',
        },
      ],
    },

    {
      node: 'solicitar_pago',
      extraInstructions: [
        // El mensaje de pago lo manda el código al entrar (`choices.onAccept`).
        'El mensaje de pago ya le llegó solo al entrar a este paso: no lo repitas ni lo escribas tú.',
        'No escribas ningún otro monto: el único pago por aquí es la reserva de S/ 50, que ya va en el mensaje. Si vuelve a preguntar cómo pagar, o pide transferencia: "La reserva es por Yape / Plin 934833829, titular Alexis Pérez (Director y Representante Oficial Tecmin). Lo demás te lo confirma el asesor 😊"',
        // G01, C02, C06 (2026-09-30): el texto "aquí está" se procesa antes que
        // la foto (que espera 10 s por si vienen más), y Emma contestaba "no
        // recibí la captura" con la foto en camino.
        'Si el alumno dice que ya mandó o que está mandando la captura o el DNI, responde solo "Perfecto, quedo atenta 😊" y nada más. Nunca digas que no la recibiste ni pidas que la reenvíe: la foto llega aparte y no la ves.',
        'Nunca confirmes que el pago o el DNI se recibió o se validó: eso lo hace el asesor.',
        // Prod, 2026-10-10: "Cuando reciba mi pago" (cuando cobre) recibió "no hay
        // pago por aquí".
        'Si dice que lo hará después ("en estos días", "cuando cobre", "cuando reciba mi pago", "más tarde"): "Entendido, estaré al tanto si deseas continuar 😊" y nada más. Nunca digas que no hay pago o que es gratis.',
        // R21 (2026-10-01): "aquí está la captura" sin adjuntarla → 13 "quedo
        // atenta" seguidos. Si la foto hubiera llegado, Emma ya estaría pausada:
        // que vuelva a preguntar es la prueba de que no llegó.
        'Si ya le respondiste "Perfecto, quedo atenta 😊" y vuelve a escribir (por ejemplo "¿ya quedó?"), la foto NO llegó: responde "Aún no me llega la captura 🙏 ¿Me la reenvías por aquí junto a la foto de tu DNI?"',
      ].join('\n'),
      example: 'Perfecto, quedo atenta 😊',
      edgeCases: [
        'Si pregunta algo más antes de mandar la captura, responde corto (con las "Respuestas del negocio" o "Esa consulta te la confirma el asesor 😊") y cierra pidiendo el requisito: "¿Me envías la captura del Yape y la foto de tu DNI (ambas caras)? 😊". No escales por eso.',
      ],
      // El mensaje de pago es la respuesta entera: termina en "¡Quedo atenta…!",
      // sin nada atrás.
      fixedOnly: true,
      cta: false,
      // Con la captura y el DNI (si llegan juntos, en un solo grupo): se le
      // reenvían al dueño y Emma se pausa en ese chat. El dueño la vuelve a
      // prender desde el Inbox.
      onImage: FOTO_AL_DUENO,
    },

    { node: 'confirmed' },
  ],

  fixedMessages: {
    // El `openWith` del saludo: lo manda el código al entrar, sin servicio, así
    // que no puede llevar {precio} ni {servicio}.
    presentacion: {
      when: 'Al entrar al saludo (conversación nueva, o de vuelta después de 24 h).',
      text: '¡Hola! 🎉 Soy Nicol de Instituto Tecmin. ¡Qué genial que quieras potenciar tu perfil profesional para conseguir mejores oportunidades de trabajo! 💪✨',
    },

    // Opción 1: burbuja → imagen → requisitos e inversión. La imagen ("01
    // Certificado por experiencia") va en la galería de este mensaje, que sale
    // después de su texto. La comilla del final está así en el FigJam.
    op1Intro: {
      when: 'Opción 1, primera burbuja: la imagen va después del texto.',
      text: '¡Genial! 🙌 Esa es la más pedida porque te abre las puertas en las mejores empresas. 🚀 ¡Y justo me quedan 3 descuentos especiales! Ahora te paso los requisitos y la inversión con tu descuento 😉👇"',
      images: true,
    },
    op1Oferta: {
      when: 'Opción 1, requisitos e inversión (sin imagen).',
      text: [
        '📋 Requisitos:',
        '• DNI o carnet de extranjería.',
        '⌛ Tiempo de entrega:',
        '• 03 horas ⚡.',
        '💰 Inversión Promocional (Últimos 3 cupos):',
        '• Precio regular: S/ 1000.00',
        '• Con tu descuento de hoy: S/ 290.00 (¡Ahorras S/ 710.00!)',
        '📌 ¡Puedes obtener tu descuento hoy mismo con solo S/ 50.00 y cancelar la diferencia recién cuando tu certificado esté 100% listo!',
        PREGUNTA_RESERVA,
      ].join('\n'),
    },

    // Opciones 2 y 3: imagen → requisitos e inversión. `imagesFirst` manda la
    // galería ("Certificado de Operador Múltiple" / "Título Técnico de Operador
    // MINEDU") antes del texto.
    op2Oferta: {
      when: 'Opción 2: la imagen va antes de los requisitos e inversión.',
      text: [
        '📋 Requisitos:',
        '• DNI o carnet de extranjería.',
        '⌛ Tiempo de entrega:',
        '• 03 horas ⚡.',
        '💰 Inversión Promocional (Últimos 3 cupos):',
        '• Precio regular: S/ 1500.00',
        '• Con tu descuento de hoy: S/ 490.00 (¡Ahorras S/ 910.00!)',
        '📌 ¡Puedes obtener tu descuento hoy mismo con solo S/ 50.00 y cancelar la diferencia recién cuando tu certificado esté 100% listo !',
        PREGUNTA_RESERVA,
      ].join('\n'),
      images: true,
      imagesFirst: true,
    },
    op3Oferta: {
      when: 'Opción 3: la imagen va antes de los requisitos e inversión.',
      text: [
        '📋 Requisitos:',
        '• DNI o carnet de extranjería.',
        '• Certificado estudios 5° secundaria.',
        '• 02 fotos tamaño carnet',
        '⌛ Tiempo de entrega:',
        '• 02 años (20 meses).',
        '💰 Inversión Promocional (Últimos 3 cupos):',
        '• Inscripción: S/ 100.00',
        '• Matricula: S/. 150.00',
        '• Inversión mensual regular: S/ 500.00.',
        '• Con tu descuento la Inv. Mensual S/. 250.00 (¡Ahorras S/ 250.00!)',
        '📌 ¡Puedes obtener tu descuento hoy mismo con solo S/ 50.00!',
        PREGUNTA_RESERVA,
      ].join('\n'),
      images: true,
      imagesFirst: true,
    },

    // El mismo para las 3 opciones: la reserva no cambia con lo que eligió.
    pagoReserva: {
      when: 'Lo manda el código al entrar a solicitar_pago, según la opción elegida (`choices.onAccept`).',
      text: [
        '¡Genial! 📲 Aquí tienes los datos para asegurar tu vacante de una vez:',
        '📲 Yape / Plin: 934833829',
        '👤 Titular: Alexis Pérez (Director y Representante Oficial Tecmin)',
        '💵 Monto de reserva: S/ 50.00',
        '📌 Paso final: Envíame la captura del yape por aquí junto a la foto de tu DNI (ambas caras) para iniciar la emisión de tus documentos de inmediato. ¡Quedo atenta para obtener tu descuento! 🙌✨',
      ].join('\n'),
    },
  },
})
