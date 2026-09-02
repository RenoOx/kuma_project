import { logger } from '@/config/logger.js'
import type { Appointment, PaymentVerification } from '@/db/schema/index.js'
import * as businessService from '@/modules/business/business.service.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import { AppError } from '@/shared/errors.js'
import { formatPersonName } from '@/shared/name.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as appointmentService from './appointment.service.js'
import * as paymentVerificationRepo from './paymentVerification.repo.js'

// The frozen booking intent, in the shape both the in-memory expectation and
// the persisted row carry. Declared here rather than imported from
// whatsapp/imageExpectation so this module does not depend on the transport.
export interface FrozenBooking {
  service: string
  scheduledAtISO: string
  amount: string | null
  customerName: string
}

/**
 * Opens a verification for a capture that just landed.
 *
 * Any still-open row for this conversation is superseded first: a customer who
 * sends two captures before the owner rules on the first has one request, not
 * two, and the owner must not be able to approve a stale one.
 */
export async function openVerification(params: {
  businessId: string
  conversationId: string
  customerId: string
  booking: FrozenBooking
}): Promise<Result<PaymentVerification>> {
  const scheduledAt = new Date(params.booking.scheduledAtISO)
  if (Number.isNaN(scheduledAt.getTime())) {
    return err(
      new AppError({
        code: 'invalid_datetime',
        message: `cannot parse scheduledAtISO: ${params.booking.scheduledAtISO}`,
        userMessage: 'No entendí la fecha y hora de la cita.',
        logContext: { businessId: params.businessId, conversationId: params.conversationId },
      }),
    )
  }

  try {
    await paymentVerificationRepo.supersedeOpenByConversation(
      params.businessId,
      params.conversationId,
    )
    const row = await paymentVerificationRepo.insert({
      businessId: params.businessId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      service: params.booking.service,
      scheduledAt,
      depositAmount: params.booking.amount,
      customerName: params.booking.customerName,
    })
    logger.info(
      {
        businessId: params.businessId,
        conversationId: params.conversationId,
        verificationId: row.id,
        service: row.service,
        scheduledAt: row.scheduledAt.toISOString(),
      },
      'payment verification opened, booking withheld until the owner rules on it',
    )
    return ok(row)
  } catch (cause) {
    return err(
      new AppError({
        code: 'open_payment_verification_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude registrar tu comprobante en este momento.',
        logContext: { businessId: params.businessId, conversationId: params.conversationId },
        cause,
      }),
    )
  }
}

/**
 * The booking intent to use for a capture that carries none of its own.
 *
 * Reads the newest row of ANY status, not only an open one: after a rejection
 * the row is closed and it is still the only record of what the customer was
 * trying to book. This is also the path a capture takes when the in-memory
 * expectation did not survive a restart.
 */
export async function findLatestBooking(
  businessId: string,
  conversationId: string,
): Promise<FrozenBooking | null> {
  const row = await paymentVerificationRepo.findLatestByConversation(businessId, conversationId)
  if (!row) return null
  return {
    service: row.service,
    scheduledAtISO: row.scheduledAt.toISOString(),
    amount: row.depositAmount,
    customerName: row.customerName,
  }
}

export async function findOpenByConversation(
  businessId: string,
  conversationId: string,
): Promise<PaymentVerification | null> {
  return paymentVerificationRepo.findOpenByConversation(businessId, conversationId)
}

export interface ResolvedPayment {
  verification: PaymentVerification
  /** Set on approval. Null on rejection: no booking was filed. */
  appointment: Appointment | null
  /** False when the decision was recorded but the patient could not be reached. */
  patientNotified: boolean
  patientNotifyError?: string
}

// Loads a verification that is still open. Anything already ruled on is a
// refusal, not a silent no-op: the owner has to hear that their answer landed
// on a request that somebody, or a newer capture, already closed.
async function loadOpen(
  businessId: string,
  verificationId: string,
): Promise<Result<PaymentVerification>> {
  const row = await paymentVerificationRepo.findById(businessId, verificationId)
  if (!row) {
    return err(
      new AppError({
        code: 'verification_not_found',
        message: `payment verification ${verificationId} not found`,
        userMessage: 'No encontré ese comprobante.',
        logContext: { businessId, verificationId },
      }),
    )
  }
  if (row.status !== 'pending') {
    return err(
      new AppError({
        code: 'verification_already_resolved',
        message: `payment verification ${verificationId} is already ${row.status}`,
        userMessage: 'Ese comprobante ya se había resuelto antes.',
        logContext: { businessId, verificationId, status: row.status },
      }),
    )
  }
  return ok(row)
}

// Moves the customer's conversation, through the state machine like every other
// transition. Never fails the caller: the decision is already persisted, and
// losing a bookkeeping write must not turn an approved payment into an error.
async function applyConversationTrigger(
  businessId: string,
  conversationId: string,
  trigger: string,
): Promise<void> {
  const conversation = await conversationRepo.findById(businessId, conversationId)
  if (!conversation) {
    logger.warn({ businessId, conversationId, trigger }, 'conversation gone, trigger not applied')
    return
  }
  const settings = await businessService.getSettings(businessId)
  const applied = await conversationService.applyTrigger({
    businessId,
    conversationId,
    flowType: settings.ok ? settings.data.flowType : 'appointments',
    currentState: conversation.state,
    trigger,
  })
  if (!applied.ok) {
    logger.warn(
      { businessId, conversationId, trigger, code: applied.error.code },
      'could not apply payment verification transition',
    )
  }
}

