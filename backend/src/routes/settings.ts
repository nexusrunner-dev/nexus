import type { FastifyInstance } from "fastify";
import { features } from "../config.js";
import { getChatId, setChatId, send as sendTelegram } from "../services/telegram.js";

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
