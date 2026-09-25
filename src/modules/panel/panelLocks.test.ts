import { describe, expect, it } from 'vitest'
import { isLockedPanelWrite } from './panelLocks.js'

// El dueño edita lo básico; lo que decide cómo habla y vende Emma lo configura
// Vamvu. Estos tests fijan la frontera, así una ruta nueva no la corre sin querer.

const base = '/api/panel/biz_123'

describe('isLockedPanelWrite', () => {
  it.each([
    ['PATCH', '/settings/identity'],
    ['PATCH', '/settings/messages'],
    ['PATCH', '/settings/flow'],
    ['PATCH', '/settings/conversation'],
    ['PATCH', '/settings/booking'],
    ['PATCH', '/settings/payments'],
    ['POST', '/knowledge'],
    ['PATCH', '/knowledge/kb1'],
    ['DELETE', '/knowledge/kb1'],
  ])('locks %s %s', (method, path) => {
    expect(isLockedPanelWrite(method, `${base}${path}`)).toBe(true)
  })

  it.each([
    ['PATCH', '/settings/general'],
    ['PATCH', '/settings/schedule'],
    ['PATCH', '/settings/special-days'],
    ['PATCH', '/settings/services'],
    ['POST', '/settings/services/svc1/media'],
    ['DELETE', '/settings/services/svc1/media/abc'],
    ['PATCH', '/settings/services/svc1/media/order'],
    // El texto de un paso está bloqueado; su material nunca — ninguna foto
    // vive en el repo, todas entran por panel+S3.
    ['POST', '/settings/conversation/nodes/greeting/media'],
    ['DELETE', '/settings/conversation/nodes/greeting/media/abc'],
    ['PATCH', '/settings/conversation/nodes/greeting/media/order'],
    ['POST', '/settings/fixed-messages/ofertaCertificacion/media'],
    ['DELETE', '/settings/fixed-messages/ofertaCertificacion/media/abc'],
    ['PATCH', '/settings/fixed-messages/ofertaCertificacion/media/order'],
    ['PATCH', '/settings/bot'],
    ['POST', '/conversations/c1/reply'],
    ['PATCH', '/conversations/c1/emma'],
    ['POST', '/appointments'],
    ['POST', '/tags'],
    ['POST', '/simulator/messages'],
  ])('leaves %s %s open', (method, path) => {
    expect(isLockedPanelWrite(method, `${base}${path}`)).toBe(false)
  })

  it('never locks a read', () => {
    expect(isLockedPanelWrite('GET', `${base}/settings/conversation/catalog`)).toBe(false)
    expect(isLockedPanelWrite('GET', `${base}/knowledge`)).toBe(false)
    expect(isLockedPanelWrite('get', `${base}/settings/identity`)).toBe(false)
  })

  it('does not mistake a longer section name for a locked one', () => {
    expect(isLockedPanelWrite('PATCH', `${base}/settings/flowchart`)).toBe(false)
  })
})
