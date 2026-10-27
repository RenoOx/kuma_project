import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runSimulation } from '@/modules/simulator/simulationScope.js'

// Una prueba del panel no le escribe a nadie por WhatsApp (2026-10-26). En prod
// el dueño tiene número real y el socket está conectado: sin el corte, "quiero
// un asesor" en la pestaña "Pruebas" le llegaba de verdad. Se reemplazan el
// negocio, el socket y la cola para poder ver si un envío llegó a encolarse.

const enqueueSend = vi.fn(async (_businessId: string, _priority: string, task: () => unknown) =>
  task(),
)
const sendMessage = vi.fn(async () => undefined)
const getById = vi.fn(async (id: string) => ({
  ok: true as const,
  data: { id, ownerWhatsappNumber: '+51999888777' },
}))
const findByPhone = vi.fn(async () => ({
  id: 'c1',
  phone: '+51911222333',
  waJid: '51911222333@s.whatsapp.net',
  whatsappUnreachableAt: null,
}))

vi.mock('./sendQueue.js', () => ({ enqueueSend }))
vi.mock('./clientRegistry.js', () => ({ getClient: () => ({ sendMessage }) }))
vi.mock('./ownerThreadLog.js', () => ({ recordOwnerNotification: async () => undefined }))
vi.mock('./customerJid.js', () => ({ customerJid: (c: { waJid: string }) => c.waJid }))
vi.mock('@/modules/business/business.service.js', () => ({ getById }))
vi.mock('@/modules/customer/customer.repo.js', () => ({ findByPhone }))

const { notifyOwner } = await import('./ownerNotifier.js')
const { notifyCustomer } = await import('./customerNotifier.js')

beforeEach(() => {
  enqueueSend.mockClear()
  sendMessage.mockClear()
  getById.mockClear()
  findByPhone.mockClear()
})

describe('notifiers inside a simulator turn', () => {
  it('send for real outside a test turn (so the cut below is what stops them)', async () => {
    expect((await notifyOwner('biz-a', 'aviso')).ok).toBe(true)
    expect((await notifyCustomer('biz-a', '+51911222333', 'hola')).ok).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('send nothing to the owner or a customer during a test turn of that business', async () => {
    await runSimulation({ businessId: 'biz-a', versionId: '3-opciones' }, async () => {
      expect((await notifyOwner('biz-a', 'aviso')).ok).toBe(true)
      expect((await notifyCustomer('biz-a', '+51911222333', 'hola')).ok).toBe(true)
    })
    // Ni siquiera la versión de siempre probada desde el panel.
    await runSimulation({ businessId: 'biz-a', versionId: null }, async () => {
      expect((await notifyOwner('biz-a', 'aviso')).ok).toBe(true)
    })
    expect(enqueueSend).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(getById).not.toHaveBeenCalled()
  })

  it('still sends for another business while a test turn runs', async () => {
    await runSimulation({ businessId: 'biz-a', versionId: '3-opciones' }, async () => {
      await notifyOwner('biz-b', 'aviso de otro negocio')
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
