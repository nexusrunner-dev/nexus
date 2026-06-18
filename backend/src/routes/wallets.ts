import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { isValidSolanaAddress } from "../lib/solana.js";
import { syncWebhook } from "../engine/heliusSync.js";
import { seedWalletPositions } from "../engine/wallets.js";
import { createLogger } from "../logger.js";

const log = createLogger("routes:wallets");

export default async function walletsRoutes(app: FastifyInstance) {
  // List tracked wallets with a count of open positions.
  app.get("/wallets", async () => {
    const wallets = await prisma.wallet.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { positions: true } } },
    });
    return wallets.map((w) => ({
      id: w.id,
      address: w.address,
      label: w.label,
      active: w.active,
      positions: w._count.positions,
      createdAt: w.createdAt,
    }));
  });

  // Add a wallet to track.
  app.post("/wallets", async (req, reply) => {
    const body = (req.body ?? {}) as { address?: string; label?: string };
    const address = body.address?.trim();
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ error: "invalid Solana address" });
    }
    const existing = await prisma.wallet.findUnique({ where: { address } });
    if (existing) {
      return reply.code(409).send({ error: "wallet already tracked" });
    }

    const wallet = await prisma.wallet.create({
      data: { address, label: body.label?.trim() || null },
    });

    // Register with Helius + seed current holdings (don't block the response).
    syncWebhook().catch((e) => log.error("sync after add", String(e)));
    seedWalletPositions(wallet.id, wallet.address).catch((e) =>
      log.error("seed after add", String(e)),
    );

    return reply.code(201).send(wallet);
  });

  // Wallet detail + open positions.
  app.get<{ Params: { id: string } }>("/wallets/:id", async (req, reply) => {
    const wallet = await prisma.wallet.findUnique({
      where: { id: req.params.id },
      include: {
        positions: { orderBy: { updatedAt: "desc" } },
      },
    });
    if (!wallet) return reply.code(404).send({ error: "not found" });
    return wallet;
  });

  // Stop tracking a wallet (deletes it and its positions).
  app.delete<{ Params: { id: string } }>("/wallets/:id", async (req, reply) => {
    const wallet = await prisma.wallet.findUnique({ where: { id: req.params.id } });
    if (!wallet) return reply.code(404).send({ error: "not found" });
    await prisma.wallet.delete({ where: { id: req.params.id } });
    syncWebhook().catch((e) => log.error("sync after delete", String(e)));
    return { ok: true };
  });
}
