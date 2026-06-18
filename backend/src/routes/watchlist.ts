import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { isValidSolanaAddress } from "../lib/solana.js";
import { getSnapshot } from "../services/prices.js";
import { createLogger } from "../logger.js";

const log = createLogger("routes:watchlist");

export default async function watchlistRoutes(app: FastifyInstance) {
  app.get("/watchlist", async () => {
    return prisma.watchToken.findMany({ orderBy: { createdAt: "desc" } });
  });

  // Add a coin to the watchlist. Optionally override the move threshold/window.
  app.post("/watchlist", async (req, reply) => {
    const body = (req.body ?? {}) as {
      address?: string;
      movePct?: number;
      windowMin?: number;
    };
    const address = body.address?.trim();
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ error: "invalid Solana address" });
    }
    const existing = await prisma.watchToken.findUnique({ where: { address } });
    if (existing) {
      return reply.code(409).send({ error: "already on watchlist" });
    }

    // Fetch metadata + a baseline price up front so alerts work immediately.
    const snap = await getSnapshot(address);

    const token = await prisma.watchToken.create({
      data: {
        address,
        symbol: snap.symbol ?? null,
        name: snap.name ?? null,
        movePct: body.movePct ?? null,
        windowMin: body.windowMin ?? null,
        baselinePrice: snap.priceUsd ?? null,
        lastPrice: snap.priceUsd ?? null,
      },
    });
    log.info(`added $${snap.symbol ?? address.slice(0, 6)} to watchlist`);
    return reply.code(201).send(token);
  });

  // Tune thresholds or pause/resume a token.
  app.patch<{ Params: { id: string } }>("/watchlist/:id", async (req, reply) => {
    const body = (req.body ?? {}) as {
      movePct?: number | null;
      windowMin?: number | null;
      active?: boolean;
    };
    const token = await prisma.watchToken.findUnique({ where: { id: req.params.id } });
    if (!token) return reply.code(404).send({ error: "not found" });

    const updated = await prisma.watchToken.update({
      where: { id: req.params.id },
      data: {
        movePct: body.movePct ?? token.movePct,
        windowMin: body.windowMin ?? token.windowMin,
        active: body.active ?? token.active,
      },
    });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/watchlist/:id", async (req, reply) => {
    const token = await prisma.watchToken.findUnique({ where: { id: req.params.id } });
    if (!token) return reply.code(404).send({ error: "not found" });
    await prisma.watchToken.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
