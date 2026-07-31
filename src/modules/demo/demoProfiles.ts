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
  name: 'Barbería El Maestro',
  settings: {
    slotDurationMinutes: 30,
    services: [
      { name: 'Corte caballero', durationMinutes: 30 },
      { name: 'Barba', durationMinutes: 20 },
      { name: 'Combo corte y barba', durationMinutes: 45 },
      { name: 'Afeitado clásico', durationMinutes: 30 },
      { name: 'Corte niño', durationMinutes: 25 },
    ],
    operatingHours: {
      monday:    { open: '09:00', close: '20:00', break: { start: '13:00', end: '14:00' } },
      tuesday:   { open: '09:00', close: '20:00', break: { start: '13:00', end: '14:00' } },
      wednesday: { open: '09:00', close: '20:00', break: { start: '13:00', end: '14:00' } },
      thursday:  { open: '09:00', close: '20:00', break: { start: '13:00', end: '14:00' } },
      friday:    { open: '09:00', close: '20:00', break: { start: '13:00', end: '14:00' } },
      saturday:  { open: '09:00', close: '20:00', break: { start: '13:00', end: '14:00' } },
      sunday:    { open: '10:00', close: '15:00' },
    },
  },
  kbEntries: [
    { category: 'Precios', content: 'Corte caballero: S/ 30' },
    { category: 'Precios', content: 'Barba: S/ 20' },
    { category: 'Precios', content: 'Combo corte y barba: S/ 45' },
    { category: 'Precios', content: 'Afeitado clásico: S/ 25' },
    { category: 'Precios', content: 'Corte niño (hasta 12 años): S/ 25' },
    { category: 'Información general', content: 'Somos Barbería El Maestro, especialistas en corte masculino. Estamos en San Isidro, Lima.' },
    { category: 'Información general', content: 'Aceptamos efectivo, Yape y Plin.' },
    { category: 'Información general', content: 'Atendemos de lunes a domingo.' },
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
      // Cabello
      { name: 'Corte cabello corto', durationMinutes: 30 },
      { name: 'Corte cabello largo', durationMinutes: 40 },
      { name: 'Tinte raíz cabello corto', durationMinutes: 90 },
      { name: 'Tinte raíz cabello largo', durationMinutes: 120 },
      { name: 'Mechas y balayage', durationMinutes: 150 },
      { name: 'Keratina cabello corto', durationMinutes: 150 },
      { name: 'Keratina cabello largo', durationMinutes: 180 },
      { name: 'Alisado japonés', durationMinutes: 240 },
      // Uñas
      { name: 'Manicure clásico', durationMinutes: 40 },
      { name: 'Manicure gel', durationMinutes: 60 },
      { name: 'Manicure acrílico', durationMinutes: 90 },
      { name: 'Pedicure clásico', durationMinutes: 50 },
      // Maquillaje
      { name: 'Maquillaje social', durationMinutes: 60 },
      { name: 'Maquillaje novia', durationMinutes: 90 },
      // Depilación y tratamientos
      { name: 'Depilación facial', durationMinutes: 20 },
      { name: 'Depilación piernas completas', durationMinutes: 60 },
      { name: 'Tratamiento facial básico', durationMinutes: 60 },
      // Combos
      { name: 'Combo Belleza Total', durationMinutes: 150 },
      { name: 'Pack Novia', durationMinutes: 180 },
      { name: 'Pack Quinceañera', durationMinutes: 150 },
      { name: 'Combo Relajación', durationMinutes: 180 },
      { name: 'Combo Fecha Especial', durationMinutes: 120 },
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
    // Precios - Cabello
    { category: 'Precios - Cabello', content: 'Corte cabello corto: S/ 20–25 (incluye lavado)' },
    { category: 'Precios - Cabello', content: 'Corte cabello largo: S/ 25–35 (incluye lavado)' },
    { category: 'Precios - Cabello', content: 'Tinte raíz cabello corto: S/ 45–60' },
    { category: 'Precios - Cabello', content: 'Tinte raíz cabello largo: S/ 65–90 (varía según marca)' },
    { category: 'Precios - Cabello', content: 'Mechas y balayage: S/ 80–150 (requiere evaluación previa gratuita)' },
    { category: 'Precios - Cabello', content: 'Keratina cabello corto: S/ 120–160 (requiere depósito del 30% al agendar)' },
    { category: 'Precios - Cabello', content: 'Keratina cabello largo: S/ 160–220 (requiere depósito del 30% al agendar)' },
    { category: 'Precios - Cabello', content: 'Alisado japonés: S/ 200–300 (requiere evaluación previa + depósito del 30%)' },
    // Precios - Uñas
    { category: 'Precios - Uñas', content: 'Manicure clásico: S/ 18–22 (walk-in aceptado)' },
    { category: 'Precios - Uñas', content: 'Manicure gel: S/ 30–40 (se recomienda cita)' },
    { category: 'Precios - Uñas', content: 'Manicure acrílico: S/ 50–70 (cita previa obligatoria)' },
    { category: 'Precios - Uñas', content: 'Pedicure clásico: S/ 22–28 (walk-in aceptado)' },
    // Precios - Maquillaje y Depilación
    { category: 'Precios - Maquillaje y Depilación', content: 'Maquillaje social: S/ 60–80' },
    { category: 'Precios - Maquillaje y Depilación', content: 'Maquillaje novia: S/ 150–220 (incluye prueba sin costo)' },
    { category: 'Precios - Maquillaje y Depilación', content: 'Depilación facial (hilo o cera): S/ 15–25' },
    { category: 'Precios - Maquillaje y Depilación', content: 'Depilación piernas completas: S/ 45–65' },
    { category: 'Precios - Maquillaje y Depilación', content: 'Tratamiento facial básico (limpieza + hidratación): S/ 60–90' },
    // Combos
    { category: 'Combos y Paquetes', content: 'Combo Belleza Total: S/ 80 — Corte + tinte raíz + manicure clásico' },
    { category: 'Combos y Paquetes', content: 'Pack Novia: S/ 350–500 — Maquillaje + peinado + manicure gel + pedicure (requiere depósito 30%)' },
    { category: 'Combos y Paquetes', content: 'Pack Quinceañera: S/ 280–400 — Maquillaje + peinado + uñas + depilación facial (requiere depósito 30%)' },
    { category: 'Combos y Paquetes', content: 'Combo Relajación: S/ 120 — Manicure gel + pedicure + tratamiento facial básico' },
    { category: 'Combos y Paquetes', content: 'Combo Fecha Especial: S/ 100 — Corte + maquillaje social + manicure clásico' },
    // Políticas
    { category: 'Políticas', content: 'Evaluación previa gratuita obligatoria para mechas, balayage y alisado japonés antes de cotizar precio final.' },
    { category: 'Políticas', content: 'Depósito del 30% requerido al agendar: keratinas, alisado japonés, Pack Novia y Pack Quinceañera.' },
    { category: 'Políticas', content: 'Cancelación: avisar con mínimo 24 horas para servicios de más de 2 horas. El depósito no se devuelve con menos de 12 horas de aviso.' },
    { category: 'Políticas', content: 'Walk-in aceptado solo para manicure clásico y pedicure clásico. El resto requiere cita previa.' },
    { category: 'Políticas', content: 'Los precios de tintes y mechas varían según el largo del cabello (corto / medio / largo / extra largo) y la marca del producto.' },
    // Info general
    { category: 'Información general', content: 'Bella Vida Salón & Spa — Av. Ejército 820, zona residencial (Arequipa / Trujillo).' },
    { category: 'Información general', content: 'Propietaria: Milagros Condori, 12 años de experiencia. Equipo de 2 técnicas especialistas.' },
    { category: 'Información general', content: 'Capacidad para hasta 15 atenciones por día.' },
  ],
}

export const DEMO_PROFILES: Record<string, DemoProfile> = {
  barberia: BARBERIA,
  consultorio: CONSULTORIO,
  spa: SPA,
}

export const DEMO_PROFILE_KEYS = Object.keys(DEMO_PROFILES)
