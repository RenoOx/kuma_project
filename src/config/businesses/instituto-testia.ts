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

    {
      node: 'informing',
      extraInstructions: [
        'El saludo ya le preguntó si tiene experiencia en maquinaria pesada. Según lo que responda:',
        '- Si TIENE experiencia: preguntale "¿Cuántas maquinarias manejas?". Con ese número ofrecé la certificación de su tramo, con el nombre exacto: 1 a 2 máquinas → Certificación - 1 a 2 máquinas (S/ 295, precio original S/ 3 000). 3 a 4 máquinas → Certificación - 3 a 4 máquinas (S/ 349, precio original S/ 4 000). 5 o más → Certificación - 5 máquinas o más (S/ 499, precio original S/ 5 000). A este alumno no le ofrezcas los cursos.',
        '- Si NO tiene experiencia: mostrale los tres cursos de la categoría Cursos con show_services, cada uno por separado.',
        '',
        PRECIOS_CURSOS,
      ].join('\n'),
      routes: [
        {
          id: 'certificacion',
          when: 'El alumno tiene experiencia, ya dijo cuántas máquinas maneja y quiere avanzar con la certificación.',
          to: 'collect_data',
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
        'Mostrá los tres cursos de la categoría Cursos con show_services, cada uno por separado: no los agrupes ni los resumas.',
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
})
