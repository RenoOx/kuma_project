import { and, desc, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import {
  type NewPaymentVerification,
  type PaymentVerification,
  type PaymentVerificationStatus,
  paymentVerifications,
} from '@/db/schema/index.js'

export async function insert(
  data: NewPaymentVerification,
  exec: Executor = db,
): Promise<PaymentVerification> {
  const [row] = await exec.insert(paymentVerifications).values(data).returning()
  if (!row) throw new Error('insert payment_verifications returned no row')
  return row
}

export async function findById(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<PaymentVerification | null> {
  const [row] = await exec
    .select()
    .from(paymentVerifications)
    .where(and(eq(paymentVerifications.businessId, businessId), eq(paymentVerifications.id, id)))
    .limit(1)
  return row ?? null
}

// The one still awaiting the owner's call, if any.
export async function findOpenByConversation(
  businessId: string,
  conversationId: string,
  exec: Executor = db,
): Promise<PaymentVerification | null> {
  const [row] = await exec
    .select()
    .from(paymentVerifications)
    .where(
      and(
        eq(paymentVerifications.businessId, businessId),
        eq(paymentVerifications.conversationId, conversationId),
        eq(paymentVerifications.status, 'pending'),
      ),
    )
    .orderBy(desc(paymentVerifications.createdAt))
    .limit(1)
  return row ?? null
}

// The last one of ANY status, which is where a resent capture reads its booking
// intent back from: after a rejection the row is no longer open, but it is
// still the only record of what the customer was trying to book.
export async function findLatestByConversation(
  businessId: string,
  conversationId: string,
  exec: Executor = db,
): Promise<PaymentVerification | null> {
  const [row] = await exec
    .select()
    .from(paymentVerifications)
    .where(
      and(
        eq(paymentVerifications.businessId, businessId),
        eq(paymentVerifications.conversationId, conversationId),
      ),
    )
    .orderBy(desc(paymentVerifications.createdAt))
    .limit(1)
  return row ?? null
}

export async function resolve(
  businessId: string,
  id: string,
  status: PaymentVerificationStatus,
  fields: { appointmentId?: string; rejectionReason?: string } = {},
  exec: Executor = db,
): Promise<PaymentVerification | null> {
  const [row] = await exec
    .update(paymentVerifications)
    .set({
      status,
      resolvedAt: new Date(),
      ...(fields.appointmentId ? { appointmentId: fields.appointmentId } : {}),
      ...(fields.rejectionReason ? { rejectionReason: fields.rejectionReason } : {}),
    })
    .where(and(eq(paymentVerifications.businessId, businessId), eq(paymentVerifications.id, id)))
    .returning()
  return row ?? null
}

// Closes every row still open for this conversation. Called before opening a
// new one: a second capture sent before the owner ruled on the first replaces
// it rather than leaving two rows both claiming to be the open one.
export async function supersedeOpenByConversation(
  businessId: string,
  conversationId: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(paymentVerifications)
    .set({ status: 'superseded', resolvedAt: new Date() })
    .where(
      and(
        eq(paymentVerifications.businessId, businessId),
        eq(paymentVerifications.conversationId, conversationId),
        eq(paymentVerifications.status, 'pending'),
      ),
    )
}
