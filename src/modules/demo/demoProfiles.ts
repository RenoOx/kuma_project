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

// Demo profiles carry no real prices by default — the actual rates of these
// businesses live outside the repo. Evaluation-first is the honest mapping:
// with nothing on file, Emma must ask instead of quoting a number it made up.
//
// `price` is opt-in: pass it for services whose demo range is worth showing
// (most of a dental catalogue quotes a range), omit it for anything that
// genuinely depends on a case-by-case look (a complex extraction, a root
// canal) — same behaviour as before this parameter existed.
function service(
  name: string,
  durationMinutes: number,
  price?: { min: number; max: number },
): Service {
  if (price) {
    return {
      name,
      durationMinutes,
      priceMin: price.min,
      priceMax: price.max,
      requiresEvaluation: false,
    }
  }
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
    niche: 'barberia',
    bookingMode: 'direct',
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
    niche: 'dental',
    bookingMode: 'requires_approval',
    appointmentMode: 'appointments_only',
    slotDurationMinutes: 30,
    minBookingNoticeMinutes: 60,
    services: [
      service('Consulta general', 30, { min: 30, max: 50 }),
      service('Limpieza dental (profilaxis)', 45, { min: 80, max: 120 }),
      service('Blanqueamiento dental', 60, { min: 250, max: 400 }),
      service('Curación simple (resina)', 30, { min: 60, max: 100 }),
      service('Curación compuesta', 45, { min: 100, max: 180 }),
      service('Extracción simple', 30, { min: 80, max: 150 }),
      service('Extracción compleja', 60),
      service('Endodoncia (tratamiento de conducto)', 90),
      service('Corona dental', 60),
      service('Ortodoncia (brackets)', 45),
      service('Radiografía dental', 15, { min: 30, max: 50 }),
      service('Urgencia dental', 30, { min: 50, max: 80 }),
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
    {
      category: 'servicios',
      title: 'Tratamientos disponibles',
      content:
        'Trabajamos preventivos (consulta general, limpieza dental), restaurativos (curaciones, coronas), estéticos (blanqueamiento dental), ortodoncia (brackets) y cirugía menor (extracciones). El doctor evalúa cada caso en consulta y recomienda el tratamiento más adecuado.',
    },
    {
      category: 'precios',
      title: 'Precios y formas de pago',
      content:
        'Los precios varían según el caso y el tratamiento. La consulta general es desde S/ 30. Aceptamos pagos en efectivo, transferencia, Yape y Plin. Para tratamientos largos (ortodoncia, coronas, endodoncia) ofrecemos facilidades de pago — consulta por un presupuesto personalizado.',
    },
    {
      category: 'precios',
      title: 'Presupuesto y evaluación',
      content:
        'Para tratamientos como ortodoncia, endodoncia o coronas el doctor necesita evaluar primero el caso. La consulta de evaluación tiene un costo que se descuenta del tratamiento si decides continuar con nosotros.',
    },
    {
      category: 'politicas',
      title: 'Política de citas',
      content:
        'Las citas se confirman con el consultorio. Pedimos llegar 10 minutos antes de tu hora agendada. Las cancelaciones se aceptan con al menos 24 horas de anticipación. Si avisas a tiempo, la reprogramación no tiene costo.',
    },
    {
      category: 'politicas',
      title: 'Primera visita',
      content:
        'En tu primera cita el doctor hace una evaluación general, que puede incluir una radiografía si es necesario. Trae tu DNI. Si tomas algún medicamento o tienes alguna condición de salud, avísanos antes del tratamiento.',
    },
    {
      category: 'informacion_general',
      title: 'Preguntas frecuentes',
      content:
        '¿Duele la limpieza dental? No, es un procedimiento indoloro. ¿Cada cuánto debo hacerme limpieza? Idealmente cada 6 meses. ¿El blanqueamiento daña los dientes? No, es un procedimiento seguro y supervisado por el doctor. ¿Atienden niños? Sí, desde los 3 años con enfoque pediátrico.',
    },
    {
      category: 'informacion_general',
      title: 'Preparación para tu cita',
      content:
        'Cepíllate los dientes antes de venir. Si tu procedimiento es largo, come algo ligero previamente. Si sientes miedo o ansiedad ante el tratamiento dental, avísanos para que el doctor tome las precauciones necesarias.',
    },
    {
      category: 'informacion_general',
      title: 'Urgencias dentales',
      content:
        'Si tienes dolor severo, un diente roto, un golpe en la boca o sangrado que no para, comunícate con nosotros de inmediato. Atendemos urgencias dentro de nuestro horario de atención.',
    },
    {
      category: 'ubicacion',
      title: 'Ubicación',
      content:
        'Consultorio Dental Smile — Av. Caminos del Inca 1234, Santiago de Surco, Lima (dirección de referencia para esta demo). Frente al parque, con fácil acceso y estacionamiento disponible en la cuadra.',
    },
    {
      category: 'contacto',
      title: 'Contacto y horarios',
      content:
        'Atendemos de lunes a viernes de 8:00 a. m. a 5:00 p. m. (descanso de 1:00 a 2:00 p. m.) y sábados de 8:00 a. m. a 1:00 p. m. Domingos cerrado. También puedes escribirnos por este mismo WhatsApp.',
    },
  ],
}

const SPA: DemoProfile = {
  name: 'Bella Vida Salón & Spa',
  settings: {
    niche: 'estetica',
    bookingMode: 'direct',
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
