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

// Los textos de descuento y de pago de un curso son iguales salvo el monto del
// descuento: una sola redacción, así no se desalinean entre cursos.
function descuentoCurso(descuento: string): string {
  return `Te comento que este Lunes empezamos las clases. Tenemos un descuento de ${descuento} para ti, ¿Te gustaría obtener este descuento?`
}

function pagoCurso(descuento: string): string {
  return [
    `Para brindarte tu descuento de ${descuento} solo realiza la primera inversión de S/. 150.00 que incluye:`,
    "Inscripción.",
    "Matrícula.",
    "⛑️ Casco.",
    "🦺 Chaleco.",
    "🧤 Guantes de seguridad.",
    "🥽 Gafas de seguridad.",
    "📒 Folder pioner",
    "📚 Manuales de clases físicos.",
    "",
    `Al Yape 986547823 (a nombre de: Tecmin Corp SAC). Me envías la captura para confirmar el pago y te brindaremos tus ${descuento} de descuento`,
  ].join("\n")
}

// Los beneficios de un curso, en 3 bloques. Iguales para los tres cursos salvo
// la duración, que sale de la descripción de cada curso en el panel
// (2026-09-30): con una sola duración para los tres, la ficha decía "06
// semanas" y este mensaje "12 semanas" al mismo alumno. {precio} lo completa
// el código con la inversión semanal del curso elegido.
function beneficiosDeCurso(duracion: string): string[] {
  return [
    [
      "En este curso la inversión semanal es S/ {precio} que incluye:",
      "- 03 días de clases teóricas (lunes, martes, miércoles).",
      "- 01 práctico en el taller (jueves).",
      "- 01 hora (60 minutos cada estudiante) de operación en el equipo (viernes).",
    ].join("\n"),
    `⏳ Duración: ${duracion}.`,
    "Al final te brindaremos tus certificados y 01 carnet de operador con código QR para que puedas verificar que tus certificados están registrados y subidos al sistema como este 👇😃",
  ]
}

