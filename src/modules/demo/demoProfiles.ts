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

// `price` is opt-in: pass it for services with a rate worth quoting, omit it for
// anything that genuinely depends on a case-by-case look (a complex extraction,
// a root canal). Omitting it maps to evaluation-first, which is the honest
// default: with nothing on file, Emma must ask instead of quoting a number it
// made up.
//
// Prices live here and nowhere else. The barbershop and spa rates used to be
// duplicated as `precios` knowledge base entries, so Emma could read two
// different answers to "¿cuánto cuesta?". That category is retired and its
// numbers were folded in here — see KB_CATEGORIES in knowledgeBase.types.ts.
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
    forwardImages: false,
    appointmentMode: 'appointments_only',
    slotDurationMinutes: 15,
    services: [
      service('corte clásico', 45, { min: 25, max: 25 }),
      service('corte degradado', 60, { min: 30, max: 30 }),
      service('corte con tijera', 50, { min: 28, max: 28 }),
      service('corte infantil', 40, { min: 20, max: 20 }),
      service('corte con diseño', 50, { min: 35, max: 35 }),
      service('mohicano', 50, { min: 35, max: 35 }),
      service('arreglo de barba', 30, { min: 15, max: 15 }),
      service('corte y barba', 55, { min: 40, max: 40 }),
      service('afeitado a navaja', 30, { min: 20, max: 20 }),
      service('perfilado de cejas', 10, { min: 10, max: 10 }),
      service('mascarilla facial', 20, { min: 20, max: 20 }),
      service('ondulación', 90, { min: 60, max: 60 }),
      service('tinte', 45, { min: 35, max: 50 }),
      service('tratamiento capilar', 30, { min: 25, max: 25 }),
    ],
    operatingHours: {
      monday: { open: '09:30', close: '21:30' },
      tuesday: { open: '09:30', close: '21:30' },
      wednesday: { open: '09:30', close: '21:30' },
      thursday: { open: '09:30', close: '21:30' },
      friday: { open: '09:30', close: '21:30' },
      saturday: { open: '09:30', close: '21:30' },
      sunday: CLOSED,
    },
  },
  kbEntries: [
    {
      category: 'politicas',
      title: 'Formas de pago',
      content: 'Aceptamos efectivo, Yape y Plin. No cobramos adelanto para reservar.',
    },
    {
      category: 'politicas',
      title: 'Puntualidad y cancelaciones',
      content:
        'Te esperamos hasta 10 minutos pasada tu hora; después de eso el turno puede pasar al siguiente cliente. Si no vas a poder venir, avísanos con un par de horas de anticipación y reprogramamos sin problema.',
    },
    {
      category: 'informacion_general',
      title: 'Preguntas frecuentes',
      content:
        '¿Atienden sin cita? Sí, pero con cita no esperas. ¿Cortan a niños? Sí, desde los 4 años. ¿Cada cuánto conviene cortarse? Cada 3 o 4 semanas para mantener la forma. ¿El tinte incluye el corte? No, son servicios aparte.',
    },
    {
      category: 'promociones',
      title: 'Promo del mes',
      content:
        'Si vienen dos juntos, el segundo corte tiene descuento. Preguntá por la promo vigente al reservar.',
    },
  ],
}

const CONSULTORIO: DemoProfile = {
  name: 'Dental Smile',
  settings: {
    niche: 'dental',
    bookingMode: 'requires_approval',
    forwardImages: true,
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
      monday: { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      tuesday: { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      wednesday: { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      thursday: { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      friday: { open: '08:00', close: '17:00', break: { start: '13:00', end: '14:00' } },
      saturday: { open: '08:00', close: '13:00' },
      sunday: CLOSED,
    },
  },
  kbEntries: [
    {
      category: 'politicas',
      title: 'Facilidades de pago',
      content:
        'Para tratamientos largos (ortodoncia, coronas, endodoncia) ofrecemos facilidades de pago — consulta por un presupuesto personalizado.',
    },
    {
      category: 'politicas',
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
      title: 'Formas de pago',
      content:
        'Aceptamos pagos en efectivo, Yape y Plin. Para tratamientos que requieren adelanto, te indicaremos el monto y a dónde transferir. Mándanos la captura del pago para confirmar tu cita.',
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
      category: 'promociones',
      title: 'Campaña de limpieza dental',
      content:
        'Este mes la limpieza dental (profilaxis) incluye una evaluación general sin costo adicional. Válido solo con cita previa y hasta fin de mes.',
    },
  ],
}

const SPA: DemoProfile = {
  name: 'Bella Vida Salón & Spa',
  settings: {
    niche: 'estetica',
    bookingMode: 'direct',
    forwardImages: false,
    appointmentMode: 'appointments_only',
    slotDurationMinutes: 30,
    minBookingNoticeMinutes: 60,
    services: [
      service('Uñas acrílicas', 90, { min: 39, max: 39 }),
      service('Gel semipermanente', 60, { min: 20, max: 20 }),
      service('Lifting de pestañas', 60, { min: 25, max: 25 }),
      service('Extensiones de pestañas', 120, { min: 39, max: 39 }),
      service('Pestañas 1x1 anime', 90, { min: 20, max: 20 }),
      service('Planchado de cejas con visajismo', 30, { min: 15, max: 15 }),
      service('Limpieza facial', 60, { min: 35, max: 35 }),
      service('Dermaplaning', 30, { min: 15, max: 15 }),
      service('Pigmentación de cejas con visajismo', 60, { min: 20, max: 20 }),
      service('Planchado de cabello', 45, { min: 20, max: 20 }),
    ],
    operatingHours: {
      monday: { open: '09:00', close: '20:00' },
      tuesday: { open: '09:00', close: '20:00' },
      wednesday: { open: '09:00', close: '20:00' },
      thursday: { open: '09:00', close: '20:00' },
      friday: { open: '09:00', close: '20:00' },
      saturday: { open: '09:00', close: '20:00' },
      sunday: { open: '09:00', close: '15:00' },
    },
  },
  kbEntries: [
    {
      category: 'politicas',
      title: 'Formas de pago',
      content: 'Aceptamos efectivo, Yape y Plin. No cobramos adelanto para reservar.',
    },
    {
      category: 'politicas',
      title: 'Cancelaciones y puntualidad',
      content:
        'Si no vas a poder venir, avísanos con al menos 2 horas de anticipación y reprogramamos sin costo. Llegar más de 15 minutos tarde puede acortar tu servicio para no atrasar a la siguiente clienta.',
    },
    {
      category: 'informacion_general',
      title: 'Preguntas frecuentes',
      content:
        '¿Cuánto duran las uñas acrílicas? Entre 3 y 4 semanas, según el crecimiento. ¿El lifting de pestañas daña la pestaña natural? No, es un tratamiento seguro. ¿Puedo venir con las uñas de otro salón? Sí, cobramos el retiro aparte. ¿Atienden menores? Sí, acompañadas de un adulto.',
    },
    {
      category: 'promociones',
      title: 'Combo del mes',
      content:
        'Este mes: manos y pies en gel semipermanente juntos con precio de combo. Consultá por disponibilidad al reservar.',
    },
  ],
}

export const DEMO_PROFILES: Record<string, DemoProfile> = {
  barberia: BARBERIA,
  consultorio: CONSULTORIO,
  spa: SPA,
}

export const DEMO_PROFILE_KEYS = Object.keys(DEMO_PROFILES)
