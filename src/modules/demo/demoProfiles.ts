import type { KbCategory } from '@/db/schema/index.js'
import type { BusinessSettings, Service } from '@/modules/business/business.settings.js'

export interface DemoKbEntry {
  category: KbCategory
  content: string
  // Optional: demo entries are one-liners, so the title derived from the
  // content is already the right label. Set it only when that reads badly.
  title?: string
}

export interface DemoProfile {
  name: string
  settings: BusinessSettings
  kbEntries: DemoKbEntry[]
}

const CLOSED = null

// Demo profiles carry no real prices — the actual rates of these businesses
// live outside the repo. Evaluation-first is the honest mapping: with nothing
// on file, Emma must ask instead of quoting a number it made up.
function service(name: string, durationMinutes: number): Service {
  return {
    name,
    durationMinutes,
    priceMin: null,
    priceMax: null,
    requiresEvaluation: true,
  }
}

const BARBERIA: DemoProfile = {
  name: 'Imperio Barber Studio',
  settings: {
    appointmentMode: 'appointments_only',
    slotDurationMinutes: 15,
    services: [
      service('corte clásico', 45),
      service('corte degradado', 60),
      service('corte con tijera', 50),
      service('corte infantil', 40),
      service('corte con diseño', 50),
      service('mohicano', 50),
      service('arreglo de barba', 30),
      service('corte y barba', 55),
      service('afeitado a navaja', 30),
      service('perfilado de cejas', 10),
      service('mascarilla facial', 20),
      service('ondulación', 90),
      service('tinte', 45),
      service('tratamiento capilar', 30),
    ],
    operatingHours: {
      monday:    { open: '09:30', close: '21:30' },
      tuesday:   { open: '09:30', close: '21:30' },
      wednesday: { open: '09:30', close: '21:30' },
      thursday:  { open: '09:30', close: '21:30' },
      friday:    { open: '09:30', close: '21:30' },
      saturday:  { open: '09:30', close: '21:30' },
      sunday:    CLOSED,
    },
  },
  kbEntries: [
    { category: 'precios', content: 'Corte clásico: S/ 25' },
    { category: 'precios', content: 'Corte degradado: S/ 30' },
    { category: 'precios', content: 'Corte con tijera: S/ 28' },
    { category: 'precios', content: 'Corte infantil: S/ 20' },
    { category: 'precios', content: 'Corte con diseño: S/ 35' },
    { category: 'precios', content: 'Mohicano: S/ 35' },
    { category: 'precios', content: 'Arreglo de barba: S/ 15' },
    { category: 'precios', content: 'Corte y barba: S/ 40' },
    { category: 'precios', content: 'Afeitado a navaja: S/ 20' },
    { category: 'precios', content: 'Perfilado de cejas: S/ 10' },
    { category: 'precios', content: 'Mascarilla facial: S/ 20' },
    { category: 'precios', content: 'Ondulación: S/ 60' },
    { category: 'precios', content: 'Tinte: S/ 35–50 (varía según el largo)' },
    { category: 'precios', content: 'Tratamiento capilar: S/ 25' },
    { category: 'informacion_general', content: 'Imperio Barber Studio — atendemos de lunes a sábado de 9:30 a 21:30.' },
    { category: 'informacion_general', content: 'Aceptamos efectivo, Yape y Plin.' },
  ],
}

const CONSULTORIO: DemoProfile = {
  name: 'Dental Smile',
  settings: {
    appointmentMode: 'appointments_only',
    slotDurationMinutes: 30,
    minBookingNoticeMinutes: 60,
    services: [
      service('Consulta general', 30),
      service('Limpieza dental', 60),
      service('Blanqueamiento dental', 90),
      service('Extracción simple', 45),
      service('Curación / empaste', 60),
      service('Radiografía digital', 15),
    ],
    operatingHours: {
      monday:    { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      tuesday:   { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      wednesday: { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      thursday:  { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      friday:    { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      saturday:  { open: '08:00', close: '13:00' },
      sunday:    CLOSED,
    },
  },
  kbEntries: [
    { category: 'precios', content: 'Consulta general: S/ 60' },
    { category: 'precios', content: 'Limpieza dental: S/ 120' },
    { category: 'precios', content: 'Blanqueamiento dental: S/ 350' },
    { category: 'precios', content: 'Extracción simple: desde S/ 80' },
    { category: 'precios', content: 'Curación / empaste: desde S/ 100' },
    { category: 'precios', content: 'Radiografía digital: S/ 40' },
    { category: 'informacion_general', content: 'Somos Dental Smile, clínica odontológica ubicada en Santiago de Surco, Lima.' },
    { category: 'informacion_general', content: 'Todos los procedimientos tienen garantía por escrito.' },
    { category: 'informacion_general', content: 'Aceptamos efectivo, tarjeta y transferencias.' },
    { category: 'informacion_general', content: 'Trabajamos con seguros de salud (consultar cobertura).' },
  ],
}

const SPA: DemoProfile = {
  name: 'Bella Vida Salón & Spa',
  settings: {
    appointmentMode: 'appointments_only',
    slotDurationMinutes: 30,
    minBookingNoticeMinutes: 60,
    services: [
      service('Uñas acrílicas', 90),
      service('Gel semipermanente', 60),
      service('Lifting de pestañas', 60),
      service('Extensiones de pestañas', 120),
      service('Pestañas 1x1 anime', 90),
      service('Planchado de cejas con visajismo', 30),
      service('Limpieza facial', 60),
      service('Dermaplaning', 30),
      service('Pigmentación de cejas con visajismo', 60),
      service('Planchado de cabello', 45),
    ],
    operatingHours: {
      monday:    { open: '09:00', close: '20:00' },
      tuesday:   { open: '09:00', close: '20:00' },
      wednesday: { open: '09:00', close: '20:00' },
      thursday:  { open: '09:00', close: '20:00' },
      friday:    { open: '09:00', close: '20:00' },
      saturday:  { open: '09:00', close: '20:00' },
      sunday:    { open: '09:00', close: '15:00' },
    },
  },
  kbEntries: [
    { category: 'precios', content: 'Uñas acrílicas: S/ 39' },
    { category: 'precios', content: 'Gel semipermanente: S/ 20' },
    { category: 'precios', content: 'Lifting de pestañas: S/ 25' },
    { category: 'precios', content: 'Extensiones de pestañas: S/ 39' },
    { category: 'precios', content: 'Pestañas 1x1 anime: S/ 20' },
    { category: 'precios', content: 'Planchado de cejas con visajismo: S/ 15' },
    { category: 'precios', content: 'Limpieza facial: S/ 35' },
    { category: 'precios', content: 'Dermaplaning: S/ 15' },
    { category: 'precios', content: 'Pigmentación de cejas con visajismo: S/ 20' },
    { category: 'precios', content: 'Planchado de cabello: S/ 20' },
    { category: 'informacion_general', content: 'Bella Vida Salón & Spa — atendemos de lunes a sábado de 9:00 a 20:00 y domingos de 9:00 a 15:00.' },
    { category: 'informacion_general', content: 'Aceptamos efectivo, Yape y Plin.' },
  ],
}

export const DEMO_PROFILES: Record<string, DemoProfile> = {
  barberia: BARBERIA,
  consultorio: CONSULTORIO,
  spa: SPA,
}

export const DEMO_PROFILE_KEYS = Object.keys(DEMO_PROFILES)
