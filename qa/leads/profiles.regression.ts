import { type LeadProfile, MANDA_CAPTURA, MANDA_DNI } from './profiles.js'

// Regresión del 2026-09-30: un perfil por cada cosa que se rompió en la corrida
// de 141 conversaciones (functional-20261001-023119) y por cada regla de venta
// que el dueño definió después. Nada más: lo que ya funcionaba no se repite acá.
//
// Cada `expected.behavior` dice qué tiene que pasar y, entre corchetes, de qué
// fallo o regla viene. Se corren con `--profiles regresion`.

export const REGRESSION_PROFILES: LeadProfile[] = [
  // ── Cierre equivocado curso ↔ certificación ─────────────────────────────────
  {
    id: 'R01',
    category: 'R',
    title: 'Curso C (Operación Múltiple) elegido por letra',
    style: 'sin_tildes',
    first: 'AD',
    persona: `Nunca operaste maquinaria. Cuando te pregunten, dices que quieres empezar desde cero. Cuando te muestren los cursos, eliges escribiendo solo "la c". Aceptas el descuento con "si". ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'beneficiosMultiple (22 semanas) + descuento S/ 800 → pagoMultiple. NUNCA detalleCert5oMas ni el pedido de DNI. [G03 ×3]',
    },
    seed: 2001,
  },
  {
    id: 'R02',
    category: 'R',
    title: '"Quiero el curso avanzado" aunque manejó un poco',
    style: 'corto',
    first: 'hola, quiero el curso avanzado. maneje un poco la retro de mi primo',
    persona: `Quieres el curso AVANZADO para aprender bien; manejaste un poco una retro pero no te consideras operador. Si te ofrecen certificación, dices que no, que quieres el curso avanzado. Aceptas el descuento. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'Va a cursos (no a la lista de certificaciones) → beneficiosAvanzado + descuento S/ 300 → pagoAvanzado. [C03, D04, E06]',
    },
    seed: 2002,
  },
  {
    id: 'R03',
    category: 'R',
    title: 'Abre con "precio de la certificación?"',
    style: 'seco',
    first: 'precio de la certificacion?',
    persona: `Operas excavadora, retro y cargador hace años. Quieres el precio. Cuando te muestren las opciones, eliges "la B". Si te convence, dices "si". ${MANDA_DNI}`,
    attachments: ['dni'],
    expected: {
      path: 'certificacion',
      final: ['CIERRE-DNI'],
      behavior:
        'Lista A/B/C SIN precios (no los lista en texto) → B → detalle S/. 4000.00 → S/. 395.00 → DNI. [A10 ×3]',
    },
    seed: 2003,
  },

  // ── Escalada a leads que querían pagar (regla 8) ────────────────────────────
  {
    id: 'R04',
    category: 'R',
    title: 'Curso: "sí, ¿cómo pago?"',
    style: 'formal',
    first: 'AD',
    persona: `No tienes experiencia. Eliges el curso básico. Cuando te ofrezcan el descuento respondes exactamente "Sí, me interesa. ¿Cómo hago el pago?". ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior: 'Manda pagoBasico en ese mismo turno. NUNCA escala. [A11#1, A01#1, G04 ×2]',
    },
    seed: 2004,
  },
  {
    id: 'R05',
    category: 'R',
    title: 'Certificación: "sí, ¿qué necesito enviar?"',
    style: 'corto',
    first: 'hola, opero cargador frontal hace 5 años, quiero certificarme',
    persona: `Operas cargador frontal (1 máquina). Eliges la A. A "¿Realizamos tus certificados?" respondes "si, que necesito enviar?". ${MANDA_DNI}`,
    attachments: ['dni'],
    expected: {
      path: 'certificacion',
      final: ['CIERRE-DNI'],
      behavior:
        'Manda pagoCertificacion (pide el DNI) en ese mismo turno. NUNCA escala. [A08#3, G04#3]',
    },
    seed: 2005,
  },

  // ── Reglas de venta del dueño ───────────────────────────────────────────────
  {
    id: 'R06',
    category: 'R',
    title: 'Pide el total del curso y con descuento',
    style: 'sin_tildes',
    first: 'AD',
    persona: `No tienes experiencia. Eliges el curso basico. Antes de aceptar preguntas "cuanto es en total el curso?" y, si no te dan un total, "y con el descuento cuanto me queda?". Luego aceptas. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'Responde "La inversión es semanal (S/ 220 por semana)…". Nunca un total ni una resta. [regla 1; D07 ×3, A03#1]',
    },
    seed: 2006,
  },
  {
    id: 'R07',
    category: 'R',
    title: 'Pregunta validez: minería, MTC, todo el Perú',
    style: 'sin_tildes',
    first: 'buenas, opero excavadora 4 años, quiero certificarme',
    persona: `Operas excavadora. Antes de elegir preguntas "el certificado vale para mineria?", "esta reconocido por el MTC?" y "sirve en todo el peru?". Después eliges la A y aceptas. ${MANDA_DNI}`,
    attachments: ['dni'],
    expected: {
      path: 'certificacion',
      final: ['CIERRE-DNI'],
      behavior:
        'Solo "firma del Instituto Tecmin y del Colegio de Ingenieros, válidos en todo el Perú". Nunca MTC ni minería. [regla 2; D01 ×2]',
    },
    seed: 2007,
  },
  {
    id: 'R08',
    category: 'R',
    title: 'Vive en Lima: sede, virtual, práctica',
    style: 'formal',
    first: 'AD',
    persona:
      'Vives en Lima. No tienes experiencia. Preguntas "¿Tienen sede en Lima?", "¿Las clases pueden ser virtuales?" y "¿Dónde son las prácticas?". Si todo es en Huancayo, dices "Lo voy a pensar, gracias". No mandas fotos.',
    attachments: [],
    expected: {
      path: 'curso',
      final: ['listado_servicios', 'informing', 'mostrar_beneficios'],
      behavior:
        'Presencial solo en Huancayo (Junín); sin sede en Lima ni virtual. Al "lo voy a pensar": "Entendido, estaré al tanto si deseas continuar 😊". [reglas 3 y 10; D06]',
    },
    seed: 2008,
  },
  {
    id: 'R09',
    category: 'R',
    title: 'Pregunta requisitos y ofrece sus datos',
    style: 'corto',
    first: 'AD',
    persona: `No tienes experiencia. Eliges el curso avanzado. Antes de pagar preguntas "que requisitos piden?" y "te mando mi nombre completo, dni y correo?". Aceptas el descuento. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'Para el curso solo el pago; nunca pide nombre, DNI, correo ni teléfono. [regla 4; A07#3, B01#1, C05#2]',
    },
    seed: 2009,
  },
  {
    id: 'R10',
    category: 'R',
    title: 'Pregunta por efectivo, cuotas y factura',
    style: 'sin_tildes',
    first: 'AD',
    persona: `No tienes experiencia. Eliges el curso basico. Cuando te hablen de pagar preguntas "puedo pagar en efectivo?", "se puede en cuotas?" y "dan factura?". Al final pagas por Yape. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        '"Por aquí la preinscripción es por Yape; los demás detalles te los da el asesor." Nunca "se puede en efectivo". [regla 5; C08#3]',
    },
    seed: 2010,
  },
  {
    id: 'R11',
    category: 'R',
    title: 'Pregunta cupos y fecha de inicio',
    style: 'rafaga',
    first: 'AD',
    persona: `No tienes experiencia. Eliges el curso avanzado. En ráfaga preguntas "quedan cupos?", "cuando empiezan?", "hasta cuando es el descuento?". Luego aceptas. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior: 'Solo "este lunes"; nunca cupos, vacantes ni plazos. [regla 6; D04#3, C01#1]',
    },
    seed: 2011,
  },
  {
    id: 'R12',
    category: 'R',
    title: 'Pregunta qué máquinas enseña cada curso',
    style: 'corto',
    first: 'AD',
    persona: `No tienes experiencia. Preguntas "el basico enseña excavadora?" y "que maquinas tiene el avanzado?". Te quedas con el que nombre la excavadora; si ninguno, eliges operacion multiple. Aceptas el descuento. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'Solo lo que dice cada descripción: nunca "el Básico incluye excavadora". Solo Múltiple nombra sus 7 equipos. [regla 7; B01 ×3]',
    },
    seed: 2012,
  },
  {
    id: 'R13',
    category: 'R',
    title: 'Pide hablar con una persona',
    style: 'corto',
    first: 'AD',
    persona:
      'Quieres hablar con una persona del instituto, no con un chat. Escribes "quiero hablar con una persona" y, si te ofrecen otra cosa, lo repites. No mandas fotos.',
    attachments: [],
    expected: {
      path: 'ninguno',
      final: ['ESCALADA'],
      behavior: 'Escala (es el caso que SÍ corresponde). [regla 8]',
    },
    seed: 2013,
  },
  {
    id: 'R14',
    category: 'R',
    title: 'Insiste con algo que Emma no sabe',
    style: 'corto',
    first: 'AD',
    persona:
      'No tienes experiencia. Preguntas "el profesor es ingeniero?". Si no te responden claro, lo vuelves a preguntar una vez más con otras palabras. Después dices que lo vas a pensar. No mandas fotos.',
    attachments: [],
    expected: {
      path: 'curso',
      final: ['ESCALADA', 'listado_servicios', 'mostrar_beneficios', 'informing'],
      behavior:
        'Responde "Son ingenieros, instructores y técnicos, todos especializados en maquinaria y en el sector minero" cada vez que pregunta, aunque repregunte "¿ingeniero en qué?" (criterio del dueño, 2026-10-01). Nunca lo manda al asesor ni "no tengo esa información". [regla 8; E05; regresión 3 R14#2]',
    },
    seed: 2014,
  },
  {
    id: 'R15',
    category: 'R',
    title: 'Manda el DNI junto con el "sí", antes de que se lo pidan',
    style: 'corto',
    first: 'hola, opero excavadora y retro, quiero mis certificados',
    persona: `Operas 2 máquinas. Eliges la A. A "¿Realizamos tus certificados?" respondes "si" y en ese MISMO turno mandas la foto del DNI (attachment "dni"). Si después te piden el DNI, lo vuelves a mandar.`,
    attachments: ['dni'],
    expected: {
      path: 'certificacion',
      final: ['CIERRE-DNI', 'cualquiera'],
      behavior:
        'Regla del dueño del 2026-10-01: cualquier foto se reenvía al dueño, Emma se pausa y responde solo "Recibido ✅ En breve un asesor se comunicará contigo." [C06, G02#3]',
    },
    seed: 2015,
  },
  {
    id: 'R16',
    category: 'R',
    title: 'Manda la captura antes de elegir',
    style: 'rafaga',
    first: 'AD',
    persona: `Un amigo te pasó el Yape. Apenas veas los cursos, mandas una captura (attachment "captura") con "ya te yapee para el basico". Después sigues lo que te diga y, cuando te pidan la captura, la vuelves a mandar.`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO', 'cualquiera'],
      behavior:
        'Regla del dueño del 2026-10-01: la captura, aunque llegue antes de elegir, se reenvía al dueño, Emma se pausa y responde solo "Recibido ✅…". Nunca sigue la inscripción por su cuenta. [C01 ×3, R02#1]',
    },
    seed: 2016,
  },
  {
    id: 'R17',
    category: 'R',
    title: 'Dice que no al descuento',
    style: 'corto',
    first: 'AD',
    persona:
      'No tienes experiencia. Eliges el curso basico. Al descuento respondes "no gracias, por ahora no". Te despides. No mandas fotos.',
    attachments: [],
    expected: {
      path: 'curso',
      final: ['mostrar_beneficios'],
      behavior:
        '"Entendido, estaré al tanto si deseas continuar 😊". Sin insistir ni escalar. [regla 10]',
    },
    seed: 2017,
  },
  {
    id: 'R18',
    category: 'R',
    title: '¿Eres un bot?',
    style: 'corto',
    // Abre con la pregunta: con el anuncio de primer mensaje, el lead simulado
    // nunca llegó a preguntarlo (regresión del 2026-10-01).
    first: 'hola, eres un bot?',
    persona: `Abriste preguntando "eres un bot?". Si no te queda claro, preguntas "eres una IA o una persona?". Después dices que no tienes experiencia, eliges el curso basico y aceptas el descuento. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'Se presenta como "Nicole, asesora comercial del Instituto Tecmin"; nunca dice bot, IA ni asistente virtual. [regla 11; F03]',
    },
    seed: 2018,
  },
  {
    id: 'R19',
    category: 'R',
    title: '¿Cuánto tarda el certificado?',
    style: 'sin_tildes',
    first: 'hola, ya opero cargador frontal, quiero certificarme',
    persona: `Operas 1 máquina. Eliges la A. Antes de aceptar preguntas "en cuanto tiempo me dan el certificado?". Luego aceptas. ${MANDA_DNI}`,
    attachments: ['dni'],
    expected: {
      path: 'certificacion',
      final: ['CIERRE-DNI'],
      behavior: '"Lo hacemos al instante." Sin días ni fechas. [regla 12; D04]',
    },
    seed: 2019,
  },

  // ── Fallos de manejo de fotos y del flujo ───────────────────────────────────
  {
    id: 'R20',
    category: 'R',
    title: 'Escribe "ahí va la captura" y la foto llega después',
    style: 'corto',
    first: 'AD',
    persona:
      'No tienes experiencia. Eliges el curso avanzado y aceptas el descuento. Cuando te pidan la captura, en el mismo turno escribes "listo, ahi te mando la captura" y mandas la captura (attachment "captura").',
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'Al texto: "Perfecto, quedo atenta 😊". Nunca "no recibí la captura". La foto se reenvía y Emma se pausa. [G01, C02, C06#1]',
    },
    seed: 2020,
  },
  {
    id: 'R21',
    category: 'R',
    title: 'Dice "aquí está la captura" sin adjuntarla',
    style: 'corto',
    first: 'AD',
    persona:
      'No tienes experiencia. Eliges el curso basico y aceptas el descuento. Cuando te pidan la captura escribes "aqui esta la captura" pero NO adjuntas nada. Luego preguntas "ya quedo?" y te despides.',
    attachments: [],
    expected: {
      path: 'curso',
      final: ['solicitar_pago'],
      behavior: 'Nunca "he recibido tu captura" ni confirma un pago. [A02#3]',
    },
    seed: 2021,
  },
  {
    id: 'R22',
    category: 'R',
    title: '"Hola, ¿sigue el descuento?" a mitad del flujo',
    style: 'corto',
    first: 'AD',
    persona: `No tienes experiencia. Eliges el curso avanzado. Al descuento respondes "dejame ver". En tu siguiente turno escribes "hola, sigue el descuento?" y después aceptas. ${MANDA_CAPTURA}`,
    attachments: ['captura'],
    expected: {
      path: 'curso',
      final: ['CIERRE-PAGO'],
      behavior:
        'No vuelve a preguntar "¿tienes experiencia…?" a mitad del flujo; responde y sigue al pago. [E06, C02#3]',
    },
    seed: 2022,
  },
  {
    id: 'R23',
    category: 'R',
    title: 'Sin experiencia pide "el certificado para trabajar"',
    style: 'corto',
    first: 'cuanto cuesta el certificado de operador? quiero trabajar',
    persona:
      'Nunca manejaste ninguna máquina, lo admites si te preguntan. Preguntas "con el certificado ya me contratan?". Si te recomiendan un curso, dices que lo vas a pensar. No mandas fotos.',
    attachments: [],
    expected: {
      path: 'curso',
      // ESCALADA: si pide el contacto del asesor, pasarlo es lo correcto (regla
      // del dueño, regresión 4).
      final: ['listado_servicios', 'mostrar_beneficios', 'ESCALADA'],
      behavior:
        'Al decir que no maneja máquinas pasa al listado de cursos (fichas con la duración). Trabajo: solo "Con el certificado puedes conseguir trabajo en el sector minero", nunca garantía. Duración solo 6/12/22 semanas, nunca "una semana". [A05 ×3, D02; regresión 3 R23#3]',
    },
    seed: 2023,
  },
  {
    id: 'R24',
    category: 'R',
    title: 'Empresa con 6 operarios',
    style: 'formal',
    first:
      'Buenas tardes, escribo de una constructora. Queremos certificar a 6 operarios. ¿Tienen precio corporativo?',
    persona:
      'Eres de RRHH de una constructora. Quieres precio corporativo y factura para 6 operarios. Si te pasan con una persona, agradeces. No mandas fotos.',
    attachments: [],
    expected: {
      path: 'ninguno',
      final: ['ESCALADA'],
      behavior:
        'Escala (empresa = caso que SÍ corresponde). No inventa precio corporativo. [regla 8; E03]',
    },
    seed: 2024,
  },
  {
    id: 'R25',
    category: 'R',
    title: 'Alumno actual pregunta su horario de práctica',
    style: 'corto',
    first: 'hola soy alumno del avanzado, a que hora es la practica del jueves?',
    persona:
      'Ya eres alumno del curso avanzado. Quieres saber a qué hora es tu práctica del jueves. Si no te lo dicen, pides hablar con alguien.',
    attachments: [],
    expected: {
      path: 'ninguno',
      final: ['ESCALADA'],
      behavior:
        'No inventa horarios ("jueves a las 3 p.m.") ni lo manda a la lista de certificaciones; escala (alumno actual). [regla 8; E04 ×3]',
    },
    seed: 2025,
  },
]
