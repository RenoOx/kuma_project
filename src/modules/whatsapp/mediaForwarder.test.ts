import { describe, expect, it } from 'vitest'
import { buildStepImageCaption, findChosenService } from './mediaForwarder.js'

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

  it('avisa que Emma quedó pausada cuando el paso la pausa', () => {
    expect(buildStepImageCaption({ ...base, summary: 'X', paused: true })).toContain(
      'Emma quedó pausada',
    )
    expect(buildStepImageCaption({ ...base, summary: 'X', paused: false })).toContain(
      '¿Qué le respondo?',
    )
  })

  it('dice que no identificó la elección en vez de inventar una', () => {
    const caption = buildStepImageCaption({ ...base, summary: null, paused: false })
    expect(caption).toContain('no se pudo identificar qué eligió')
  })
})
