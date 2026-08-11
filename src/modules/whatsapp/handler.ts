import { env } from "@/config/env.js";
import { logger } from "@/config/logger.js";
import * as businessService from "@/modules/business/business.service.js";
import * as conversationService from "@/modules/conversation/conversation.service.js";
import * as customerService from "@/modules/customer/customer.service.js";
import * as demoService from "@/modules/demo/demo.service.js";
import * as eventsRepo from "@/modules/events/events.repo.js";
import * as llmService from "@/modules/llm/llm.service.js";
import * as messageService from "@/modules/message/message.service.js";
import * as ownerAssistantService from "@/modules/ownerAssistant/ownerAssistant.service.js";
import * as ownerNotifier from "@/modules/whatsapp/ownerNotifier.js";
import {
  classifyIncoming,
  describeFormat,
  replyForFormat,
  type UnsupportedFormat,
} from "@/modules/whatsapp/messageKind.js";
import type { WAMessage } from "@whiskeysockets/baileys";

const LLM_FALLBACK_REPLY =
  "Mmm, algo no salió bien de mi lado. Intenta de nuevo en un momento, ¿va?";

const PAUSED_REPLY =
  "En este momento no podemos atenderte automáticamente. Un asesor te contactará pronto.";

const OWNER_FALLBACK_REPLY = "Algo se rompió de mi lado, prueba de nuevo.";

const ESCALATED_REPLY = "Ya avisé al encargado, te escribirá en breve 😊";

export type SendFn = (jid: string, text: string) => Promise<void>

// Structural subset of the Pino logger, so helpers accept a child logger
// without fighting Pino's generics over custom-level type parameters.
type HandlerLogger = Pick<typeof logger, 'info' | 'warn' | 'error'>