// El detalle de una certificación (2026-09-30), en 3 bloques: el precio del
// curso completo, el "pero como tú ya sabes operar" y el precio promo. Iguales
// para las 3 opciones salvo los dos montos. La foto del carnet va después del
// tercero; la pregunta de cierre es otro mensaje (`preguntaCertificado`) para
// que salga DESPUÉS de la foto.
function detalleCertificado(precioOriginal: string, precioPromo: string): string[] {
  return [
    `Te comento: El curso que incluye teoría y práctica para *aprender a operar de forma básica* ese equipo tiene una duración de 05 meses y medio con una inversión total de *${precioOriginal}*`,
    "Pero como tú ya sabes operar esos equipos",
    [
      `Por solo ${precioPromo} obtienes tus certificados y la inversión incluye:`,
      "📜 01 certificado físico y digital de cada equipo.",
      "Recuerda que la inversión incluye:",
      "📖 01 manual digital de cada equipo.",
      "🪪 01 carnet con código QR para que puedas verificar que tu certificado esta registrado y subido al sistema como este 👇😃",
    ].join("\n"),
  ]
}

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

    // Se entra acá cuando ya se sabe que es nuevo (ruta "sin-experiencia": no
    // tiene experiencia, quiere un curso desde cero). En ese turno TODO lo manda
    // el código, en este orden:
    //   1. `introCursos` (openWith)
    //   2. las fichas de "Cursos" (catalogOnEnter; mediaFirst las pone antes del texto)
    //   3. el `cta`, que reemplaza el texto de Emma
    // Nació de un turno sin fichas (2026-09-30): dependían de que la IA llamara
    // show_services, y la ventana de 15 minutos las bloqueaba en pruebas
    // seguidas. Después, este paso solo captura qué curso elige.
    {
      node: "listado_servicios",
      openWith: ["introCursos"],
      catalogOnEnter: "Cursos",
      extraInstructions: [
        "La intro, las fichas de los 3 cursos y la pregunta con las opciones ya le llegaron solas al entrar a este paso: no las repitas ni escribas un listado.",
        "Tu única tarea acá es capturar qué curso elige. Mapeo: A = Básico, B = Avanzado, C = Operación Múltiple, o por su nombre.",
        'Cuando el alumno nombre UN curso concreto —por su nombre o por letra (A, B o C)— es que lo ELIGIÓ: no le vuelvas a mandar la ficha ni le preguntes si quiere más información. Llamá advance_flow con la ruta "ruta-cierre" en ese mismo turno.',
        "Si pregunta otra cosa antes de elegir, respondé corto sin dar precios de varios cursos juntos.",
        'Si el alumno está hablando de certificaciones y no de cursos, este no es su paso: llamá advance_flow con la ruta "es-certificacion" en este mismo turno.',
      ].join("\n"),
      // Las fichas tienen que llegar ANTES que la invitación: el alumno tiene
      // que ver el material completo antes de que le pregunten cuál elige.
      mediaFirst: true,
      cta: "Comentame ¿Qué curso te gustaría iniciar? 😊\nA. Básico\nB. Avanzado\nC. Operación Múltiple",
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
        "Si eligió un CURSO:",
        '1. Los beneficios de su curso: "beneficiosBasico" (BÁSICO), "beneficiosAvanzado" (AVANZADO), "beneficiosMultiple" (OPERACIÓN MÚLTIPLE).',
        '2. El descuento de su curso: "descuentoBasico" (BÁSICO), "descuentoAvanzado" (AVANZADO), "descuentoMultiple" (OPERACIÓN MÚLTIPLE).',
        "Si eligió una CERTIFICACIÓN:",
        '1. El detalle de su opción: "detalleCert1a2" (A, 1 a 2 maquinarias), "detalleCert3a4" (B, 3 a 4 maquinarias), "detalleCert5oMas" (C, 5 maquinarias o más).',
        '2. "preguntaCertificado".',
        "No inventes vos ningún monto: todo ya va en los mensajes.",
        "Recién cuando el alumno responda la pregunta del último mensaje (el descuento en cursos, o si realizamos sus certificados), avanzá.",
      ].join("\n"),
      // Los 2 mensajes fijos SON la respuesta: el último ya termina con su
      // pregunta. Cualquier texto propio de Emma en ese turno se descarta en
      // código — pedírselo por instrucción falló 4 veces seguidas.
      fixedOnly: true,
      cta: false,
      fixedMessages: [
        "beneficiosBasico",
        "beneficiosAvanzado",
        "beneficiosMultiple",
        "descuentoBasico",
        "descuentoAvanzado",
        "descuentoMultiple",
        "detalleCert1a2",
        "detalleCert3a4",
        "detalleCert5oMas",
        "preguntaCertificado",
      ],
      routes: [
        {
          id: "continua",
          when: 'El alumno respondió que sí: al descuento (curso) o a "¿Realizamos tus certificados?" (certificación), y quiere seguir.',
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
        "Coméntame, ¿Cuál de estas opciones es la que deseas?",
      ].join("\n"),
    },
    introCursos: {
      when: "Al entrar al listado de cursos, antes de las fichas.",
      text: "Genial, ahora te paso un resumen de tus cursos",
    },
    // Los beneficios, uno por curso porque cambia la duración (ver
    // beneficiosDeCurso). Las fotos se suben desde el panel (/asistente →
    // "Fotos de tus mensajes automáticos"), una vez por curso; sin foto, el
    // mensaje sale solo con el texto. {precio} es la inversión SEMANAL de ese
    // curso (así carga el dueño el precio en el panel: Básico 220, Avanzado
    // 260, Múltiple 260). Reemplazan a `beneficiosCurso` (una sola duración).
    beneficiosBasico: {
      when: "Eligió el curso BÁSICO.",
      text: beneficiosDeCurso("6 semanas (01 mes y medio)"),
      images: true,
    },
    beneficiosAvanzado: {
      when: "Eligió el curso AVANZADO.",
      text: beneficiosDeCurso("12 semanas (3 meses)"),
      images: true,
    },
    beneficiosMultiple: {
      when: "Eligió el curso OPERACIÓN MÚLTIPLE.",
      text: beneficiosDeCurso("22 semanas (5 meses y medio)"),
      images: true,
    },
    // El detalle de cada certificación (2026-09-30): precio del curso completo
    // y precio promo, escritos acá — no hay campo para el precio original en
    // el panel, y así el monto lo pone el código, nunca la IA. Uno por opción,
    // cada uno con su foto del carnet (se sube en el panel, una vez por opción).
    // Reemplazan a beneficiosCertificado y a los descuentos de certificación:
    // en este camino no hay descuento, el precio promo ES la oferta.
    detalleCert1a2: {
      when: "Eligió la certificación A (1 a 2 maquinarias).",
      text: detalleCertificado("S/. 3000.00", "S/. 295.00"),
      images: true,
    },
    detalleCert3a4: {
      when: "Eligió la certificación B (3 a 4 maquinarias).",
      text: detalleCertificado("S/. 4000.00", "S/. 395.00"),
      images: true,
    },
    detalleCert5oMas: {
      when: "Eligió la certificación C (5 maquinarias o más).",
      text: detalleCertificado("S/. 5000.00", "S/. 495.00"),
      images: true,
    },
    // Aparte del detalle para que salga DESPUÉS de la foto del carnet.
    preguntaCertificado: {
      when: "Después del detalle de su certificación, siempre.",
      text: "¿Realizamos tus certificados?",
    },
    // El gancho de venta: descuento por curso (S/ 100, 300 y 800). Uno por
    // curso porque cada uno tiene el suyo — no hay un campo de "descuento" en
    // el servicio, así que el monto va tal cual acá. Texto del 2026-09-30.
    descuentoBasico: {
      when: "Eligió el curso BÁSICO, antes de avanzar.",
      text: descuentoCurso("S/ 100"),
    },
    descuentoAvanzado: {
      when: "Eligió el curso AVANZADO, antes de avanzar.",
      text: descuentoCurso("S/ 300"),
    },
    descuentoMultiple: {
      when: "Eligió el curso OPERACIÓN MÚLTIPLE, antes de avanzar.",
      text: descuentoCurso("S/ 800"),
    },
    // Primera inversión de un curso (2026-09-30): S/ 150.00 para los tres, con
    // lo que incluye y el Yape de Tecmin Corp SAC. Sigue siendo uno por curso
    // porque el monto del DESCUENTO que menciona cambia: con los montos en una
    // lista, el modelo ya mezcló una vez cuál era de quién.
    pagoBasico: {
      when: "Eligió el curso BÁSICO y quiere seguir con la inscripción.",
      text: pagoCurso("S/ 100"),
    },
    pagoAvanzado: {
      when: "Eligió el curso AVANZADO y quiere seguir con la inscripción.",
      text: pagoCurso("S/ 300"),
    },
    pagoMultiple: {
      when: "Eligió el curso OPERACIÓN MÚLTIPLE y quiere seguir con la inscripción.",
      text: pagoCurso("S/ 800"),
    },
    pagoCertificacion: {
      when: "Eligió una CERTIFICACIÓN y quiere seguir con la inscripción.",
      text: [
        "Para empezar a realizar el tramite de tus certificados. Enviame la foto de tu DNI.",
      ].join("\n"),
    },
  },
});
