import { describe, expect, it } from 'vitest'
import {
  buildStepImageCaption,
  findChosenService,
  fixedMessageServicesOf,
} from './mediaForwarder.js'

// El aviso que recibe el dueño cuando llega una foto en un paso con reenvío, y la
// búsqueda del curso que eligió el cliente. Las dos las arma el código, sin IA: el
// dueño pidió que el resumen llegue tal cual.

const SERVICES = [
  {
    name: 'BÁSICO - Operación y mantenimiento de equipos',
    description: 'Matrícula S/ 150 + S/ 200 al mes.',
  },
  {
    name: 'AVANZADO - Operación y mantenimiento de 3 equipos',
    description: 'Matrícula S/ 150 + S/ 250 al mes.',
  },
  { name: 'Certificación - 1 a 2 máquinas', description: 'CERTIFICADO' },
]

describe('findChosenService', () => {
  it('lo encuentra en lo que Emma guardó, sin importar tildes ni mayúsculas', () => {
    const found = findChosenService(
      SERVICES,
      { 'curso elegido': 'basico - operacion y mantenimiento de equipos' },
      [],
    )
    expect(found?.name).toBe('BÁSICO - Operación y mantenimiento de equipos')
  })

  it('prefiere el nombre más largo cuando uno contiene al otro', () => {
    // "básico intensivo" contiene "básico": sin esta regla ganaba el corto.
    const overlapping = [{ name: 'Básico' }, { name: 'Básico intensivo' }]
    const found = findChosenService(overlapping, { elegido: 'básico intensivo' }, [])
    expect(found?.name).toBe('Básico intensivo')
  })

  it('si no hay nada guardado, usa el mensaje de Emma más nuevo que nombra uno solo', () => {
    const found = findChosenService(SERVICES, {}, [
      'Perfecto, para la Certificación - 1 a 2 máquinas necesito la foto de tu DNI.',
      'Tenemos BÁSICO - Operación y mantenimiento de equipos y AVANZADO - Operación y mantenimiento de 3 equipos.',
    ])
    expect(found?.description).toBe('CERTIFICADO')
  })

  it('saltea un mensaje que lista varios servicios: no dice cuál eligió', () => {
    const found = findChosenService(SERVICES, {}, [
      'Tenemos BÁSICO - Operación y mantenimiento de equipos y AVANZADO - Operación y mantenimiento de 3 equipos.',
    ])
    expect(found).toBeNull()
  })

  it('devuelve null si no hay rastro de ninguno', () => {
    expect(
      findChosenService(SERVICES, { nombre: 'Juan Pérez' }, ['Hola, ¿en qué te ayudo?']),
    ).toBeNull()
  })

  it('lo saca de los mensajes fijos aunque ningún texto lo nombre ni haya nada guardado', () => {
    // El caso real de Tecmin: todo salió como mensaje fijo, sin el nombre en el
    // texto, y save_customer_data nunca se llamó.
    const found = findChosenService(
      SERVICES,
      {},
      ['1. Envíame la foto de tu DNI, ambas caras…'],
      ['Certificación - 1 a 2 máquinas'],
    )
    expect(found?.description).toBe('CERTIFICADO')
  })
})

describe('fixedMessageServicesOf', () => {
  function call(name: string, args: string) {
    return { type: 'function', function: { name, arguments: args } }
  }

  it('devuelve los servicios de send_fixed_message, del más nuevo al más viejo', () => {
    const services = fixedMessageServicesOf([
      { role: 'user', toolCalls: null },
      {
        role: 'assistant',
        toolCalls: [
          call('send_fixed_message', '{"message":"beneficiosCurso","service":"BÁSICO"}'),
          call('send_fixed_message', '{"message":"descuentoBasico","service":"BÁSICO 2"}'),
        ],
      },
      { role: 'tool', toolCalls: null },
      {
        role: 'assistant',
        toolCalls: [call('send_fixed_message', '{"message":"pagoBasico","service":"BÁSICO 3"}')],
      },
    ])
    expect(services).toEqual(['BÁSICO 3', 'BÁSICO 2', 'BÁSICO'])
  })

  it('saltea otras tools, JSON roto y formas raras', () => {
    const services = fixedMessageServicesOf([
      {
        role: 'assistant',
        toolCalls: [
          call('advance_flow', '{"branch":"continua"}'),
          call('send_fixed_message', '{roto'),
          call('send_fixed_message', '{"message":"x"}'),
          'no es un objeto',
        ],
      },
      { role: 'assistant', toolCalls: { no: 'es un array' } },
    ])
    expect(services).toEqual([])
  })
})

describe('buildStepImageCaption', () => {
  const base = {
    stepLabel: 'Captura de datos',
    customer: { name: 'juan pérez', phone: '+51901233587' },
    receivedAt: new Date('2026-09-23T19:32:00Z'),
    timezone: 'America/Lima',
    said: null,
  }

  it('pega el resumen tal cual, sin tocarlo', () => {
    const caption = buildStepImageCaption({ ...base, summary: 'CERTIFICADO', paused: true })
    expect(caption).toContain('📋 Resumen: CERTIFICADO')
    expect(caption).toContain('«Captura de datos»')
    expect(caption).toContain('+51901233587')
  })

  it('avisa que el asistente quedó pausado cuando el paso lo pausa', () => {
    expect(buildStepImageCaption({ ...base, summary: 'X', paused: true })).toContain(
      'El asistente quedó pausado',
    )
    expect(buildStepImageCaption({ ...base, summary: 'X', paused: false })).toContain(
      '¿Qué le respondo?',
    )
  })

  it('dice que no identificó la elección en vez de inventar una', () => {
    const caption = buildStepImageCaption({ ...base, summary: null, paused: false })
    expect(caption).toContain('no se pudo identificar qué eligió')
  })

  it('en un grupo, la primera foto lleva el aviso completo y las demás uno corto', () => {
    const first = buildStepImageCaption({
      ...base,
      summary: 'CERTIFICADO',
      paused: true,
      photo: { index: 0, total: 3 },
    })
    expect(first).toContain('3 fotos recibidas en «Captura de datos»')
    expect(first).toContain('📋 Resumen: CERTIFICADO')

    const second = buildStepImageCaption({
      ...base,
      summary: 'CERTIFICADO',
      paused: true,
      photo: { index: 1, total: 3 },
    })
    expect(second).toBe('📷 Foto 2 de 3 · Juan Pérez')
  })
})
