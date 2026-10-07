import { defineBusinessConfig } from './define.js'

// Instituto Tecmin (prod, 33doLX_tC9vrVnaJVfLvZ): el negocio real, con WhatsApp
// ya conectado. Este archivo manda sobre la base en el flujo, el saludo, los
// datos a pedir y los mensajes fijos. Los cursos, las certificaciones y sus
// precios siguen en la base, editables desde el panel
// (npm run business:show:prod -- 33doLX_tC9vrVnaJVfLvZ para ver todo junto).
//
// El 2026-10-02 se mudó acá desde 4aIwSdMZBY12B06MSSovj, que pasó a ser el banco
// de pruebas ("Instituto Tecmin Test") y se quedó con su configuración. Un
// negocio no puede estar en dos archivos: el viejo corre su flujo guardado.
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
    'Inscripción.',
    'Matrícula.',
    '⛑️ Casco.',
    '🦺 Chaleco.',
    '🧤 Guantes de seguridad.',
    '🥽 Gafas de seguridad.',
    '📒 Folder pioner',
    '📚 Manuales de clases físicos.',
    '',
    `Al Yape 934833829, a nombre del Director Ejecutivo del Instituto: Alexis Gamaniel Pérez Palacios. Me envías la captura para confirmar el pago y te brindaremos tus ${descuento} de descuento`,
  ].join('\n')
}

// Los beneficios de un curso, en 3 bloques. Iguales para los tres cursos salvo
// la duración, que sale de la descripción de cada curso en el panel
// (2026-09-30): con una sola duración para los tres, la ficha decía "06
// semanas" y este mensaje "12 semanas" al mismo alumno. {precio} lo completa
// el código con la inversión semanal del curso elegido.
function beneficiosDeCurso(duracion: string): string[] {
  return [
    [
      // Primero, qué curso es (2026-10-06): si Emma entendió mal, el alumno lo
      // ve acá y lo corrige antes de pagar.
      '*{servicio}*',
      'En este curso la inversión semanal es S/ {precio} que incluye:',
      '- 03 días de clases teóricas (lunes, martes, miércoles).',
      '- 01 práctico en el taller (jueves).',
      '- 01 hora (60 minutos cada estudiante) de operación en el equipo (viernes).',
    ].join('\n'),
    `⏳ Duración: ${duracion}.`,
    'Al final te brindaremos tus certificados y 01 carnet de operador con código QR para que puedas verificar que tus certificados están registrados y subidos al sistema como este 👇😃',
  ]
}

// El detalle de una certificación (2026-09-30), en 3 bloques: el precio del
// curso completo, el "pero como tú ya sabes operar" y el precio promo. Iguales
// para las 3 opciones salvo los dos montos. La foto del carnet va después del
// tercero; la pregunta de cierre es otro mensaje (`preguntaCertificado`) para
// que salga DESPUÉS de la foto.
function detalleCertificado(precioOriginal: string, precioPromo: string): string[] {
  return [
    // Primero, qué certificación es (2026-10-06): si Emma entendió mal la
    // cantidad de máquinas, el alumno lo ve acá y lo corrige antes de pagar.
    `*{servicio}*\nTe comento: El curso que incluye teoría y práctica para *aprender a operar de forma básica* ese equipo tiene una duración de 05 meses y medio con una inversión total de *${precioOriginal}*`,
    'Pero como tú ya sabes operar esos equipos',
    [
      `Por solo ${precioPromo} obtienes tus certificados y la inversión incluye:`,
      '📜 01 Certificado a nombre del MINEDU.',
      '📖 01 manual digital de cada equipo.',
      '🪪 01 carnet con código QR para que puedas verificar que tu certificado esta registrado y subido al sistema como este 👇😃',
    ].join('\n'),
  ]
}

// La foto que Emma PIDIÓ (la captura del pago o el DNI, en solicitar_pago): se le
// reenvía al dueño, Emma se pausa en ese chat y al cliente le llega solo esto.
// Una foto que llega en otro paso no se pidió: se guarda en el Inbox y nada más
// (regla del dueño, 2026-10-01 — antes cualquier foto pausaba a Emma). Sin
// tiempos ("en breve"): el asesor no tiene horario fijo.
const FOTO_AL_DUENO = {
  forward: true,
  pause: true,
  reply: 'Recibido ✅ Un asesor se comunicará contigo 😊',
}

