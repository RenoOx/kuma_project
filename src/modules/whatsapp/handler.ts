import { logger } from "@/config/logger.js";
import * as businessService from "@/modules/business/business.service.js";
import * as conversationService from "@/modules/conversation/conversation.service.js";
import * as customerService from "@/modules/customer/customer.service.js";
import * as eventsRepo from "@/modules/events/events.repo.js";
import * as llmService from "@/modules/llm/llm.service.js";
import * as messageService from "@/modules/message/message.service.js";
import * as ownerAssistantService from "@/modules/ownerAssistant/ownerAssistant.service.js";
import * as ownerNotifier from "@/modules/whatsapp/ownerNotifier.js";
import type { WAMessage } from "@whiskeysockets/baileys";

const LLM_FALLBACK_REPLY =
  "Disculpa, estoy con un problema técnico. Intenta de nuevo en un memento.";

const PAUSED_REPLY =
  "En este momento no podemos atenderte automáticamente. Un asesor te contactará pronto.";

const OWNER_FALLBACK_REPLY = "Algo se rompió de mi lado, prueba de nuevo.";

export type SendFn = (jid: string, text: string) => Promise<void>;

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

// Returns the user-visible text of a Baileys message, or null if the message
// has no plain text payload we can answer to (media, reactions, status, etc.).
function extractText(msg: WAMessage): string | null {
  const message = msg.message;
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text)
    return message.extendedTextMessage.text;
  return null;
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

async function processMessage(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
  jid: string,
  phone: string,
  text: string,
): Promise<void> {
  const log = logger.child({ component: "whatsapp.handler", businessId });

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

    const result = await ownerAssistantService.handle(
      businessId,
      ownerThread.data.id,
      text,
    );
    let replyText: string;
    if (result.ok) {
      replyText = result.data.content;
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
    return;
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

  // Normal LLM flow.
  const llmResult = await llmService.generateReply({
    businessId,
    conversationId: conversation.id,
    userMessage: text,
  });

  let replyText: string;
  if (llmResult.ok) {
    replyText = llmResult.data.content;
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

  try {
    await send(jid, replyText);
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
  const text = extractText(raw);
  if (!text) {
    log.info({ jid, msgKeys: raw.message ? Object.keys(raw.message) : [] }, "handler skip: no text payload");
    return Promise.resolve();
  }

  log.info({ phone, textPreview: text.slice(0, 60) }, "handler accepted incoming message");
  return withSenderLock(`${businessId}:${phone}`, () =>
    processMessage(raw, businessId, send, jid, phone, text),
  );
}
