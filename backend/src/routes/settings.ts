import type { FastifyInstance } from "fastify";
import { config, features } from "../config.js";
import { getChatId, setChatId, send as sendTelegram } from "../services/telegram.js";
import { prisma, getSetting } from "../db.js";
import { listWebhooks } from "../services/helius.js";
import { verifyWebhook } from "../engine/heliusSync.js";

export default async function settingsRoutes(app: FastifyInstance) {
  // Current settings + which integrations are wired up.
  app.get("/settings", async () => {
    const chatId = await getChatId();
    return {
      telegramChatId: chatId,
      features,
    };
  });

  // Save the Telegram chat id from the dashboard.
  app.post("/settings/telegram", async (req, reply) => {
    const body = (req.body ?? {}) as { chatId?: string };
    const chatId = body.chatId?.trim();
    if (!chatId) return reply.code(400).send({ error: "chatId required" });
    await setChatId(chatId);
    return { ok: true, chatId };
  });

  // Diagnostics: what the SERVER thinks the Helius registration looks like.
  app.get("/settings/webhook-status", async () => {
    const wallets = await prisma.wallet.findMany({
      where: { active: true },
      select: { address: true },
    });
    const hooks = await listWebhooks();
    return {
      publicBaseUrl: config.PUBLIC_BASE_URL ?? null,
      activeWallets: wallets.map((w) => w.address),
      storedWebhookId: await getSetting("helius_webhook_id"),
      helius: hooks.map((h) => ({
        webhookID: h.webhookID,
        webhookURL: h.webhookURL,
        transactionTypes: h.transactionTypes,
        accountAddresses: h.accountAddresses,
      })),
    };
  });

  // Force a webhook repair pass and return the resulting registration.
  app.post("/settings/webhook-repair", async () => {
    await verifyWebhook();
    const hooks = await listWebhooks();
    return {
      helius: hooks.map((h) => ({
        webhookID: h.webhookID,
        webhookURL: h.webhookURL,
        accountAddresses: h.accountAddresses,
      })),
    };
  });

  // Fire a test alert so the user can confirm notifications work end-to-end.
  app.post("/settings/test-alert", async (_req, reply) => {
    const ok = await sendTelegram(
      "🔔 *Nexus test alert*\nIf you can read this, notifications are working.",
    );
    if (!ok) {
      return reply
        .code(400)
        .send({ error: "could not send — check bot token and chat id" });
    }
    return { ok: true };
  });
}
