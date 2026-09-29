import { defineBusinessConfig } from "./define.js";

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
// Las 3 certificaciones (2026-09-25, ya creadas en el panel de Tecmin), por
// tramo: 1 a 2 maquinarias S/295, 3 a 4 maquinarias S/350, 5 maquinarias o más
// S/500. Desde 2026-09-29 van a llamarse "Certificación - 1 a 2 maquinarias",
// etc. — el renombre se hace en el panel (/servicios), no acá. asesoria_perfil
// las mapea por el TRAMO y no por el nombre exacto, así funciona antes y
// después del renombre; sin ellas, send_fixed_message fallaría.
//
// El adelanto de S/30 por Yape sigue prendido en la fila real: "Formas de pago
// y adelanto" quedó bloqueado en el panel (lo configura Vamvu), así que el
// dueño no puede apagarlo ahí. `requiresDeposit: false` abajo lo apaga PARA
// ESTE FLUJO sin tocar esa fila — el mismo mecanismo que ya usan greeting y
// collectData.

export default defineBusinessConfig({
  businessId: "4aIwSdMZBY12B06MSSovj",
  name: "Instituto Tecmin",
  flowType: "sales",

  // El Bloque 2 de la presentación, tal cual: lo escribe Emma después del
  // Bloque 1 (`presentacion`, que manda el código al entrar al saludo). Hace la
  // pregunta de la bifurcación, así que no se le agrega otra invitación.
  greeting:
    "Cuéntame, ¿tienes experiencia operando maquinaria o deseas realizar un curso desde cero?",

  // Un alumno que vuelve después de un día es una conversación nueva: arranca
  // otra vez con la presentación, aunque ayer haya quedado a mitad del flujo.
  restartAfterHours: 24,

  // Por ahora, sin precio en el listado (2026-09-26): cuando lista VARIAS
  // opciones no dice el monto de cada una — solo cuando el cliente pregunta por
  // UNA en particular, o cuando ya lo trae un mensaje fijo. Revertir borrando
  // esto: el motor por defecto sí muestra precio en el listado.
  //
  // La segunda frase (2026-09-29): Emma le inventó "un adelanto de S/ 100" a un
  // alumno de certificación. Los montos de pago solo existen en los mensajes
  // fijos; lo que lo garantiza es el motor (un paso fixedOnly tiene que mandar
  // el suyo), esto es una red más.
  instructions: [
    "Cuando LISTES varias opciones juntas (cursos o certificaciones), no digas el precio de cada una — solo el nombre. El precio se lo das recién cuando pregunta por UNA en particular, o cuando ya viene en un mensaje fijo.",
    "Nunca digas con tus palabras un monto de pago, un adelanto ni datos de pago (Yape, número, titular): eso sale solo en los mensajes fijos.",
  ].join("\n"),

  // Lo que Emma pide y guarda en collect_data. Sin 'nombre completo' a
  // propósito (2026-09-27): el dueño no lo quiere pedir en este paso — el
  // mensaje de pago tiene que terminar en la instrucción de pago, sin nada
  // más pegado.
  collectData: ["curso o certificación elegida"],

  // El flujo nuevo cobra directo: sin esto, la fila real de Tecmin (adelanto
  // de S/30 por Yape) le agregaría al prompt un bloque de "para separar el
  // cupo" que este flujo no maneja en ningún paso.
  requiresDeposit: false,

  flow: [
    { node: "idle" },

    // La presentación en dos bloques (2026-09-29), cada uno un mensaje aparte:
    // 1. `presentacion`, que manda el CÓDIGO al entrar a este paso — sale
    //    siempre, también cuando el alumno vuelve después de 24 h.
    // 2. El saludo configurado (la pregunta), que escribe Emma.
    // El video se sube desde el panel (/asistente → Conversación → "Saludo
    // inicial" → "Material de este paso") y queda entre los dos: así la
    // pregunta queda al final, lista para contestar.
    //
    // Las rutas y el "no uses show_services" son el arreglo del bug del
    // 2026-09-29: un alumno abrió con "info del certificado", Emma llamó
    // show_services acá, y esa tool siempre lleva a listado_servicios (el paso
    // de CURSOS) — la respuesta del certificado salió con "¿En qué curso estás
    // interesado? A. Básico…" pegado al final.
    {
      node: "greeting",
      openWith: ["presentacion"],
      mediaFirst: true,
      // El Bloque 2 ya es la pregunta. Sin esto, al volver después de 24 h (ya
      // hay historial) la invitación rotativa se le pegaba atrás.
      cta: false,
      extraInstructions: [
        "La presentación (tu nombre y el instituto) ya le llegó sola, antes de tu mensaje: no te vuelvas a presentar.",
        '- Si el alumno solo saludó o todavía no dijo qué busca, tu mensaje es exactamente: "Cuéntame, ¿tienes experiencia operando maquinaria o deseas realizar un curso desde cero?"',
        "- Si ya dijo qué busca, NO le hagas esa pregunta: llamá advance_flow con la ruta que corresponda en este mismo turno y respondé desde ese paso.",
        "- No uses show_services en este paso: los cursos y las certificaciones se muestran en su propio paso.",
      ].join("\n"),
      routes: [
        {
          id: "con-experiencia",
          when: "El alumno pregunta por certificación o certificados, o dice que tiene experiencia operando maquinaria.",
          to: "asesoria_perfil",
        },
        {
          id: "sin-experiencia",
          when: "El alumno pregunta por los cursos, quiere empezar desde cero o dice que no tiene experiencia operando maquinaria.",
          to: "listado_servicios",
        },
      ],
    },

    // La bifurcación del diagrama: acá solo se decide el camino. Lo que se le
    // ofrece a cada uno vive en su propio paso.
    {
      node: "informing",
      extraInstructions: [
        "El saludo ya le preguntó si tiene experiencia operando maquinaria o si quiere un curso desde cero. Tu único trabajo acá es saber la respuesta.",
        "- Si TIENE experiencia, o pregunta por certificación: pasá al paso de certificación.",
        "- Si NO tiene experiencia, o pregunta por los cursos: pasá al paso de cursos.",
        "- No uses show_services en este paso: los cursos y las certificaciones se muestran en su propio paso.",
        "- Si la respuesta no es clara, preguntale de nuevo si tiene experiencia operando maquinaria.",
        "- Si antes de contestar pregunta por la ubicación o cómo llegar, dale la dirección y el link de Google Maps de arriba en una línea, y volvé a preguntarle si tiene experiencia.",
      ].join("\n"),
      routes: [
        {
          id: "con-experiencia",
          when: "El alumno dice que tiene experiencia operando maquinaria, o pregunta por certificación.",
          to: "asesoria_perfil",
        },
        {
          id: "sin-experiencia",
          when: "El alumno no tiene experiencia operando maquinaria, o quiere un curso desde cero.",
          to: "listado_servicios",
        },
      ],
    },

    // Orden en WhatsApp: `introCursos` (lo manda el código al entrar) → las 3
    // fichas (mediaFirst) → el texto de Emma, que es solo la invitación A/B/C.
    {
      node: "listado_servicios",
      openWith: ["introCursos"],
      extraInstructions: [
        'Apenas sepas que no tiene experiencia, llamá show_services con category "Cursos" UNA sola vez y mostrá los 3 cursos completos de una — cada uno con su ficha (imagen + detalle), todos juntos en el mismo turno. Nunca de a uno ni repartido en varios mensajes. La intro ("Genial, ahora te paso un resumen de tus cursos") ya le llegó sola: no escribas otra. El precio y el detalle ya van en cada ficha, no los repitas vos.',
        'Si el alumno está hablando de certificaciones y no de cursos, este no es su paso: no le muestres cursos ni la invitación de cursos, y llamá advance_flow con la ruta "es-certificacion" en este mismo turno.',
        "La invitación de este paso ya da las 3 opciones con letra. Si el alumno responde solo con la letra, mapealo así: A = Básico, B = Avanzado, C = Operación Múltiple.",
        'No escribas tu propia pregunta de cierre (ej. "¿te interesa alguno en particular?"): la invitación con las 3 opciones ya se agrega sola al final de tu mensaje. Escribirla vos también la duplica.',
        'Cuando el alumno nombre UN curso concreto —por su nombre o por letra (A, B o C)— es que lo ELIGIÓ: no le vuelvas a mandar la ficha ni le preguntes si quiere más información. Llamá advance_flow con la ruta "ruta-cierre" en ese mismo turno.',
        "Al escribir el listado de los 3 cursos, tu línea de cada uno es SOLO el nombre — nunca el precio, ni el monto, aunque lo tengas disponible.",
        '✅ "· BÁSICO - Operación y mantenimiento de equipos"',
        '❌ "· BÁSICO - Operación y mantenimiento de equipos: S/ 200" (NUNCA así)',
      ].join("\n"),
      // Las 3 fichas con foto tienen que llegar ANTES que esta invitación, no
      // después: el alumno tiene que ver el material completo antes de que le
      // pregunten cuál elige.
      mediaFirst: true,
      cta: "¿Qué curso te gustaría iniciar?\nA. Básico\nB. Avanzado\nC. Operación Múltiple",
      routes: [
        {
          id: "ruta-cierre",
          when: "El alumno eligió un curso concreto y quiere inscribirse.",
          to: "mostrar_beneficios",
        },
        // Red de seguridad del bug del 2026-09-29: si igual llega acá hablando
        // de certificados, sale en el mismo turno. Como el CTA se recalcula al
        // cambiar de paso, cierra con el de certificaciones, y la intro de
        // cursos no sale (un openWith de mitad de turno solo sale si el turno
        // termina en ese paso).
        {
          id: "es-certificacion",
          when: "El alumno está hablando de certificaciones, no de cursos.",
          to: "asesoria_perfil",
        },
      ],
    },

    // Camino con experiencia. La lista A/B/C la manda el CÓDIGO al entrar
    // (`listadoCertificaciones`) y, con fixedOnly, es la respuesta entera de ese
    // turno: el 2026-09-29 la IA escribió su propia lista con precios
    // ("· Certificación - 1 a 2 máquinas — S/ 295") encima de la invitación,
    // aunque la regla de no dar precios al listar ya estaba.
    //
    // Elegir una letra ES avanzar, igual que en cursos: con "¿en cuál deseas
    // más información?", un "B" se leía como "dame información" y Emma se
    // quedaba acá dando el precio en vez de pasar a beneficios.
    {
      node: "asesoria_perfil",
      label: "Asesoría con experiencia",
      openWith: ["listadoCertificaciones"],
      fixedOnly: true,
      // La pregunta ya viene al final de la lista.
      cta: false,
      extraInstructions: [
        "La lista de las 3 certificaciones con su letra (A, B, C) ya le llegó sola al entrar a este paso: no la escribas vos.",
        "En este paso NUNCA escribas un precio ni un monto — ni al listar ni al hablar de una sola. El precio le llega en el mensaje de beneficios.",
        "Si tenés que volver a nombrar las opciones, siempre con su letra, sin precio y en este orden: A. Certificación de 1 a 2 maquinarias, B. Certificación de 3 a 4 maquinarias, C. Certificación de 5 maquinarias o más.",
        'Cuando el alumno elija una —por letra o por tramo—, es que la ELIGIÓ: no le des precio ni detalle, llamá advance_flow con la ruta "quiere-certificarse" en ese mismo turno. El mapeo, contra la lista de servicios:',
        '- A o "1 a 2" → la certificación de 1 a 2',
        '- B o "3 a 4" → la certificación de 3 a 4',
        '- C o "5 o más" → la certificación de 5 o más',
        "No repreguntes el número de maquinarias en texto libre: esperá la letra o el tramo.",
        "Para las herramientas usá el nombre del servicio tal como figura en la lista de servicios.",
      ].join("\n"),
      routes: [
        {
          id: "quiere-certificarse",
          when: "El alumno eligió una de las certificaciones: por letra (A, B o C) o por tramo (1 a 2, 3 a 4, 5 o más).",
          to: "mostrar_beneficios",
        },
        {
          id: "prefiere-curso",
          when: "El alumno prefiere un curso concreto en vez de la certificación y quiere inscribirse.",
          to: "mostrar_beneficios",
        },
      ],
    },

    // Entre "ya eligió" y "dame tus datos": le muestra lo que recibe al
    // terminar antes de pedir la captura del pago. Cruzan los dos caminos.
    {
      node: "mostrar_beneficios",
      extraInstructions: [
        "Apenas entrés a este paso, mandá DOS mensajes fijos en el mismo turno, en este orden, con send_fixed_message:",
        '1. Los beneficios: "beneficiosCertificado" si eligió una certificación, "beneficiosCurso" si eligió un curso.',
        "2. El descuento que corresponda:",
        '   - Curso: "descuentoBasico" (BÁSICO), "descuentoAvanzado" (AVANZADO), "descuentoMultiple" (OPERACIÓN MÚLTIPLE).',
        '   - Certificación: "descuentoCert1a2" (1 a 2 maquinarias), "descuentoCert3a4" (3 a 4 maquinarias), "descuentoCert5oMas" (5 maquinarias o más).',
        "No inventes vos ningún monto: todo ya va en los mensajes.",
        "Recién cuando el alumno responda sobre el descuento (sea que quiera aplicarlo o no), avanzá.",
      ].join("\n"),
      // Los 2 mensajes fijos SON la respuesta: el descuento ya termina con su
      // pregunta. Cualquier texto propio de Emma en ese turno se descarta en
      // código — pedírselo por instrucción falló 4 veces seguidas.
      fixedOnly: true,
      cta: false,
      fixedMessages: [
        "beneficiosCurso",
        "beneficiosCertificado",
        "descuentoBasico",
        "descuentoAvanzado",
        "descuentoMultiple",
        "descuentoCert1a2",
        "descuentoCert3a4",
        "descuentoCert5oMas",
      ],
      routes: [
        {
          id: "continua",
          when: "El alumno ya respondió sobre el descuento (lo quiera aplicar o no) y quiere seguir con la inscripción.",
          to: "solicitar_pago",
        },
      ],
    },

    {
      node: "solicitar_pago",
      extraInstructions: [
        "Apenas entrés a este paso, mandá con send_fixed_message el mensaje de pago de lo que eligió:",
        '- Curso: "pagoBasico" (BÁSICO), "pagoAvanzado" (AVANZADO), "pagoMultiple" (OPERACIÓN MÚLTIPLE).',
        '- Certificación: "pagoCertificacion", con la certificación que eligió.',
        "No escribas vos el monto ni los datos de pago: ya van en el mensaje.",
      ].join("\n"),
      // El monto va en un mensaje fijo por curso, no en una lista dentro de
      // las instrucciones: con la lista, el modelo le cobró S/ 100 (BÁSICO) a
      // un alumno de OPERACIÓN MÚLTIPLE (S/ 200). Y ese mensaje es la
      // respuesta entera: termina en "me mandas la captura", sin nada atrás.
      fixedOnly: true,
      cta: false,
      fixedMessages: [
        "pagoBasico",
        "pagoAvanzado",
        "pagoMultiple",
        "pagoCertificacion",
      ],
      // Con la primera foto (DNI o voucher): se la reenvía al dueño y Emma se
      // pausa en ese chat. El dueño la vuelve a prender desde el Inbox.
      onImage: { forward: true, pause: true },
    },

    { node: "confirmed" },
  ],

  fixedMessages: {
    // Los dos `openWith`: los manda el código al entrar al paso, sin servicio,
    // así que no pueden llevar {precio} ni {servicio}. El `when` es para quien
    // lee el archivo — la IA nunca los ve como opción.
    presentacion: {
      when: "Al entrar al saludo (conversación nueva, o de vuelta después de 24 h).",
      text: "Hola 👋 soy Nicole Perez, asesora comercial del Instituto Tecmin",
    },
    listadoCertificaciones: {
      when: "Al entrar a la asesoría con experiencia: las 3 certificaciones, sin precio.",
      text: [
        "Estas son nuestras certificaciones por experiencia:",
        "A. Certificación de 1 a 2 maquinarias",
        "B. Certificación de 3 a 4 maquinarias",
        "C. Certificación de 5 maquinarias o más",
        "¿En cuál de las opciones deseas más información?",
      ].join("\n"),
    },
    introCursos: {
      when: "Al entrar al listado de cursos, antes de las fichas.",
      text: "Genial, ahora te paso un resumen de tus cursos",
    },
    // {precio} sale del servicio elegido en el panel: si el dueño cambia el precio
    // de una certificación, la oferta cambia sola. La foto del carnet se sube
    // desde /asistente ("Fotos de tus mensajes automáticos") — no vive acá.
    ofertaCertificacion: {
      when: "Cuando ya sabés cuántas maquinarias opera y elegiste su certificación.",
      text: [
        "Por esta campaña te vamos a dejar todos los certificados a S/. {precio}, obtienes tus certificados y la inversión incluye:",
        "📜 Certificados físicos y digitales de cada equipo.",
        "🎞️ 10 clases teóricas en video.",
        "Recuerda que la inversión incluye:",
        "📖 01 manual digital de cada equipo.",
        "🪪 01 carnet con código QR para que puedas verificar que tu certificado esta registrado y subido al sistema como este 👇😃",
      ].join("\n"),
      images: true,
    },
    // Las dos galerías de beneficios se suben desde el panel — el instituto
    // todavía no cargó las fotos; send_fixed_message manda el texto solo hasta
    // que lo haga.
    // {precio} es la inversión SEMANAL de ese curso (así carga el dueño el
    // precio de un curso en el panel — no es un monto único por todo el
    // curso). El cronograma semanal (días, práctico, semanas) es el mismo
    // para cualquier curso: solo el monto cambia según cuál eligió.
    beneficiosCurso: {
      when: "Eligió un CURSO y ya le mostraste la ruta de cierre.",
      text: [
        "En este curso la inversión semanal es S/. {precio} y cada semana incluye:",
        "- 03 días de clases teóricas (lunes, martes, miércoles).",
        "- 01 práctico en el taller (jueves).",
        "- 01 hora de operación en el equipo (viernes).",
        "- 12 semanas de clases",
        "🪪 01 carnet con código QR para que puedas verificar que tu certificado esta registrado y subido al sistema como este 👇😃",
      ].join("\n"),
      images: true,
    },
    beneficiosCertificado: {
      when: "Eligió una CERTIFICACIÓN y ya le mostraste la ruta de cierre.",
      text: [
        "En tu caso, todos tus certificados te vamos a dejar a solo S/. {precio}:",
        "📜 01 certificado físico y digital.",
        "🎞️ 10 clases teóricas en video.",
        "Recuerda que la inversión incluye:",
        "📖 01 manual digital de cada equipo.",
        "🪪 01 carnet con código QR para que puedas verificar que tu certificado esta registrado y subido al sistema como este 👇😃",
      ].join("\n"),
      images: true,
    },
    // El gancho de venta: descuento por curso, montos reales (2026-09-26). Uno
    // por curso porque cada uno tiene el suyo — no hay un campo de "descuento"
    // en el servicio, así que el monto va tal cual acá, igual que el precio.
    descuentoBasico: {
      when: "Eligió el curso BÁSICO, antes de avanzar.",
      text: "Te comento que este Lunes del mes empezamos clases.\nTenemos el descuento para tu curso de S/ 100, tiene validez solo si pagas hoy. ¿Te gustaría aplicar el descuento?",
    },
    descuentoAvanzado: {
      when: "Eligió el curso AVANZADO, antes de avanzar.",
      text: "Te comento que este Lunes del mes empezamos clases.\nTenemos el descuento para tu curso de S/ 300, tiene validez solo si pagas hoy. ¿Te gustaría aplicar el descuento?",
    },
    descuentoMultiple: {
      when: "Eligió el curso OPERACIÓN MÚLTIPLE, antes de avanzar.",
      text: "Te comento que este Lunes del mes empezamos clases.\nTenemos el descuento para tu curso de S/ 800, tiene validez solo si pagas hoy. ¿Te gustaría aplicar el descuento?",
    },
    // Descuento por certificación, montos reales (2026-09-27). Sin la línea de
    // "cada 1er lunes": ese cronograma es de los cursos, las certificaciones no
    // arrancan por cohorte mensual.
    descuentoCert1a2: {
      when: "Eligió la certificación de 1 a 2 maquinarias, antes de avanzar.",
      text: "Tenemos el descuento para tu certificación de S/ 30, tiene validez solo si pagas hoy. ¿Te gustaría aplicar el descuento?",
    },
    descuentoCert3a4: {
      when: "Eligió la certificación de 3 a 4 maquinarias, antes de avanzar.",
      text: "Tenemos el descuento para tu certificación de S/ 40, tiene validez solo si pagas hoy. ¿Te gustaría aplicar el descuento?",
    },
    descuentoCert5oMas: {
      when: "Eligió la certificación de 5 maquinarias o más, antes de avanzar.",
      text: "Tenemos el descuento para tu certificación de S/ 50, tiene validez solo si pagas hoy. ¿Te gustaría aplicar el descuento?",
    },
    // Pago de INSCRIPCIÓN por curso, montos reales (2026-09-27). Es un monto
    // distinto de la inversión semanal y del descuento. Uno por curso para que
    // el monto lo ponga el código: con los tres en una lista, el modelo mezcló
    // cuál era de quién.
    pagoBasico: {
      when: "Eligió el curso BÁSICO y quiere seguir con la inscripción.",
      text: "Para confirmar tu inscripción, realiza el pago de S/ 100 por Yape al 986547823 (Alexis Instituto Tecmin). Me mandas la captura para confirmar.",
    },
    pagoAvanzado: {
      when: "Eligió el curso AVANZADO y quiere seguir con la inscripción.",
      text: "Para confirmar tu inscripción, realiza el pago de S/ 150 por Yape al 986547823 (Alexis Instituto Tecmin). Me mandas la captura para confirmar.",
    },
    pagoMultiple: {
      when: "Eligió el curso OPERACIÓN MÚLTIPLE y quiere seguir con la inscripción.",
      text: "Para confirmar tu inscripción, realiza el pago de S/ 200 por Yape al 986547823 (Alexis Instituto Tecmin). Me mandas la captura para confirmar.",
    },
    pagoCertificacion: {
      when: "Eligió una CERTIFICACIÓN y quiere seguir con la inscripción.",
      text: [
        "Para empezar a realizar el tramite de tus certificados. Enviame la foto de tu DNI.",
      ].join("\n"),
    },
  },
});
