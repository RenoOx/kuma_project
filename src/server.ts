import { serve } from "@hono/node-server";
import { rm } from "node:fs/promises";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import * as businessRepo from "./modules/business/business.repo.js";
import { makeWhatsappClient } from "./modules/whatsapp/baileys.client.js";
import {
  registerClient,
  setConnectionStatus,
  storePairingCode,
  storeQR,
} from "./modules/whatsapp/clientRegistry.js";
import { handleIncomingMessage } from "./modules/whatsapp/handler.js";
import { cleanupOwnerThreadMessages } from "./workers/cleanupOwnerThread.js";
import { sendDueReminders } from "./workers/sendReminders.js";

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

async function startWhatsappFor(businessId: string, whatsappNumber: string): Promise<void> {
  const sessionDir = `${env.SESSIONS_DIR}/${businessId}`;

  const client = await makeWhatsappClient({ businessId, sessionDir });

  // Register the live client for proactive notifications. We register on
  // EVERY boot (including reconnects below), because the underlying socket
  // reference is fresh after a reconnect and the old one would silently
  // fail to send.
  registerClient(businessId, client);

  client.onQR((qr) => {
    storeQR(businessId, qr);
    logger.info({ businessId }, "whatsapp QR stored — visit /admin/whatsapp/qr to scan");
  });

  client.onPairingCode((code) => {
    storePairingCode(businessId, code);
    logger.info({ businessId }, "pairing code stored — visit /admin/whatsapp/pair to see it");
  });

  client.onConnect(() => {
    setConnectionStatus(businessId, "connected");
  });

  client.onMessage((raw) =>
    handleIncomingMessage(raw, businessId, client.sendMessage),
  );

  client.onDisconnect((reason) => {
    if (reason === "logout") {
      setConnectionStatus(businessId, "logged_out");
      logger.error(
        { businessId, sessionDir },
        "whatsapp logged out — auto-clearing stale session and restarting for fresh pairing",
      );
      // Auto-recovery: WA revoked these creds (401 loggedOut). The only path
      // forward is a fresh session + new QR/pairing code. Delete files and
      // restart the client so the operator can just re-scan without SSH access.
      setTimeout(() => {
        rm(sessionDir, { recursive: true, force: true })
          .then(() => {
            logger.info({ businessId, sessionDir }, "stale session cleared, booting fresh client");
            return startWhatsappFor(businessId, whatsappNumber);
          })
          .catch((err) => {
            logger.error({ err, businessId }, "auto-recovery after logout failed");
          });
      }, RECONNECT_DELAY_MS).unref();
      return;
    }
    logger.warn(
      { businessId, delayMs: RECONNECT_DELAY_MS },
      "whatsapp dropped, scheduling reconnect",
    );
    setTimeout(() => {
      startWhatsappFor(businessId, whatsappNumber).catch((err) => {
        logger.error({ err, businessId }, "whatsapp reconnect failed");
      });
    }, RECONNECT_DELAY_MS).unref();
  });
}

async function bootWhatsapp(): Promise<void> {
  const allBusinesses = await businessRepo.findAll();

  if (allBusinesses.length === 0) {
    logger.info(
      "no businesses in DB — skipping whatsapp boot (create one via admin API)",
    );
    return;
  }

  logger.info({ count: allBusinesses.length }, "booting whatsapp clients");

  for (const business of allBusinesses) {
    logger.info(
      { businessId: business.id, name: business.name, whatsappNumber: business.whatsappNumber },
      "booting whatsapp client for business",
    );
    startWhatsappFor(business.id, business.whatsappNumber).catch((err) => {
      logger.error({ err, businessId: business.id }, "whatsapp boot failed for business");
    });
  }
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

// Reminder worker. Polls every 15 min looking for appointments whose
// `scheduled_at` falls in the 24h or 2h reminder window AND whose matching
// `reminder_*_sent_at` column is still NULL.
// TODO V1.5: migrar a BullMQ scheduled jobs cuando incorporemos Redis.
const REMINDER_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  sendDueReminders().catch((err) => {
    logger.error({ err }, "sendDueReminders job failed");
  });
}, REMINDER_INTERVAL_MS).unref();
logger.info(
  { intervalMs: REMINDER_INTERVAL_MS },
  "reminders worker scheduled (setInterval)",
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
