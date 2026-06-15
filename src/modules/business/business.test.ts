import { db } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import * as businessService from '@/modules/business/business.service.js'
import { ConflictError, NotFoundError } from '@/shared/errors.js'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, resetDb } from '../../../tests/helpers/db.js'

describe('business module', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('register creates a new business', async () => {
    const result = await businessService.register({
      name: 'Barbería La Fina',
      whatsappNumber: '+51900000010',
    })
    assert(result.ok)
    expect(result.data.name).toBe('Barbería La Fina')
    expect(result.data.whatsappNumber).toBe('+51900000010')
    expect(result.data.timezone).toBe('America/Lima')
    expect(result.data.id).toBeTypeOf('string')

    const [row] = await db.select().from(businesses).where(eq(businesses.id, result.data.id))
    expect(row?.name).toBe('Barbería La Fina')
  })

  it('register returns ConflictError when whatsappNumber is already taken', async () => {
    const first = await businessService.register({
      name: 'Barbería Uno',
      whatsappNumber: '+51900000011',
    })
    assert(first.ok)

    const second = await businessService.register({
      name: 'Barbería Dos',
      whatsappNumber: '+51900000011',
    })
    assert(!second.ok)
    expect(second.error).toBeInstanceOf(ConflictError)
    expect(second.error.code).toBe('conflict')

    const rows = await db.select().from(businesses)
    expect(rows).toHaveLength(1)
  })

  it('getById returns NotFoundError when id does not exist', async () => {
    const result = await businessService.getById('nonexistent_id')
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotFoundError)
    expect(result.error.code).toBe('not_found')
  })

  it('getById returns the business when it exists', async () => {
    const created = await businessService.register({
      name: 'Barbería La Buena',
      whatsappNumber: '+51900000012',
    })
    assert(created.ok)

    const found = await businessService.getById(created.data.id)
    assert(found.ok)
    expect(found.data.id).toBe(created.data.id)
    expect(found.data.name).toBe('Barbería La Buena')
  })

  it('getByWhatsappNumber returns the business when it exists', async () => {
    const created = await businessService.register({
      name: 'Barbería Tres',
      whatsappNumber: '+51900000013',
    })
    assert(created.ok)

    const found = await businessService.getByWhatsappNumber('+51900000013')
    assert(found.ok)
    expect(found.data.id).toBe(created.data.id)
  })

  it('getByWhatsappNumber returns NotFoundError when no business uses that number', async () => {
    const result = await businessService.getByWhatsappNumber('+51999999999')
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotFoundError)
  })
})