export default defineBusinessConfig({
  businessId: '33doLX_tC9vrVnaJVfLvZ',
  name: 'Instituto Tecmin',
  flowType: 'sales',

  // El Bloque 2 de la presentación, tal cual: lo escribe Emma después del
  // Bloque 1 (`presentacion`, que manda el código al entrar al saludo). Hace la
  // pregunta de la bifurcación, así que no se le agrega otra invitación.
  greeting:
    'Cuéntame, ¿tienes experiencia operando maquinaria o deseas realizar un curso desde cero?',

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
  //
  // El resto (2026-09-30) son las reglas de venta del dueño, una por cada cosa
  // que Emma inventó en la prueba de 141 conversaciones (D01: "válido para
  // minería y MTC"; D07: "con el descuento pagarías S/ 120"; E04: "la práctica
  // es a las 3 p.m."; B01: "el Básico incluye excavadora"; G02: "DNI y una foto
  // reciente"; F03: "soy un asistente virtual"). Cada una dice qué SÍ decir: con
  // solo "no inventes", el modelo llenaba el hueco igual.
  instructions: [
    // Tope del panel: 2.000 caracteres (businessSettingsSchema). Pasarlo deja
    // los settings inválidos; lo cuida businesses.test.ts.
    // Reescritas el 2026-10-01 con las correcciones del dueño a la regresión:
    // el pago de un curso es SOLO la inscripción de S/ 150 (Emma decía "pago de
    // S/ 260 por Yape"), la certificación es un pago único y nunca se cobra por
    // chat, nunca "no tengo esa información" ni "referencial".
    // 2026-10-01, regresión 3: en tú (Emma copiaba el "querés" de estas
    // líneas), nunca cuentas ("con el descuento queda en S/ 120", R06) y la
    // duración escrita (leyó "precio SEMANAL" como "dura una semana", R23). Lo
    // que es respuesta a una pregunta concreta pasó a `answers`, abajo.
    'Tu meta: en un CURSO, que mande la captura del pago de inscripción; en una CERTIFICACIÓN, que mande la foto de su DNI. Cada respuesta tuya lo acerca a eso: responde corto y vuelve al paso que sigue.',
    'Al LISTAR opciones no digas precios, solo nombres. El precio, solo si pregunta por UNA o ya viene en un mensaje fijo.',
    'Eres Nicole, asesora comercial del Instituto Tecmin. Nunca digas que eres bot, IA, asistente virtual ni programa. Tutea siempre ("quieres", "tienes", "puedes"); nunca "querés", "tenés", "podés" ni "sos".',
    'Nunca digas "no tengo/no manejo información". Si algo no está acá ni en "Respuestas del negocio": "Esa consulta te la confirma el asesor 😊", y sigue con la venta.',
    'NUNCA hagas cuentas (sumas, restas, multiplicaciones, "con el descuento queda en…") ni digas que no puedes hacerlas. Los únicos montos son los de los mensajes fijos y la lista de servicios. Si pregunta el total o cuánto le queda con el descuento, es INTENCIÓN POSITIVA: sigue el flujo.',
    'CURSOS: el precio es SEMANAL (cómo se paga, no cuánto dura). Duración, solo esta: Básico 6 semanas, Avanzado 12 semanas, Operación Múltiple 22 semanas.',
    'En un curso el ÚNICO pago por aquí es la inscripción de S/ 150, y ese monto solo lo da el mensaje de pago: nunca lo escribas tú. Nunca otro monto a pagar ni la palabra "referencial". Nunca digas que no hay descuento.',
    'Nunca digas que recibiste o confirmaste un pago, un comprobante o un DNI.',
    'CERTIFICACIONES: un solo pago (el de su detalle), nunca "semanal"; no requiere hacer un curso. Solo se pide el DNI: nunca hables de Yape ni pagos ahí.',
    'En un curso nunca pidas DNI, nombre, correo, teléfono ni fotos.',
    'Del inicio solo "este lunes"; nunca cupos. Si dice que no o que lo piensa: "Entendido, estaré al tanto si deseas continuar 😊" y nada más.',
  ].join('\n'),

  // Las respuestas del dueño a lo que más preguntaron los leads en las pruebas
  // (2026-10-01). Fuera de `instructions` por su tope de 2.000 caracteres; cada
  // pregunta sin respuesta acá era una que Emma inventaba ("dura una semana",
  // "no se puede en cuotas") o mandaba al asesor 4 veces seguidas (docentes).
  answers: [
    'Docentes (aunque insista en qué especialidad o experiencia): "Son ingenieros, instructores y técnicos, todos especializados en maquinaria y en el sector minero 😊". Nunca lo mandes al asesor.',
    'Validez (cursos y certificaciones): "Los certificados llevan la firma del Instituto Tecmin y están validados por el Colegio de Ingenieros del Perú, CAT y KOMATSU. Son válidos en todo el Perú."',
    '¿Consigo trabajo? en el curso BÁSICO o en una CERTIFICACIÓN: solo "Con el certificado puedes conseguir trabajo en el sector minero." Ahí NUNCA hables de prácticas ni de ubicarlo en una empresa.',
    '¿Consigo trabajo? en AVANZADO u OPERACIÓN MÚLTIPLE: "Con el certificado puedes conseguir trabajo en el sector minero. Al terminar te ubicamos en una empresa como practicante para que ganes experiencia."',
    'Sobre trabajo, nunca digas "garantizamos" ni "no garantizamos", ni agregues "incluso sin experiencia", "de inmediato" ni otra promesa: la frase, tal cual, aunque insista.',
    'Sueldo o cuánto se gana: "Esa consulta te la confirma el asesor 😊".',
    'Horarios: "Los horarios son personalizados: clases teóricas lunes, martes y miércoles; práctica en el taller el jueves; operación en el equipo el viernes." Nunca des horas ni turnos.',
    '¿Si falto se recupera?: "Sí, la clase se recupera 😊".',
    '¿Cuántos alumnos por grupo o por máquina?: "Las clases son personalizadas 😊".',
    'Equipos del Básico o del Avanzado: "Los equipos de mayor demanda en el sector." Nunca nombres una máquina. Los de Operación Múltiple: minicargador, montacargas, compactador de suelos, retroexcavadora, cargador sobre ruedas, motoniveladora y excavadora hidráulica.',
    // Vivía en `instructions`; con el nombre del Director (2026-10-02) las pasó
    // del tope de 2.000 caracteres. Mismo texto, sin tope acá.
    'Medio de pago, solo: "Por aquí la inscripción es por Yape 934833829, a nombre del Director Ejecutivo del Instituto: Alexis Gamaniel Pérez Palacios. Lo demás te lo confirma el asesor 😊". Nunca "sí" ni "no" a efectivo, tarjeta, cuotas, factura ni al contado.',
    'Cómo se pagan las semanas, efectivo, tarjeta, cuotas, boleta o factura: "Esa consulta te la confirma el asesor 😊". Por aquí solo se hace la inscripción (curso) o se pide el DNI (certificación).',
    '¿Hasta cuándo vale el descuento? (solo CURSOS): "Es válido solo por hoy 😊". No lo digas si no lo pregunta. Nunca expliques sobre qué se aplica el descuento.',
    'En una CERTIFICACIÓN nunca hables de descuento ni de precios de cursos: su precio es el de su detalle.',
    'Edad: "No hay edad mínima 😊".',
    'Requisitos: en un curso, solo la inscripción (llega en el mensaje de pago); en una certificación, solo la foto del DNI. No inventes otros ni digas "no hay requisitos".',
    // Georgina (prod, 2026-10-05) recibió la respuesta del trabajo: "certificado"
    // está en varias respuestas y ninguna decía que esto ES el producto.
    // Cada opción en su línea, como la lista de certificaciones (dueño, 2026-10-06).
    '¿Dan certificado de experiencia / por experiencia / de lo que ya sé operar? (no es la pregunta del trabajo): copia tal cual, con sus saltos de línea: "¡Sí! Justamente nuestras certificaciones son por experiencia: depende de cuántas maquinarias sabes operar.\n¿Cuántas quieres certificar?\nA. 1 a 2 maquinarias\nB. 3 a 4 maquinarias\nC. 5 maquinarias o más".',
    '¿Cómo comprueban mi experiencia?: no lo expliques; vuelve a ofrecerle la certificación.',
    'Sede: los cursos son presenciales, solo en Huancayo (Junín); no hay otras sedes ni clases virtuales, y no ofrezcas alojamiento. Los certificados de las certificaciones se envían a todo el Perú.',
    'MTC o licencia de conducir: "Nuestro certificado es de operador por maquinaria; no es una licencia de conducir." Nunca nombres al MTC.',
    'Emisión del certificado: "Lo hacemos al instante."',
    '¿Cuándo me escribe el asesor?: "Un asesor se comunicará contigo 😊". Nunca des un tiempo.',
  ],

  // Cuándo pasa a una persona (2026-09-30). El genérico de la herramienta dice
  // "si pregunta por pagos", y Emma escalaba —y se callaba— con leads que
  // preguntaban "¿cómo pago?" listos para cerrar: 24 escaladas así en la prueba.
  // Los NUNCA van primero (prod, 1/10 13:39): el modelo lee esto al elegir la
  // herramienta, y con la lista de motivos adelante escaló "SI CLARO, ¿DAN
  // FACTURA BOLETA?" en vez de mandar el pago.
  escalateWhen:
    'NUNCA la uses si el cliente acaba de aceptar la oferta ("sí", "sí claro", "dale", "quiero"), aunque en el mismo mensaje pregunte por factura, boleta, cuotas, pagos o cualquier otra cosa: en ese caso avanza con advance_flow y el mensaje de pago o el pedido del DNI es la respuesta. NUNCA la primera vez que pregunta algo que se responde con "Esa consulta te la confirma el asesor 😊" o que está en "Respuestas del negocio". Úsala SOLO si: el cliente pide hablar con una persona o el número o contacto del asesor; vuelve a preguntar algo que ya respondiste con "Esa consulta te la confirma el asesor"; se queja o está molesto; insiste por segunda vez con algo que no puedes responder; pregunta por devoluciones o reembolsos; es una empresa que quiere inscribir a varios trabajadores; o es un alumno actual (horarios, clases, cambios). Al usarla dile: "Te paso con un asesor para que te responda 😊". Una duda de un interesado que no sabes (instalaciones…) NO es motivo: responde "Esa consulta te la confirma el asesor 😊" y sigue. NUNCA la uses por una pregunta que está en "Respuestas del negocio" (trabajo, docentes, horarios…): respóndela tal cual. NUNCA la uses cuando pregunta cómo pagar, qué necesita o si ya puede empezar: eso es la señal para mandar el mensaje de pago o el pedido del DNI.',

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
  // con la etiqueta de lo que eligió y el dueño lo encuentra filtrando. Una por
  // servicio, para distinguir a cinco alumnos etiquetados sin abrir el chat. Las
  // claves son los ids de los servicios del negocio.
  whatsappLabels: {
    MgyYkPSaQggEnBhWoDis3: { id: '901', name: 'Envió requisito: Curso Básico' },
    O0tfF05VumgUtDsm_98Et: { id: '902', name: 'Envió requisito: Curso Avanzado' },
    cBP8HP8IdgIWgV54wWkBu: { id: '903', name: 'Envió requisito: Curso Op. Múltiple' },
    hF9Vywr6oNFbN1ILSeIEc: { id: '904', name: 'Envió requisito: Certificado 1-2 máq.' },
    '9By_80n__49szE5uTsoS4': { id: '905', name: 'Envió requisito: Certificado 3-4 máq.' },
    JRUhh01nF0N2fS4xNONMk: { id: '906', name: 'Envió requisito: Certificado 5+ máq.' },
  },

  // El embudo del panel (Dashboard): quién recibió la oferta y quién recibió el
  // pedido de pago o del DNI. El panel suma adelante los leads y atrás la foto
  // pedida y Pagó / No pagó.
  funnel: [
    {
      label: 'Recibió la oferta',
      fixedMessages: [
        'beneficiosBasico',
        'beneficiosAvanzado',
        'beneficiosMultiple',
        'detalleCert1a2',
        'detalleCert3a4',
        'detalleCert5oMas',
      ],
    },
    {
      label: 'Recibió el pago o el pedido del DNI',
      fixedMessages: ['pagoBasico', 'pagoAvanzado', 'pagoMultiple', 'pagoCertificacion'],
    },
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

  // Lo que Emma pide y guarda en collect_data. Sin 'nombre completo' a
  // propósito (2026-09-27): el dueño no lo quiere pedir en este paso — el
  // mensaje de pago tiene que terminar en la instrucción de pago, sin nada
  // más pegado.
  collectData: ['curso o certificación elegida'],

  // El flujo nuevo cobra directo: sin esto, la fila real de Tecmin (adelanto
  // de S/30 por Yape) le agregaría al prompt un bloque de "para separar el
  // cupo" que este flujo no maneja en ningún paso.
  requiresDeposit: false,

  flow: [
    { node: 'idle' },

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
      node: 'greeting',
      openWith: ['presentacion'],
      mediaFirst: true,
      // El Bloque 2 ya es la pregunta. Sin esto, al volver después de 24 h (ya
      // hay historial) la invitación rotativa se le pegaba atrás.
      cta: false,
      extraInstructions: [
        'La presentación (tu nombre y el instituto) ya le llegó sola, antes de tu mensaje: no te vuelvas a presentar.',
        // Prod, 2026-10-05 21:45: "información de los cursos de maquinaria
        // pesada" recibió la pregunta de la experiencia. La regla de "ya dijo qué
        // busca" iba después de la del saludo solo, y el modelo tomaba la primera.
        'LO PRIMERO: si su mensaje ya pide los cursos o información de cursos ("información de los cursos", "quiero un curso", "cursos de maquinaria") o dice que no tiene experiencia, llamá advance_flow con la ruta "sin-experiencia" en este mismo turno; si pide certificación o certificados, o dice que ya opera maquinaria, la ruta "con-experiencia". En esos casos NUNCA hagas la pregunta de la experiencia.',
        '- Si el alumno solo saludó o todavía no dijo qué busca, tu mensaje es exactamente: "Cuéntame, ¿tienes experiencia operando maquinaria o deseas realizar un curso desde cero?"',
        '- No uses show_services en este paso: los cursos y las certificaciones se muestran en su propio paso.',
        // A10 (2026-09-30): "precio de la certificación?" como primer mensaje
        // dejaba a Emma listando precios en este paso, sin llegar nunca a A/B/C.
        '- Si pregunta el precio de la certificación, no lo des acá: llamá advance_flow con la ruta "con-experiencia" (allá le llega la lista y después el precio de su opción).',
        // C03/D04 (2026-09-30): "quiero el curso avanzado" se iba a certificaciones.
        '- Si pide un CURSO por su nombre o su letra ("el básico", "el avanzado", "la C"), es la ruta "sin-experiencia", aunque cuente que ya manejó alguna máquina.',
      ].join('\n'),
      // El ejemplo es lo último que lee el modelo en el paso, y era solo la
      // pregunta de la experiencia: la copiaba aunque el alumno ya hubiera pedido
      // los cursos (prod 2026-10-05; en dev, 2 de 3 veces). Los casos especiales
      // del catálogo ("preguntá qué necesita") empujaban para el mismo lado.
      edgeCases: [
        'Si su primer mensaje ya pide cursos o certificados, no hay nada que preguntar: advance_flow con su ruta.',
      ],
      example:
        'Solo saludó ("hola", "buenas noches"): "Cuéntame, ¿tienes experiencia operando maquinaria o deseas realizar un curso desde cero?". Pidió cursos ("información de los cursos de maquinaria"): advance_flow "sin-experiencia", sin esa pregunta. Pidió certificación: advance_flow "con-experiencia".',
      routes: [
        {
          id: 'con-experiencia',
          when: 'El alumno pregunta por certificación o certificados (o su precio), o dice que tiene experiencia operando maquinaria y no pide un curso.',
          to: 'asesoria_perfil',
        },
        {
          id: 'sin-experiencia',
          when: 'El alumno pregunta por los cursos o pide uno (por nombre o letra), quiere empezar desde cero o dice que no tiene experiencia operando maquinaria.',
          to: 'listado_servicios',
        },
      ],
    },

    // La bifurcación del diagrama: acá solo se decide el camino. Lo que se le
    // ofrece a cada uno vive en su propio paso.
    {
      node: 'informing',
      extraInstructions: [
        'El saludo ya le preguntó si tiene experiencia operando maquinaria o si quiere un curso desde cero. Tu único trabajo acá es saber la respuesta.',
        // Decisión del dueño (2026-10-05): dos salidas y ninguna se confirma. La
        // regla vieja ("si además pregunta algo, respondé y cerrá con '¿Te paso la
        // información de nuestros cursos?'") hizo que "No tengo exp", sin ninguna
        // pregunta, recibiera esa confirmación en prod.
        '- Si NO tiene experiencia ("no", "no tengo exp", "ninguna", "desde cero") o pregunta por los cursos: llamá advance_flow con la ruta "sin-experiencia" en este mismo turno, aunque también pregunte otra cosa. Nunca le preguntes si quiere la información: al pasar le llegan los cursos solos.',
        '- Si TIENE experiencia, o pregunta por certificación: pasá al paso de certificación.',
        // R06#1 (regresión 5): "kiero el curso básico, ¿cuántas cuotas y cuánto en
        // total?" se quedó acá respondiendo precios hasta que el lead se fue.
        '- Si nombra un curso o pregunta precio, cuotas, total o pago, es INTENCIÓN POSITIVA: pasa al paso de cursos en este mismo turno, sin responder esas preguntas.',
        '- Si dice que no le interesa o que lo piensa, solo la frase del "no", sin invitación.',
        '- No uses show_services en este paso: los cursos y las certificaciones se muestran en su propio paso.',
        '- Si la respuesta no es clara, preguntale de nuevo si tiene experiencia operando maquinaria.',
        // Si ya dijo que no tiene experiencia, va a cursos aunque pregunte la
        // dirección (decisión del dueño, 2026-10-05): esta regla le ganaba.
        '- Solo si pregunta por la ubicación o cómo llegar SIN decir si tiene experiencia: dale la dirección y el link de Google Maps de arriba en una línea, y volvé a preguntarle si tiene experiencia.',
        '- Si pregunta el precio de la certificación, no lo des acá: pasá al paso de certificación.',
        '- Si pide un CURSO por su nombre o su letra ("el básico", "el avanzado", "la C"), pasá al paso de cursos aunque cuente que ya manejó alguna máquina.',
      ].join('\n'),
      // En dev (2026-10-05), "No tengo experiencia, ¿dónde queda?" se respondía
      // con la dirección + "¿Te gustaría saber sobre los cursos?" 5 de 5 veces.
      edgeCases: [
        '"No tengo experiencia, ¿dónde queda?" (o cualquier pregunta junto al "no tengo experiencia"): advance_flow "sin-experiencia" y nada más. No respondas la pregunta en este turno ni le preguntes si quiere saber de los cursos: los cursos le llegan solos y la pregunta la responderás si la repite.',
      ],
      example: '¡Genial! ¿Ya operas alguna maquinaria o quieres empezar desde cero?',
      // R14 (2026-10-01): la invitación rotativa se pegaba detrás del "no"
      // ("Entendido, estaré al tanto… ¿Te cuento más de alguno?"). Este paso ya
      // cierra con su propia pregunta, la de la experiencia.
      cta: false,
      routes: [
        {
          id: 'con-experiencia',
          when: 'El alumno dice que tiene experiencia operando maquinaria y no pide un curso, o pregunta por certificación (o su precio).',
          to: 'asesoria_perfil',
        },
        {
          id: 'sin-experiencia',
          when: 'El alumno no tiene experiencia operando maquinaria, quiere un curso desde cero, o pide un curso por su nombre o letra.',
          to: 'listado_servicios',
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
      node: 'listado_servicios',
      openWith: ['introCursos'],
      catalogOnEnter: 'Cursos',
      extraInstructions: [
        'La intro, las fichas de los 3 cursos y la pregunta con las opciones ya le llegaron solas al entrar a este paso: no las repitas ni escribas un listado.',
        // 2026-10-06: el mapeo letra → curso y el envío de beneficios + descuento
        // los hace el código (`choices`, abajo). Una letra sola ni pasa por la IA.
        'Tu única tarea acá es saber qué curso elige. Si lo nombra con palabras ("el básico", "el de 3 equipos"), llamá elegir_opcion con su letra: A Básico, B Avanzado, C Operación Múltiple. El sistema le manda los beneficios y el descuento; no escribas nada más.',
        // Regresión del 2026-10-01 (R04#1, R06): "Me gustaría el básico, ¿cuánto
        // cuesta y hay descuento?" se quedaba respondiendo acá ("no hay
        // descuentos", totales) y nunca llegaba a beneficios.
        'Si además de elegir pregunta precio, total, descuento, duración, requisitos, cómo pagar, efectivo, cuotas o factura, es INTENCIÓN POSITIVA: igual llamá elegir_opcion en ese mismo turno y NO respondas esas preguntas — los mensajes que siguen ya las responden.',
        'En este paso nunca hables del pago ni digas que no hay descuento. Nunca escribas tú el precio, la inscripción ni el Yape.',
        // R23#2 (regresión 4): "¿cuánto cuesta cada uno?" → show_services y los
        // 3 precios; después dio por hecho el Básico sin que lo eligiera.
        'Si pregunta otra cosa antes de elegir, respondé corto y volvé a preguntar cuál elige. Si pide el precio de todos o de "cada uno": "Cuéntame cuál te interesa y te paso su inversión 😊". No uses show_services: las fichas ya le llegaron.',
        'Si el alumno está hablando de certificaciones y no de cursos, este no es su paso: llamá advance_flow con la ruta "es-certificacion" en este mismo turno.',
      ].join('\n'),
      // La elección la hace el código: la letra sola se resuelve sin la IA; por
      // nombre, la IA pasa la letra a elegir_opcion. Cada curso manda sus
      // beneficios y su descuento y sale por "ruta-cierre".
      choices: {
        route: 'ruta-cierre',
        // Al aceptar, el pago lo manda el código según el curso elegido (`onAccept`).
        followUp: 'solicitar_pago',
        options: [
          {
            key: 'A',
            service: 'MgyYkPSaQggEnBhWoDis3',
            send: ['beneficiosBasico', 'descuentoBasico'],
            onAccept: ['pagoBasico'],
          },
          {
            key: 'B',
            service: 'O0tfF05VumgUtDsm_98Et',
            send: ['beneficiosAvanzado', 'descuentoAvanzado'],
            onAccept: ['pagoAvanzado'],
          },
          {
            key: 'C',
            service: 'cBP8HP8IdgIWgV54wWkBu',
            send: ['beneficiosMultiple', 'descuentoMultiple'],
            onAccept: ['pagoMultiple'],
          },
        ],
      },
      // Los genéricos del catálogo ("Plan básico. ¿Te cuento de qué se trata o
      // preferís ver otro?") empujaban a describir y comparar en vez de cerrar.
      example: '¡Buena elección! Te cuento lo que incluye 😊',
      edgeCases: [
        'Si pregunta algo que no está en la descripción del curso, respondé con lo que sí sabés y volvé a la pregunta de qué curso elige.',
      ],
      // Las fichas tienen que llegar ANTES que la invitación: el alumno tiene
      // que ver el material completo antes de que le pregunten cuál elige.
      mediaFirst: true,
      cta: 'Comentame ¿Qué curso te gustaría iniciar? 😊\nA. Básico\nB. Avanzado\nC. Operación Múltiple',
      routes: [
        {
          id: 'ruta-cierre',
          when: 'Solo la toma el sistema al elegir un curso con elegir_opcion: nunca la llames con advance_flow.',
          to: 'mostrar_beneficios',
        },
        // Red de seguridad del bug del 2026-09-29: si igual llega acá hablando
        // de certificados, sale en el mismo turno. Como el CTA se recalcula al
        // cambiar de paso, cierra con el de certificaciones, y la intro de
        // cursos no sale (un openWith de mitad de turno solo sale si el turno
        // termina en ese paso).
        {
          id: 'es-certificacion',
          when: 'El alumno está hablando de certificaciones, no de cursos.',
          to: 'asesoria_perfil',
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
      node: 'asesoria_perfil',
      label: 'Asesoría con experiencia',
      openWith: ['listadoCertificaciones'],
      fixedOnly: true,
      // La pregunta ya viene al final de la lista.
      cta: false,
      extraInstructions: [
        // R23#3 (regresión 4): "no manejo ninguna máquina, me interesa la opción
        // A" recibió la oferta de certificación ("como tú ya sabes operar…").
        // R02#1 (2026-10-01): "no quiero certificación, solo el curso avanzado"
        // → "en este momento solo ofrecemos certificaciones". Desde 2026-10-06
        // los dos casos van a cursos por la misma ruta: allá elige su curso.
        'LO PRIMERO: si dice que NO tiene experiencia operando maquinaria, o que quiere un curso en vez de certificarse, llamá advance_flow con la ruta "sin-experiencia" en ese mismo turno, AUNQUE elija una letra: estas opciones son solo para quien ya opera. Nunca escribas vos el listado de cursos ni digas que solo hay certificaciones.',
        'La lista de las certificaciones con su letra ya le llegó sola al entrar a este paso: no la escribas vos. En este paso NUNCA escribas un precio ni un monto.',
        // 2026-10-06: el mapeo opción → certificación, contar las máquinas y
        // mandar la oferta lo hace el código (`choices`, abajo). Con la regla
        // "no repreguntes el número de maquinarias" y sin decir qué hacer si las
        // nombraba, Emma ofreció la de 5 o más para 2 máquinas (Georgina).
        'Si el alumno elige con palabras, dice cuántas maquinarias opera o nombra las que opera, llamá elegir_opcion con eso: la letra, la cantidad, o la lista de las máquinas tal como las nombró. NO las cuentes ni elijas vos: el sistema elige la certificación y le manda la oferta.',
        'Si además pregunta precio, total, requisitos, cómo seguir, efectivo, cuotas o factura, es INTENCIÓN POSITIVA: igual llamá elegir_opcion en ese mismo turno sin responder esas preguntas — la oferta que sigue ya las responde.',
        'Si todavía no dijo cuál quiere ni qué maquinarias opera, preguntale cuántas maquinarias quiere certificar, por la letra de la lista.',
      ].join('\n'),
      example: '¡Perfecto! 😊',
      edgeCases: [
        'Si pregunta algo antes de elegir, respondé corto (con las "Respuestas del negocio" o "Esa consulta te la confirma el asesor 😊") y volvé a preguntar cuántas maquinarias quiere certificar.',
      ],
      // La elección la hace el código: la letra o el tramo solos se resuelven
      // sin la IA; si nombra máquinas, la IA las lista y el código cuenta. Cada
      // opción manda el detalle de su certificación y la pregunta de cierre.
      choices: {
        route: 'quiere-certificarse',
        // Al aceptar, el pedido del DNI lo manda el código (`onAccept`).
        followUp: 'solicitar_pago',
        options: [
          {
            key: 'A',
            service: 'hF9Vywr6oNFbN1ILSeIEc',
            send: ['detalleCert1a2', 'preguntaCertificado'],
            onAccept: ['pagoCertificacion'],
            count: [1, 2],
          },
          {
            key: 'B',
            service: '9By_80n__49szE5uTsoS4',
            send: ['detalleCert3a4', 'preguntaCertificado'],
            onAccept: ['pagoCertificacion'],
            count: [3, 4],
          },
          {
            key: 'C',
            service: 'JRUhh01nF0N2fS4xNONMk',
            send: ['detalleCert5oMas', 'preguntaCertificado'],
            onAccept: ['pagoCertificacion'],
            count: [5, null],
          },
        ],
      },
      routes: [
        {
          id: 'quiere-certificarse',
          when: 'Solo la toma el sistema al elegir una certificación con elegir_opcion: nunca la llames con advance_flow.',
          to: 'mostrar_beneficios',
        },
        {
          id: 'sin-experiencia',
          when: 'El alumno dice que no tiene experiencia operando maquinaria, quiere ver los cursos, o prefiere un curso en vez de certificarse.',
          to: 'listado_servicios',
        },
      ],
    },

    // Entre "ya eligió" y "dame tus datos": le muestra lo que recibe al
    // terminar antes de pedir la captura del pago. Cruzan los dos caminos.
    {
      node: 'mostrar_beneficios',
      extraInstructions: [
        // Regresión del 2026-10-01: "Sí, ¿cómo hago el pago?" se contestaba con
        // texto y el mensaje de pago o el pedido del DNI nunca salían. Y en prod
        // (1/10 13:39) "SI CLARO, ¿DAN FACTURA BOLETA?" se escaló en vez de
        // avanzar. El dueño: un "sí" se INTERPRETA, no se detecta por una
        // palabra; ante la duda se pregunta, sin cortar el flujo.
        'Cuando los mensajes de este paso ya le llegaron, lee su respuesta ENTERA en contexto y decide cuál de estos tres casos es:',
        '1. SÍ CLARO: acepta la oferta, aunque además pregunte otra cosa ("si claro, ¿dan factura?", "dale, ¿cómo pago?", "quiero inscribirme", "¿qué necesito?", "¿con el descuento cuánto me queda?"). Llamá advance_flow con la ruta "continua" en ese mismo turno, NO respondas sus preguntas y NO escales: el mensaje de pago (curso) o el pedido del DNI (certificación) es la respuesta. En certificación es igual, frente a "¿Realizamos tus certificados?".',
        '2. DUDOSO: no se sabe si acepta ("ok", "mmm", "puede ser", "lo veo", o solo una pregunta sin un sí). Respondé corto (con las "Respuestas del negocio" o "Esa consulta te la confirma el asesor 😊") y cerrá volviendo a la pregunta del paso: "¿Te gustaría obtener tu descuento? 😊" (curso) o "¿Realizamos tus certificados? 😊" (certificación). No avances ni escales.',
        '3. NO o "lo pienso": "Entendido, estaré al tanto si deseas continuar 😊" y nada más.',
        // G03 ×3 (2026-09-30): "el curso C" recibió el detalle de la
        // certificación C. Desde 2026-10-06 la oferta (beneficios y descuento, o
        // el detalle de la certificación) la elige y la manda el código al entrar
        // (`choices` del paso anterior): acá ya no se decide qué mensaje mandar.
        'La oferta de lo que eligió ya le llegó sola al entrar a este paso: nunca la repitas ni la resumas, y no inventes ningún monto.',
        // 2026-10-06: la oferta dice arriba qué opción es; si el alumno ve que no
        // era esa, la corrige acá (`rechoose`). Una letra sola la resuelve el
        // código sin la IA.
        'Si quiere OTRA opción ("mejor la B", "en realidad son 3 máquinas", "prefiero el avanzado"), llamá elegir_opcion con lo que dijo: el sistema le manda la oferta nueva. No escribas nada más.',
        'Nunca pidas el DNI ni datos de pago con tus palabras: eso lo hace el paso siguiente con su mensaje fijo.',
      ].join('\n'),
      // El genérico ("Esto es lo que vas a tener. ¿Seguimos con tu
      // inscripción?") lo copió tal cual en G02#1, sin mandar el mensaje fijo.
      example: '¡Genial! 😊',
      // Antes: "repetí la pregunta del último mensaje fijo". Lo leía como
      // "volvé a mandarlo", y a leads de curso les llegó "¿Realizamos tus
      // certificados?" (R01#3, R02#1, R16#1).
      edgeCases: [
        'Si pregunta algo antes de decidir, es el caso DUDOSO: contestá corto con lo que sabés (sin repetir mensajes fijos) y volvé a la pregunta del paso.',
      ],
      // Los 2 mensajes fijos SON la respuesta del turno en que se entra: el
      // último ya termina con su pregunta. Cualquier texto propio de Emma en ese
      // turno se descarta en código — pedírselo por instrucción falló 4 veces.
      fixedOnly: true,
      cta: false,
      rechoose: true,
      routes: [
        {
          id: 'continua',
          when: 'Solo con un SÍ CLARO al descuento (curso) o a "¿Realizamos tus certificados?" (certificación): sí, sí claro, dale, acepto, quiero inscribirme, o pregunta cómo pagar, qué necesita, qué enviar o cuánto le queda con el descuento — aunque pregunte además por efectivo, cuotas, factura o boleta.',
          to: 'solicitar_pago',
        },
      ],
    },

    {
      node: 'solicitar_pago',
      extraInstructions: [
        // 2026-10-06: el mensaje de pago (o el pedido del DNI) lo manda el código
        // al entrar, según lo que eligió (`choices.onAccept`). Antes lo elegía la IA
        // con una lista propia, y una vez cobró el descuento de otro curso.
        'El mensaje de pago (curso) o el pedido del DNI (certificación) ya le llegó solo al entrar a este paso: no lo repitas ni lo escribas vos.',
        'No escribas ningún otro monto: en un curso el único pago es la inscripción de S/ 150, que ya va en el mensaje. Si vuelve a preguntar cómo pagar: "Por aquí la inscripción es por Yape 934833829, a nombre del Director Ejecutivo del Instituto: Alexis Gamaniel Pérez Palacios. Lo demás te lo confirma el asesor 😊" En una certificación no se paga por chat: solo se espera el DNI.',
        // G01, C02, C06 (2026-09-30): el texto "aquí está" se procesa antes que
        // la foto (que espera 10 s por si vienen más), y Emma contestaba "no
        // recibí la captura" con la foto en camino.
        'Si el alumno dice que ya mandó o que está mandando la captura o el DNI, respondé solo "Perfecto, quedo atenta 😊" y nada más. Nunca digas que no la recibiste ni pidas que la reenvíe: la foto llega aparte y no la ves.',
        'Nunca confirmes que el pago o el DNI se recibió o se validó: eso lo hace el asesor.',
        // R11 (2026-10-01): "hay cupos disponibles y tienes hasta este lunes".
        'Si pregunta por cupos o cuándo empieza: solo "Empezamos este lunes 😊".',
        // R21 (2026-10-01): "aquí está la captura" sin adjuntarla → 13 "quedo
        // atenta" seguidos. Si la foto hubiera llegado, Emma ya estaría pausada:
        // que vuelva a preguntar es la prueba de que no llegó.
        'Si ya le respondiste "Perfecto, quedo atenta 😊" y vuelve a escribir (por ejemplo "¿ya quedó?"), la foto NO llegó: respondé "Aún no me llega la captura 🙏 ¿Me la reenvías por aquí?" (o "la foto de tu DNI" en certificación).',
      ].join('\n'),
      example: 'Perfecto, quedo atenta 😊',
      edgeCases: [
        'Si pregunta algo más antes de mandar la captura o el DNI, respondé corto (con las "Respuestas del negocio" o "Esa consulta te la confirma el asesor 😊") y cerrá pidiendo el requisito: "¿Me envías la captura del pago? 😊" (curso) o "¿Me envías la foto de tu DNI? 😊" (certificación). No escales por eso.',
      ],
      // El monto va en un mensaje fijo por curso, no en una lista dentro de
      // las instrucciones: con la lista, el modelo le cobró S/ 100 (BÁSICO) a
      // un alumno de OPERACIÓN MÚLTIPLE (S/ 200). Y ese mensaje es la
      // respuesta entera: termina en "me mandas la captura", sin nada atrás.
      fixedOnly: true,
      cta: false,
      // Con la primera foto (DNI o voucher): se la reenvía al dueño y Emma se
      // pausa en ese chat. El dueño la vuelve a prender desde el Inbox.
      // `reply` (2026-10-01): lo de siempre era "¡Recibí tu imagen! Dame un
      // momentito y te confirmo 😊", y Emma queda pausada: nunca confirma nada.
      onImage: FOTO_AL_DUENO,
    },

    { node: 'confirmed' },
  ],

  fixedMessages: {
    // Los dos `openWith`: los manda el código al entrar al paso, sin servicio,
    // así que no pueden llevar {precio} ni {servicio}. El `when` es para quien
    // lee el archivo — la IA nunca los ve como opción.
    presentacion: {
      when: 'Al entrar al saludo (conversación nueva, o de vuelta después de 24 h).',
      text: 'Hola 👋👷‍♀️ soy Nicole Perez, asesora comercial del Instituto Tecmin',
    },
    listadoCertificaciones: {
      when: 'Al entrar a la asesoría con experiencia: las 3 certificaciones, sin precio.',
      text: [
        'Estas son nuestras certificaciones por experiencia:',
        'A. Certificación de 1 a 2 maquinarias',
        'B. Certificación de 3 a 4 maquinarias',
        'C. Certificación de 5 maquinarias o más',
        'Coméntame, ¿Cuál de estas opciones es la que deseas?',
      ].join('\n'),
    },
    introCursos: {
      when: 'Al entrar al listado de cursos, antes de las fichas.',
      text: 'Genial, ahora te paso un resumen de tus cursos',
    },
    // Los beneficios, uno por curso porque cambia la duración (ver
    // beneficiosDeCurso). Las fotos se suben desde el panel (/asistente →
    // "Fotos de tus mensajes automáticos"), una vez por curso; sin foto, el
    // mensaje sale solo con el texto. {precio} es la inversión SEMANAL de ese
    // curso (así carga el dueño el precio en el panel: Básico 220, Avanzado
    // 260, Múltiple 260). Reemplazan a `beneficiosCurso` (una sola duración).
    beneficiosBasico: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: beneficiosDeCurso('6 semanas (01 mes y medio)'),
      images: true,
    },
    beneficiosAvanzado: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: beneficiosDeCurso('12 semanas (3 meses)'),
      images: true,
    },
    beneficiosMultiple: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: beneficiosDeCurso('22 semanas (5 meses y medio)'),
      images: true,
    },
    // El detalle de cada certificación (2026-09-30): precio del curso completo
    // y precio promo, escritos acá — no hay campo para el precio original en
    // el panel, y así el monto lo pone el código, nunca la IA. Uno por opción,
    // cada uno con su foto del carnet (se sube en el panel, una vez por opción).
    // Reemplazan a beneficiosCertificado y a los descuentos de certificación:
    // en este camino no hay descuento, el precio promo ES la oferta.
    detalleCert1a2: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: detalleCertificado('S/. 3000.00', 'S/. 295.00'),
      images: true,
    },
    detalleCert3a4: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: detalleCertificado('S/. 4000.00', 'S/. 395.00'),
      images: true,
    },
    detalleCert5oMas: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: detalleCertificado('S/. 5000.00', 'S/. 495.00'),
      images: true,
    },
    // Aparte del detalle para que salga DESPUÉS de la foto del carnet.
    preguntaCertificado: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: '¿Realizamos tus certificados?',
    },
    // El gancho de venta: descuento por curso (S/ 100, 300 y 800). Uno por
    // curso porque cada uno tiene el suyo — no hay un campo de "descuento" en
    // el servicio, así que el monto va tal cual acá. Texto del 2026-09-30.
    descuentoBasico: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: descuentoCurso('S/ 100'),
    },
    descuentoAvanzado: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: descuentoCurso('S/ 300'),
    },
    descuentoMultiple: {
      when: 'Lo manda el código al elegir la opción (`choices`): nunca lo pide la IA.',
      text: descuentoCurso('S/ 800'),
    },
    // Primera inversión de un curso (2026-09-30): S/ 150.00 para los tres, con
    // lo que incluye y el Yape del Director Ejecutivo del Instituto: Alexis Gamaniel Pérez Palacios. Sigue siendo uno por curso
    // porque el monto del DESCUENTO que menciona cambia: con los montos en una
    // lista, el modelo ya mezcló una vez cuál era de quién.
    pagoBasico: {
      when: 'Lo manda el código al entrar a solicitar_pago, según la opción elegida (`choices.onAccept`).',
      text: pagoCurso('S/ 100'),
    },
    pagoAvanzado: {
      when: 'Lo manda el código al entrar a solicitar_pago, según la opción elegida (`choices.onAccept`).',
      text: pagoCurso('S/ 300'),
    },
    pagoMultiple: {
      when: 'Lo manda el código al entrar a solicitar_pago, según la opción elegida (`choices.onAccept`).',
      text: pagoCurso('S/ 800'),
    },
    pagoCertificacion: {
      when: 'Lo manda el código al entrar a solicitar_pago, según la opción elegida (`choices.onAccept`).',
      text: [
        'Para empezar a realizar el tramite de tus certificados. Enviame la foto de tu DNI.',
      ].join('\n'),
    },
  },
})