/**
 * The owner verified the capture: file the booking the deposit gate held back.
 *
 * Goes straight to appointmentService, bypassing that gate, for the same reason
 * the old capture path did: the evidence the gate demands is exactly what was
 * just looked at, except this time a human did the looking.
 *
 * A `requires_approval` business would otherwise land a `pending` row and ask
 * the owner to approve the very same booking a second time, so a pending result
 * is confirmed straight away. Either way the patient hears one confirmation.
 */
export async function approve(params: {
  businessId: string
  verificationId: string
}): Promise<Result<ResolvedPayment>> {
  const loaded = await loadOpen(params.businessId, params.verificationId)
  if (!loaded.ok) return loaded
  const verification = loaded.data

  const booked = await appointmentService.bookAppointment({
    businessId: params.businessId,
    customerId: verification.customerId,
    service: verification.service,
    datetimeISO: verification.scheduledAt.toISOString(),
    customerName: verification.customerName,
  })
  // Left open on purpose: the slot may have been taken while the capture
  // waited, and the owner has to be able to act on this again once that is
  // sorted out.
  if (!booked.ok) return booked

  const action =
    booked.data.status === 'pending'
      ? await appointmentService.confirmAppointment({
          businessId: params.businessId,
          appointmentId: booked.data.id,
        })
      : await appointmentService.notifyPatientOfConfirmedAppointment({
          businessId: params.businessId,
          appointmentId: booked.data.id,
        })

  const resolved = await paymentVerificationRepo.resolve(
    params.businessId,
    verification.id,
    'approved',
    { appointmentId: booked.data.id },
  )
  await applyConversationTrigger(params.businessId, verification.conversationId, 'payment_approved')

  logger.info(
    {
      businessId: params.businessId,
      verificationId: verification.id,
      appointmentId: booked.data.id,
    },
    'owner approved a payment capture, appointment filed',
  )

  // The booking is what matters; a failed notification is reported through
  // patientNotified, never by losing the appointment.
  return ok({
    verification: resolved ?? verification,
    appointment: action.ok ? action.data.appointment : booked.data,
    patientNotified: action.ok ? action.data.patientNotified : false,
    ...(action.ok
      ? action.data.patientNotifyError
        ? { patientNotifyError: action.data.patientNotifyError }
        : {}
      : { patientNotifyError: action.error.userMessage }),
  })
}

/**
 * The owner turned the capture down: no booking, and the customer is asked for
 * a new one.
 *
 * The row keeps the frozen booking, so the capture they send next reopens the
 * verification on the same service and slot instead of starting from nothing.
 */
export async function reject(params: {
  businessId: string
  verificationId: string
  reason?: string
}): Promise<Result<ResolvedPayment>> {
  const loaded = await loadOpen(params.businessId, params.verificationId)
  if (!loaded.ok) return loaded
  const verification = loaded.data

  const resolved = await paymentVerificationRepo.resolve(
    params.businessId,
    verification.id,
    'rejected',
    params.reason ? { rejectionReason: params.reason } : {},
  )
  await applyConversationTrigger(params.businessId, verification.conversationId, 'payment_rejected')

  const customer = await customerRepo.findById(params.businessId, verification.customerId)
  if (!customer) {
    return err(
      new AppError({
        code: 'customer_not_found',
        message: `customer ${verification.customerId} not found`,
        userMessage: 'No encontré al paciente de ese comprobante.',
        logContext: { businessId: params.businessId, verificationId: verification.id },
      }),
    )
  }

  const notified = await appointmentService.messagePatient({
    businessId: params.businessId,
    customerId: customer.id,
    phone: customer.phone,
    text: buildResendRequestText(verification.customerName, params.reason),
  })

  logger.info(
    { businessId: params.businessId, verificationId: verification.id },
    'owner rejected a payment capture, no appointment filed',
  )

  return ok({
    verification: resolved ?? verification,
    appointment: null,
    patientNotified: notified.ok,
    ...(notified.ok ? {} : { patientNotifyError: notified.error.userMessage }),
  })
}

// Emma's voice, not the owner's: for the patient this is still one continuous
// conversation with her, so the reason is relayed as her own reading of the
// capture and the owner is never mentioned. Same rule reply_to_customer states.
function buildResendRequestText(customerName: string, reason?: string): string {
  const name = formatPersonName(customerName)
  const greeting = name ? `¡Hola ${name}!` : '¡Hola!'
  const why = reason?.trim()
  return [
    `${greeting} No pude leer bien tu comprobante 😅`,
    why ? `${why}.` : null,
    '¿Me lo reenvías? Con una foto donde se vea el monto y la fecha me alcanza.',
  ]
    .filter((line): line is string => line !== null)
    .join(' ')
}
