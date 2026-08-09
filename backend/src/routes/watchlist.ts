import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { isValidSolanaAddress } from "../lib/solana.js";
import { getSnapshot } from "../services/prices.js";
import { createLogger } from "../logger.js";

const log = createLogger("routes:watchlist");

// The move threshold is a magnitude (we alert both directions); users sometimes
// type "-15" meaning "down 15%", so normalise to a positive number.
function cleanPct(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.abs(n);
}

export default async function watchlistRoutes(app: FastifyInstance) {
  app.get("/watchlist", async () => {
    return prisma.watchToken.findMany({
      orderBy: { createdAt: "desc" },
      include: { targets: { orderBy: { createdAt: "desc" } } },
    });
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
        imageUrl: snap.imageUrl ?? null,
        movePct: body.movePct != null ? cleanPct(body.movePct) : null,
        windowMin: body.windowMin ?? null,
        baselinePrice: snap.priceUsd ?? null,
        lastPrice: snap.priceUsd ?? null,
        lastMarketCap: snap.marketCapUsd ?? null,
      },
      include: { targets: true },
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
        // "field present in body" means set it (null resets to the default).
        movePct:
          "movePct" in body
            ? body.movePct == null
              ? null
              : cleanPct(body.movePct)
            : token.movePct,
        windowMin: "windowMin" in body ? body.windowMin : token.windowMin,
        active: body.active ?? token.active,
      },
      include: { targets: { orderBy: { createdAt: "desc" } } },
    });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/watchlist/:id", async (req, reply) => {
    const token = await prisma.watchToken.findUnique({ where: { id: req.params.id } });
    if (!token) return reply.code(404).send({ error: "not found" });
    await prisma.watchToken.delete({ where: { id: req.params.id } });
    log.info(`removed $${token.symbol ?? token.address.slice(0, 6)} from watchlist`);
    return { ok: true };
  });

  // ── Targets: "alert me if it gains/drops X% (or hits $Y mcap) [within Z hours]" ──

  app.post<{ Params: { id: string } }>("/watchlist/:id/targets", async (req, reply) => {
    const body = (req.body ?? {}) as {
      metric?: string;
      direction?: string;
      value?: number;
      deadlineHours?: number;
    };
    const token = await prisma.watchToken.findUnique({ where: { id: req.params.id } });
    if (!token) return reply.code(404).send({ error: "token not found" });

    const metric = body.metric === "MARKET_CAP" ? "MARKET_CAP" : "PRICE_PCT";
    const direction = body.direction === "DOWN" ? "DOWN" : "UP";
    const value = Number(body.value);
    if (!Number.isFinite(value) || value <= 0) {
      return reply.code(400).send({ error: "target value must be a positive number" });
    }
    const deadlineHours = Number(body.deadlineHours);
    const deadline =
      Number.isFinite(deadlineHours) && deadlineHours > 0
        ? new Date(Date.now() + deadlineHours * 3_600_000)
        : null;

    // Snapshot the current price/mcap as the baseline for the target.
    const snap = await getSnapshot(token.address);
    const baseline = metric === "MARKET_CAP" ? snap.marketCapUsd ?? null : snap.priceUsd ?? null;
    if (metric === "MARKET_CAP" && baseline == null) {
      log.warn(`no market cap available for ${token.address} — target created without baseline`);
    }

    const target = await prisma.watchTarget.create({
      data: {
        tokenId: token.id,
        metric,
        direction,
        value,
        baseline,
        deadline,
      },
    });
    log.info(
      `target on $${token.symbol ?? token.address.slice(0, 6)}: ${direction} ` +
        (metric === "MARKET_CAP" ? `to $${value} mcap` : `${value}%`) +
        (deadline ? ` within ${deadlineHours}h` : ""),
    );
    return reply.code(201).send(target);
  });

  app.delete<{ Params: { id: string; targetId: string } }>(
    "/watchlist/:id/targets/:targetId",
    async (req, reply) => {
      const target = await prisma.watchTarget.findUnique({
        where: { id: req.params.targetId },
      });
      if (!target || target.tokenId !== req.params.id) {
        return reply.code(404).send({ error: "not found" });
      }
      await prisma.watchTarget.delete({ where: { id: target.id } });
      return { ok: true };
    },
  );
}
