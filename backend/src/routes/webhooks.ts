import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { normalizeSwaps } from "../services/helius.js";
import { processSwapEvents } from "../engine/wallets.js";
import { createLogger } from "../logger.js";

const log = createLogger("routes:webhooks");

export default async function webhookRoutes(app: FastifyInstance) {
  // Helius posts enhanced transactions here whenever a tracked wallet acts.
  app.post("/webhooks/helius", async (req, reply) => {
    // Verify the shared secret we registered as the webhook's authHeader.
    const auth = req.headers["authorization"];
    if (auth !== config.WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const payload = req.body;
    const txs = Array.isArray(payload) ? payload : payload ? [payload] : [];
    if (txs.length === 0) return { ok: true };

    // Acknowledge immediately, then process — Helius retries on non-2xx.
    reply.send({ ok: true });

    try {
      const wallets = await prisma.wallet.findMany({
        where: { active: true },
        select: { address: true },
      });
      const owners = new Set(wallets.map((w) => w.address));
      const events = normalizeSwaps(txs as any[], owners);
      if (events.length) {
        log.info(`processing ${events.length} swap event(s)`);
        await processSwapEvents(events);
      }
    } catch (err) {
      log.error("webhook processing failed", String(err));
    }
  });
}