// Converts any stray Markdown that GPT produces into WhatsApp-native formatting.
// Acts as a hard backstop so the prompt rules never reach the customer as
// literal asterisks or hyphens even if the model ignores the formatting section.
function sanitizeForWhatsApp(text: string): string {
  return text
    // **bold** → *bold*  (double asterisk Markdown → single asterisk WA bold)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    // ## Heading → Heading  (strip Markdown headings)
    .replace(/^#{1,6}\s+/gm, '')
    // "- item" at line start → "· item"
    .replace(/^- /gm, '· ')
}

// Serialises message processing per (businessId, sender-phone) so that two
// rapid messages from the same number never run their LLM calls concurrently,
// which would interleave messages in the conversation history.
const senderLocks = new Map<string, Promise<void>>();

function withSenderLock(key: string, work: () => Promise<void>): Promise<void> {
  const prev = senderLocks.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  senderLocks.set(key, next);
  void next.finally(() => {
    if (senderLocks.get(key) === next) senderLocks.delete(key);
  });
  return next;
}

// Sending the "text only" notice once per media is helpful; sending it after
// each of five voice notes is noise, and repeated identical outbound messages
// are exactly the pattern WhatsApp flags. In-memory on purpose: unlike the
// anti-ban guard, a reset after a deploy costs one extra polite message.
const UNSUPPORTED_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const unsupportedNoticeSentAt = new Map<string, number>();

function shouldSendUnsupportedNotice(conversationId: string): boolean {
  const last = unsupportedNoticeSentAt.get(conversationId);
  const now = Date.now();
  if (last !== undefined && now - last < UNSUPPORTED_NOTICE_COOLDOWN_MS) return false;
  unsupportedNoticeSentAt.set(conversationId, now);
  return true;
}

// Once a conversation is escalated a human owes it an answer, so the bot goes
// quiet instead of talking over them. The customer still gets one "someone is
// coming" line per hour — silence after every message would read as a hang.
// In-memory like the notice cooldown above: a deploy costs one extra polite
// message, which is cheaper than a table.
const ESCALATED_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;
const escalatedNoticeSentAt = new Map<string, number>();

function shouldSendEscalatedNotice(conversationId: string): boolean {
  const last = escalatedNoticeSentAt.get(conversationId);
  const now = Date.now();
  if (last !== undefined && now - last < ESCALATED_NOTICE_COOLDOWN_MS) return false;
  escalatedNoticeSentAt.set(conversationId, now);
  return true;
}

// Recorded for every unreadable message, including while the bot is paused, so
// the frequency of these is measurable regardless of whether we replied.
async function recordUnsupportedEvent(
  businessId: string,
  conversationId: string,
  format: UnsupportedFormat,
  phone: string,
  log: HandlerLogger,
): Promise<void> {
  try {
    await eventsRepo.create({
      businessId,
      conversationId,
      type: "unsupported_media",
      payload: { format, phone },
    });
  } catch (err) {
    log.error({ err, format }, "failed to record unsupported_media event");
  }
}

// Acknowledges an unreadable message — the "text only" notice for most
// formats, a photo-specific line for images — subject to the cooldown.
async function respondUnsupportedFormat(params: {
  businessId: string;
  conversationId: string;
  format: UnsupportedFormat;
  jid: string;
  send: SendFn;
  log: HandlerLogger;
}): Promise<void> {
  const { businessId, conversationId, format, jid, send, log } = params;

  if (!shouldSendUnsupportedNotice(conversationId)) {
    log.info({ conversationId, format }, "unsupported format within cooldown; event only");
    return;
  }

  const reply = replyForFormat(format);
  const persisted = await messageService.append({
    businessId,
    conversationId,
    role: "assistant",
    content: reply,
  });
  if (!persisted.ok) {
    log.error({ code: persisted.error.code }, "append unsupported-format reply failed");
  }

  try {
    await send(jid, reply);
    log.info({ conversationId, format }, "unsupported format notice sent");
  } catch (err) {
    log.error({ err, jid, format }, "failed to send unsupported format notice");
  }
}

// Returns the peer's E.164 phone (with leading '+') from a Baileys JID or null
// for unsupported shapes. Handles classic '@s.whatsapp.net' JIDs and, since
// the LID migration, '@lid' JIDs where the real phone can live in any of:
// senderPn (older Baileys), remoteJidAlt (newer), or participant (fallback).
function jidToPhone(jid: string | undefined): string | null {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  const left = jid.slice(0, jid.indexOf("@"));
  if (!/^\d+$/.test(left)) return null;
  return `+${left}`;
}

function extractPhone(msg: WAMessage): string | null {
  const jid = msg.key.remoteJid;
  if (!jid) return null;

  const direct = jidToPhone(jid);
  if (direct) return direct;

  if (jid.endsWith("@lid")) {
    const key = msg.key as {
      senderPn?: string;
      remoteJidAlt?: string;
      participant?: string;
    };
    // Prefer a real phone if any related field exposes one.
    const real =
      jidToPhone(key.senderPn) ??
      jidToPhone(key.remoteJidAlt) ??
      jidToPhone(key.participant);
    if (real) return real;

    // LID-only fallback: post-LID-migration, WA hides the real phone and only
    // exposes a stable LID (e.g. "153497903333610@lid"). We treat the digits
    // as a synthetic phone so downstream code (customer keying, DB uniqueness)
    // keeps working. It's not a real E.164 number, but it IS a stable per-user
    // identifier — same contact = same LID across all future messages.
    const left = jid.slice(0, jid.indexOf("@"));
    if (/^\d+$/.test(left)) return `+${left}`;
  }

  return null;
}

// What processMessage was handed: either readable text, or a format we can
// only acknowledge. Both still create the customer/conversation records.
type Payload =
  | { kind: "text"; text: string }
  | { kind: "unsupported"; format: UnsupportedFormat };

async function processMessage(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
  jid: string,
  phone: string,
  payload: Payload,
): Promise<void> {
  const log = logger.child({ component: "whatsapp.handler", businessId });

  // History placeholder for unreadable messages: without it the transcript
  // shows an assistant turn with nothing before it, which reads as a non
  // sequitur to the LLM on the next turn.
  const text =
    payload.kind === "text"
      ? payload.text
      : `[El cliente envió ${describeFormat(payload.format)} que no puedo procesar]`;

  // Load business once to figure out who is talking to us (owner or customer)
  // and to feed downstream services without re-fetching.
  const businessResult = await businessService.getById(businessId);
  if (!businessResult.ok) {
    log.error(
      { code: businessResult.error.code },
      "business not found for incoming message",
    );
    return;
  }
  const business = businessResult.data;

  // DEMO COMMAND — #demo <profile> from the verified admin phone switches the
  // business profile instantly. Checked before owner/customer routing so it
  // works regardless of whether the admin is also the business owner.
  if (env.DEMO_ADMIN_PHONE && phone === env.DEMO_ADMIN_PHONE) {
    const trimmed = text.trim()
    const demoMatch = /^#demo\s+(\w+)$/i.exec(trimmed)
    if (demoMatch) {
      const keyword = demoMatch[1]!.toLowerCase()
      const result = await demoService.applyDemoProfile(businessId, keyword)
      let reply: string
      if (result.ok) {
        reply = `✅ Demo activado: *${result.data}*\nServicios, horarios y precios del perfil "${keyword}" ya están activos. El próximo mensaje al bot usará este perfil.`
      } else {
        reply = result.error.userMessage
      }
      log.info({ keyword, ok: result.ok }, "demo command processed")
      try { await send(jid, reply) } catch {}
      return
    }
  }

  // OWNER FLOW — bypass customer lookup, talk to the personal assistant.
  if (business.ownerWhatsappNumber && business.ownerWhatsappNumber === phone) {
    const ownerThread =
      await conversationService.findOrCreateOwnerThread(businessId);
    if (!ownerThread.ok) {
      log.error(
        { code: ownerThread.error.code },
        "findOrCreateOwnerThread failed",
      );
      return;
    }

    if (payload.kind === "unsupported") {
      await recordUnsupportedEvent(businessId, ownerThread.data.id, payload.format, phone, log);
      const persisted = await messageService.append({
        businessId,
        conversationId: ownerThread.data.id,
        role: "user",
        content: text,
      });
      if (!persisted.ok) {
        log.error({ code: persisted.error.code }, "append owner unsupported placeholder failed");
      }
      await respondUnsupportedFormat({
        businessId,
        conversationId: ownerThread.data.id,
        format: payload.format,
        jid,
        send,
        log,
      });
      return;
    }

    const result = await ownerAssistantService.handle(
      businessId,
      ownerThread.data.id,
      text,
    );
    let replyText: string;
    if (result.ok) {
      replyText = sanitizeForWhatsApp(result.data.content);
      log.info(
        {
          conversationId: ownerThread.data.id,
          tokensInput: result.data.tokensInput,
          tokensOutput: result.data.tokensOutput,
          toolsExecuted: result.data.toolsExecuted,
          maxIterationsHit: result.data.maxIterationsHit,
        },
        "owner reply generated",
      );
    } else {
      replyText = OWNER_FALLBACK_REPLY;
      log.error(
        { code: result.error.code, context: result.error.logContext },
        "owner assistant failed, using fallback",
      );
      // The owner service persists its own assistant turn on success; on
      // failure it doesn't, so we persist the fallback so the rolling memory
      // stays consistent.
      const fallbackPersist = await messageService.append({
        businessId,
        conversationId: ownerThread.data.id,
        role: "assistant",
        content: replyText,
      });
      if (!fallbackPersist.ok) {
        log.error(
          { code: fallbackPersist.error.code },
          "append owner fallback message failed",
        );
      }
    }

    try {
      await send(jid, replyText);
    } catch (err) {
      log.error({ err, jid }, "failed to send owner reply over whatsapp");
    }
    return;
  }

  // CUSTOMER FLOW — the historical path.
  const customerResult = await customerService.getOrCreate(
    businessId,
    phone,
    raw.pushName ?? undefined,
  );
  if (!customerResult.ok) {
    log.error(
      { err: customerResult.error.logContext, code: customerResult.error.code },
      "getOrCreate customer failed",
    );
    try { await send(jid, LLM_FALLBACK_REPLY) } catch {}
    return;
  }
  const customer = customerResult.data;

  const conversationResult = await conversationService.getOrCreateOpen(
    businessId,
    customer.id,
  );
  if (!conversationResult.ok) {
    log.error(
      {
        err: conversationResult.error.logContext,
        code: conversationResult.error.code,
      },
      "getOrCreateOpen conversation failed",
    );
    try { await send(jid, LLM_FALLBACK_REPLY) } catch {}
    return;
  }
  const conversation = conversationResult.data;

  const userMsgResult = await messageService.append({
    businessId,
    conversationId: conversation.id,
    role: "user",
    content: text,
  });
  if (!userMsgResult.ok) {
    log.error(
      { err: userMsgResult.error.logContext, code: userMsgResult.error.code },
      "append user message failed",
    );
    try { await send(jid, LLM_FALLBACK_REPLY) } catch {}
    return;
  }

  // Recorded before the paused check so the metric counts every occurrence,
  // not only the ones that got a reply.
  if (payload.kind === "unsupported") {
    await recordUnsupportedEvent(businessId, conversation.id, payload.format, phone, log);
  }

  // BOT PAUSED — keep the customer record + the message, but skip LLM and
  // escalate so a human notices.
  const paused = await businessService.isBotPaused(businessId);
  if (paused) {
    const cannedPersist = await messageService.append({
      businessId,
      conversationId: conversation.id,
      role: "assistant",
      content: PAUSED_REPLY,
    });
    if (!cannedPersist.ok) {
      log.error(
        { code: cannedPersist.error.code },
        "append paused canned reply failed",
      );
    }

    const escalateResult = await conversationService.escalate(
      businessId,
      conversation.id,
    );
    if (!escalateResult.ok) {
      log.error(
        { code: escalateResult.error.code },
        "escalating paused conversation failed",
      );
    }

    try {
      await eventsRepo.create({
        businessId,
        conversationId: conversation.id,
        type: "paused_blocked_message",
        payload: { phone, text_preview: text.slice(0, 50) },
      });
    } catch (err) {
      log.error({ err }, "failed to record paused_blocked_message event");
    }

    log.warn(
      { conversationId: conversation.id, phone },
      "bot is paused; customer message escalated, canned reply sent",
    );

    // Fire-and-forget owner notification so the dueño knows someone wrote
    // during the pause window. Failures are warn-logged inside notifyOwner.
    const who = customer.name?.trim() || "";
    const phoneWho = phone;
    const pausedText = [
      "⏸️ *Mensaje durante pausa*",
      `Cliente ${who} - (${phoneWho}) escribió mientras el bot está pausado.`,
      "Conversación marcada como escalada.",
    ].join("\n");
    ownerNotifier.notifyOwner(businessId, pausedText).catch((err) => {
      log.warn({ err }, "notifyOwner during paused flow rejected unexpectedly");
    });

    try {
      await send(jid, PAUSED_REPLY);
    } catch (err) {
      log.error({ err, jid }, "failed to send paused canned reply");
    }
    return;
  }

  // Nothing to reason about — acknowledge the format and stop before the LLM.
  if (payload.kind === "unsupported") {
    await respondUnsupportedFormat({
      businessId,
      conversationId: conversation.id,
      format: payload.format,
      jid,
      send,
      log,
    });

    // A photo is almost always a quote request, and the reply we just sent
    // promises the owner will see it ("Ya la comparto..."). Nothing else in the
    // codebase forwards it, so this push is what makes that promise true.
    //
    // Deliberately NOT gated on the notice cooldown above: that cooldown exists
    // to avoid repeating the same line at the CUSTOMER, while a second photo is
    // still a second thing the owner has to look at. Fire-and-forget so the
    // customer's reply is never blocked by an outbound send.
    if (payload.format === "image") {
      const who = customer.name?.trim() || "(sin nombre)";
      const photoText = [
        "📸 *Foto recibida*",
        `Cliente: ${who} (${phone})`,
        "Te mandó una foto para cotización.",
        "Revisá WhatsApp para verla y confirmarle el precio.",
      ].join("\n");
      ownerNotifier.notifyOwner(businessId, photoText).catch((err) => {
        log.warn({ err }, "notifyOwner for received photo rejected unexpectedly");
      });
    }
    return;
  }

  // ESCALATED — a human owes this thread an answer. Replying with the LLM here
  // talks over them and makes the escalation we just promised look like it
  // never happened. Placed after the unsupported branch on purpose: a photo
  // sent mid-escalation must still reach the owner.
  if (conversation.status === "escalated") {
    if (shouldSendEscalatedNotice(conversation.id)) {
      const persisted = await messageService.append({
        businessId,
        conversationId: conversation.id,
        role: "assistant",
        content: ESCALATED_REPLY,
      });
      if (!persisted.ok) {
        log.error({ code: persisted.error.code }, "append escalated canned reply failed");
      }
      try {
        await send(jid, ESCALATED_REPLY);
        log.info({ conversationId: conversation.id }, "escalated: canned reply sent, LLM skipped");
      } catch (err) {
        log.error({ err, jid }, "failed to send escalated canned reply");
      }
    } else {
      log.info(
        { conversationId: conversation.id },
        "escalated: within notice cooldown, staying silent",
      );
    }
    return;
  }

  // Normal LLM flow.
  const llmResult = await llmService.generateReply({
    businessId,
    conversationId: conversation.id,
    userMessage: text,
  });

  let replyText: string;
  if (llmResult.ok) {
    replyText = sanitizeForWhatsApp(llmResult.data.content);
    log.info(
      {
        conversationId: conversation.id,
        tokensInput: llmResult.data.tokensInput,
        tokensOutput: llmResult.data.tokensOutput,
        toolsExecuted: llmResult.data.toolCallsExecuted.map((t) => t.name),
        escalated: llmResult.data.escalated,
        maxIterationsHit: llmResult.data.maxIterationsHit,
      },
      "llm reply generated",
    );
  } else {
    replyText = LLM_FALLBACK_REPLY;
    log.error(
      { code: llmResult.error.code, context: llmResult.error.logContext },
      "llm generateReply failed, using fallback message",
    );
    const fallbackPersist = await messageService.append({
      businessId,
      conversationId: conversation.id,
      role: "assistant",
      content: replyText,
    });
    if (!fallbackPersist.ok) {
      log.error(
        {
          err: fallbackPersist.error.logContext,
          code: fallbackPersist.error.code,
        },
        "append fallback assistant message failed",
      );
    }
  }

  log.info(
    { jid, replyLen: replyText.length, replyPreview: replyText.slice(0, 60) },
    "about to send reply over whatsapp",
  );
  try {
    await send(jid, replyText);
    log.info({ jid }, "reply sent successfully");
  } catch (err) {
    log.error({ err, jid }, "failed to send reply over whatsapp");
  }
}

export function handleIncomingMessage(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
): Promise<void> {
  const log = logger.child({ component: "whatsapp.handler", businessId });

  if (raw.key.fromMe) {
    log.info({ jid: raw.key.remoteJid }, "handler skip: fromMe");
    return Promise.resolve();
  }
  const jid = raw.key.remoteJid;
  if (!jid) {
    log.info("handler skip: no remoteJid");
    return Promise.resolve();
  }
  if (jid.endsWith("@g.us") || jid === "status@broadcast") {
    log.info({ jid }, "handler skip: group or status");
    return Promise.resolve();
  }

  const phone = extractPhone(raw);
  if (!phone) {
    // Log everything we've got so we can see which field WA populated for
    // this LID message shape (senderPn / remoteJidAlt / participant).
    const key = raw.key as {
      senderPn?: string;
      remoteJidAlt?: string;
      participant?: string;
    };
    log.warn(
      {
        jid,
        keyShape: Object.keys(raw.key),
        senderPn: key.senderPn,
        remoteJidAlt: key.remoteJidAlt,
        participant: key.participant,
      },
      "handler skip: no phone extractable from JID",
    );
    return Promise.resolve();
  }
  const incoming = classifyIncoming(raw);
  if (incoming.kind === "ignorable") {
    // Unknown shapes are warn-logged rather than dropped quietly: silence here
    // is what hid the ephemeral-message bug, where ordinary text from anyone
    // using disappearing messages never reached Emma at all.
    if (incoming.reason === "unknown") {
      log.warn({ jid, msgKeys: incoming.keys }, "handler skip: unrecognised message shape");
    } else {
      log.info({ jid, reason: incoming.reason }, "handler skip: no answerable payload");
    }
    return Promise.resolve();
  }

  const payload: Payload =
    incoming.kind === "text"
      ? { kind: "text", text: incoming.text }
      : { kind: "unsupported", format: incoming.format };

  log.info(
    incoming.kind === "text"
      ? { phone, textPreview: incoming.text.slice(0, 60) }
      : { phone, format: incoming.format },
    "handler accepted incoming message",
  );
  return withSenderLock(`${businessId}:${phone}`, () =>
    processMessage(raw, businessId, send, jid, phone, payload),
  );
}
