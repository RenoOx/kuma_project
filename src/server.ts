import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import * as businessService from "./modules/business/business.service.js";
import { makeWhatsappClient } from "./modules/whatsapp/baileys.client.js";
import { registerClient } from "./modules/whatsapp/clientRegistry.js";
import { handleIncomingMessage } from "./modules/whatsapp/handler.js";
import { cleanupOwnerThreadMessages } from "./workers/cleanupOwnerThread.js";

const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    logger.info(
      { port: info.port, env: env.NODE_ENV },
      "kuma server listening",
    );
  },
);

const RECONNECT_DELAY_MS = 5_000;

async function startWhatsappFor(businessId: string): Promise<void> {
  const sessionDir = `${env.SESSIONS_DIR}/${businessId}`;

  const client = await makeWhatsappClient({ businessId, sessionDir });

  // Register the live client for proactive notifications. We register on
  // EVERY boot (including reconnects below), because the underlying socket
  // reference is fresh after a reconnect and the old one would silently
  // fail to send.
  registerClient(businessId, client);

  client.onMessage((raw) =>
    handleIncomingMessage(raw, businessId, client.sendMessage),
  );

  client.onDisconnect((reason) => {
    if (reason === "logout") {
      logger.error(
        { businessId },
        "whatsapp logged out — delete the session folder and restart to reconnect",
      );
      return;
    }
    logger.warn(
      { businessId, delayMs: RECONNECT_DELAY_MS },
      "whatsapp dropped, scheduling reconnect",
    );
    setTimeout(() => {
      startWhatsappFor(businessId).catch((err) => {
        logger.error({ err, businessId }, "whatsapp reconnect failed");
      });
    }, RECONNECT_DELAY_MS).unref();
  });
}

async function bootWhatsapp(): Promise<void> {
  const businessId = env.BUSINESS_ID;
  if (!businessId) {
    logger.info(
      "BUSINESS_ID not set — skipping whatsapp boot (health endpoint only)",
    );
    return;
  }

  const businessResult = await businessService.getById(businessId);
  if (!businessResult.ok) {
    logger.error(
      { businessId, code: businessResult.error.code },
      "BUSINESS_ID is set but the business does not exist; skipping whatsapp boot",
    );
    return;
  }
  logger.info(
    {
      businessId,
      name: businessResult.data.name,
      whatsappNumber: businessResult.data.whatsappNumber,
    },
    "booting whatsapp client for business",
  );
  await startWhatsappFor(businessId);
}

bootWhatsapp().catch((err) => {
  logger.fatal({ err }, "failed to bootstrap whatsapp");
});

// Owner-thread message cleanup. Runs every hour, deleting messages older
// than 48h in any owner_thread conversation. .unref() so the timer doesn't
// keep the process alive on its own during shutdown.
// TODO Día 11: migrar a BullMQ scheduled job cuando deployemos a Railway.
const OWNER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  cleanupOwnerThreadMessages().catch((err) => {
    logger.error({ err }, "owner_thread cleanup failed");
  });
}, OWNER_CLEANUP_INTERVAL_MS).unref();
logger.info(
  { intervalMs: OWNER_CLEANUP_INTERVAL_MS },
  "owner_thread cleanup scheduled (setInterval)",
);

const shutdown = (signal: string): void => {
  logger.info({ signal }, "received shutdown signal");
  server.close(() => {
    logger.info("server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled rejection");
  process.exit(1);
});
