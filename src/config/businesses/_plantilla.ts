import { defineBusinessConfig } from './define.js'

// The file to copy when a business moves its conversation into the repo. It is
// NOT listed in index.ts, so it never applies to anyone; it only has to compile.
//
// Everything a step does not mention keeps the catalogue's wording. What cannot
// be written here on purpose: a step's objective and steps, which are the motor
// (nodes/*.nodes.ts), and which tools it offers.

export default defineBusinessConfig({
  businessId: '00000000-0000-0000-0000-000000000000',
  name: 'Instituto de ejemplo',
  flowType: 'sales',

  flow: [
    { node: 'idle' },
    {
      node: 'greeting',
      example: '¡Hola! Soy Emma, del Instituto de ejemplo. ¿Te interesa algún curso?',
    },
    { node: 'informing' },
    {
      node: 'listado_servicios',
      extraInstructions: 'Si preguntan por becas, deciles que hay 20% para egresados.',
      routes: [
        {
          id: 'ruta-cierre',
          when: 'El cliente eligió un curso concreto y quiere inscribirse.',
          to: 'collect_data',
        },
      ],
    },
    {
      node: 'collect_data',
      edgeCases: ['Si no tiene el DNI a la mano, tomá el resto y pedilo al final.'],
    },
    { node: 'confirmacion' },
    { node: 'correccion_datos' },
    { node: 'confirmed' },
  ],
})
