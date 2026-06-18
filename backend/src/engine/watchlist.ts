import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { dispatchAlert } from "../services/notifier.js";
import { getSnapshot } from "../services/prices.js";
import { highestNewRung } from "./multiples.js";
import { fmtUsd, fmtUsdCompact, fmtPct, fmtMultiple } from "../lib/format.js";

// ────────────────────────────────────────────────────────────────────────────
//  Watchlist watcher.
//  Each pass: snapshot every active token, persist a price sample, then check
//  for (a) a sharp % move within the configured window, and (b) crossing a new
//  Nx rung vs the price when it was added. Old samples are pruned to keep the
//  table small.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("watchlist");
const SAMPLE_RETENTION_MIN = 120;

export async function checkWatchlist(): Promise<void> {
  const tokens = await prisma.watchToken.findMany({ where: { active: true } });
  if (tokens.length === 0) return;

  for (const token of tokens) {
    try {
      await checkOne(token);
    } catch (err) {
      log.error(`failed checking ${token.address}`, String(err));
    }
  }

  await pruneSamples();
}

async function checkOne(token: {
  id: string;
  address: string;
  symbol: string | null;
  name: string | null;
  movePct: number | null;
  windowMin: number | null;
  baselinePrice: number | null;
  maxMultipleAlerted: number;
}): Promise<void> {
  const snap = await getSnapshot(token.address);
  if (snap.priceUsd == null) return;
  const price = snap.priceUsd;
  const symbol = token.symbol ?? snap.symbol ?? token.address.slice(0, 6);

  // Backfill metadata + baseline on first sighting.
  const patch: Prisma.WatchTokenUpdateInput = { lastPrice: price };
  if (!token.symbol && snap.symbol) patch.symbol = snap.symbol;
  if (!token.name && snap.name) patch.name = snap.name;
  if (token.baselinePrice == null) patch.baselinePrice = price;

  // Record a sample for windowed move detection.
  await prisma.priceSample.create({
    data: {
      tokenAddress: token.address,
      priceUsd: price,
      liquidityUsd: snap.liquidityUsd,
      volume24hUsd: snap.volume24hUsd,
    },
  });

  // ── (a) Sharp move within the window ──────────────────────────────────────
  const windowMin = token.windowMin ?? config.WATCH_DEFAULT_WINDOW_MIN;
  const movePct = token.movePct ?? config.WATCH_DEFAULT_MOVE_PCT;
  const since = new Date(Date.now() - windowMin * 60_000);
  const past =
    (await prisma.priceSample.findFirst({
      where: { tokenAddress: token.address, ts: { lte: since } },
      orderBy: { ts: "desc" },
    })) ??
    (await prisma.priceSample.findFirst({
      where: { tokenAddress: token.address },
      orderBy: { ts: "asc" },
    }));

  if (past && past.priceUsd > 0) {
    const pct = ((price - past.priceUsd) / past.priceUsd) * 100;
    if (Math.abs(pct) >= movePct) {
      const up = pct > 0;
      await dispatchAlert({
        type: "WATCH_MOVE",
        title: `${up ? "📈" : "📉"} $${symbol} ${up ? "pumping" : "dumping"} ${fmtPct(pct)}`,
        body:
          `${fmtPct(pct)} in ~${windowMin}m → now ${fmtUsd(price)}\n` +
          `24h ${fmtPct(snap.priceChange.h24)} · Liq ${fmtUsdCompact(snap.liquidityUsd)} · Vol ${fmtUsdCompact(snap.volume24hUsd)}`,
        tokenAddress: token.address,
        tokenSymbol: symbol,
        data: { pct, windowMin, price },
        // Direction-aware key, bucketed by the cooldown so it won't spam.
        dedupeKey: `move:${token.id}:${up ? "up" : "down"}`,
        cooldownMin: config.ALERT_COOLDOWN_MIN,
      });
      log.info(`$${symbol} move ${fmtPct(pct)}`);
    }
  }

  // ── (b) New Nx rung vs baseline ───────────────────────────────────────────
  const baseline = token.baselinePrice ?? price;
  if (baseline > 0) {
    const multiple = price / baseline;
    const rung = highestNewRung(multiple, token.maxMultipleAlerted);
    if (rung) {
      await dispatchAlert({
        type: "WATCH_MULTIPLE",
        title: `🚀 $${symbol} hit ${rung}x`,
        body:
          `Up *${fmtMultiple(multiple)}* since you added it\n` +
          `${fmtUsd(baseline)} → ${fmtUsd(price)}`,
        tokenAddress: token.address,
        tokenSymbol: symbol,
        data: { multiple, rung, baseline, price },
        dedupeKey: `wlmult:${token.id}:${rung}`,
      });
      patch.maxMultipleAlerted = rung;
      log.info(`$${symbol} ${rung}x since added`);
    }
  }

  await prisma.watchToken.update({ where: { id: token.id }, data: patch });
}

async function pruneSamples(): Promise<void> {
  const cutoff = new Date(Date.now() - SAMPLE_RETENTION_MIN * 60_000);
  await prisma.priceSample.deleteMany({ where: { ts: { lt: cutoff } } });
}
