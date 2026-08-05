import type { BusinessSettings } from '@/modules/business/business.settings.js'

export interface DemoKbEntry {
  category: string
  content: string
}

export interface DemoProfile {
  name: string
  settings: BusinessSettings
  kbEntries: DemoKbEntry[]
}

const CLOSED = null

const BARBERIA: DemoProfile = {
  name: 'Imperio Barber Studio',
  settings: {
    slotDurationMinutes: 15,
    services: [
      { name: 'corte clásico', durationMinutes: 45 },
      { name: 'corte degradado', durationMinutes: 60 },
      { name: 'corte con tijera', durationMinutes: 50 },
      { name: 'corte infantil', durationMinutes: 40 },
      { name: 'corte con diseño', durationMinutes: 50 },
      { name: 'mohicano', durationMinutes: 50 },
      { name: 'arreglo de barba', durationMinutes: 30 },
      { name: 'corte y barba', durationMinutes: 55 },
      { name: 'afeitado a navaja', durationMinutes: 30 },
      { name: 'perfilado de cejas', durationMinutes: 10 },
      { name: 'mascarilla facial', durationMinutes: 20 },
      { name: 'ondulación', durationMinutes: 90 },
      { name: 'tinte', durationMinutes: 45 },
      { name: 'tratamiento capilar', durationMinutes: 30 },
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
    { category: 'Precios', content: 'Corte clásico: S/ 25' },
    { category: 'Precios', content: 'Corte degradado: S/ 30' },
    { category: 'Precios', content: 'Corte con tijera: S/ 28' },
    { category: 'Precios', content: 'Corte infantil: S/ 20' },
    { category: 'Precios', content: 'Corte con diseño: S/ 35' },
    { category: 'Precios', content: 'Mohicano: S/ 35' },
    { category: 'Precios', content: 'Arreglo de barba: S/ 15' },
    { category: 'Precios', content: 'Corte y barba: S/ 40' },
    { category: 'Precios', content: 'Afeitado a navaja: S/ 20' },
    { category: 'Precios', content: 'Perfilado de cejas: S/ 10' },
    { category: 'Precios', content: 'Mascarilla facial: S/ 20' },
    { category: 'Precios', content: 'Ondulación: S/ 60' },
    { category: 'Precios', content: 'Tinte: S/ 35–50 (varía según el largo)' },
    { category: 'Precios', content: 'Tratamiento capilar: S/ 25' },
    { category: 'Información general', content: 'Imperio Barber Studio — atendemos de lunes a sábado de 9:30 a 21:30.' },
    { category: 'Información general', content: 'Aceptamos efectivo, Yape y Plin.' },
  ],
}

const CONSULTORIO: DemoProfile = {
  name: 'Dental Smile',
  settings: {
    slotDurationMinutes: 30,
    minBookingNoticeMinutes: 60,
    services: [
      { name: 'Consulta general', durationMinutes: 30 },
      { name: 'Limpieza dental', durationMinutes: 60 },
      { name: 'Blanqueamiento dental', durationMinutes: 90 },
      { name: 'Extracción simple', durationMinutes: 45 },
      { name: 'Curación / empaste', durationMinutes: 60 },
      { name: 'Radiografía digital', durationMinutes: 15 },
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
    { category: 'Precios', content: 'Consulta general: S/ 60' },
    { category: 'Precios', content: 'Limpieza dental: S/ 120' },
    { category: 'Precios', content: 'Blanqueamiento dental: S/ 350' },
    { category: 'Precios', content: 'Extracción simple: desde S/ 80' },
    { category: 'Precios', content: 'Curación / empaste: desde S/ 100' },
    { category: 'Precios', content: 'Radiografía digital: S/ 40' },
    { category: 'Información general', content: 'Somos Dental Smile, clínica odontológica ubicada en Santiago de Surco, Lima.' },
    { category: 'Información general', content: 'Todos los procedimientos tienen garantía por escrito.' },
    { category: 'Información general', content: 'Aceptamos efectivo, tarjeta y transferencias.' },
    { category: 'Información general', content: 'Trabajamos con seguros de salud (consultar cobertura).' },
  ],
}

const SPA: DemoProfile = {
  name: 'Bella Vida Salón & Spa',
  settings: {
    slotDurationMinutes: 30,
    minBookingNoticeMinutes: 60,
    services: [
      { name: 'Uñas acrílicas', durationMinutes: 90 },
      { name: 'Gel semipermanente', durationMinutes: 60 },
      { name: 'Lifting de pestañas', durationMinutes: 60 },
      { name: 'Extensiones de pestañas', durationMinutes: 120 },
      { name: 'Pestañas 1x1 anime', durationMinutes: 90 },
      { name: 'Planchado de cejas con visajismo', durationMinutes: 30 },
      { name: 'Limpieza facial', durationMinutes: 60 },
      { name: 'Dermaplaning', durationMinutes: 30 },
      { name: 'Pigmentación de cejas con visajismo', durationMinutes: 60 },
      { name: 'Planchado de cabello', durationMinutes: 45 },
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
    { category: 'Precios', content: 'Uñas acrílicas: S/ 39' },
    { category: 'Precios', content: 'Gel semipermanente: S/ 20' },
    { category: 'Precios', content: 'Lifting de pestañas: S/ 25' },
    { category: 'Precios', content: 'Extensiones de pestañas: S/ 39' },
    { category: 'Precios', content: 'Pestañas 1x1 anime: S/ 20' },
    { category: 'Precios', content: 'Planchado de cejas con visajismo: S/ 15' },
    { category: 'Precios', content: 'Limpieza facial: S/ 35' },
    { category: 'Precios', content: 'Dermaplaning: S/ 15' },
    { category: 'Precios', content: 'Pigmentación de cejas con visajismo: S/ 20' },
    { category: 'Precios', content: 'Planchado de cabello: S/ 20' },
    { category: 'Información general', content: 'Bella Vida Salón & Spa — atendemos de lunes a sábado de 9:00 a 20:00 y domingos de 9:00 a 15:00.' },
    { category: 'Información general', content: 'Aceptamos efectivo, Yape y Plin.' },
  ],
}

export const DEMO_PROFILES: Record<string, DemoProfile> = {
  barberia: BARBERIA,
  consultorio: CONSULTORIO,
  spa: SPA,
}

export const DEMO_PROFILE_KEYS = Object.keys(DEMO_PROFILES)
