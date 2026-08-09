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
  imageUrl: string | null;
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
  if (snap.marketCapUsd != null) patch.lastMarketCap = snap.marketCapUsd;
  if (!token.symbol && snap.symbol) patch.symbol = snap.symbol;
  if (!token.name && snap.name) patch.name = snap.name;
  if (!token.imageUrl && snap.imageUrl) patch.imageUrl = snap.imageUrl;
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
  // Magnitude only — old rows may hold a negative value the user typed.
  const movePct = Math.abs(token.movePct ?? config.WATCH_DEFAULT_MOVE_PCT);
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

  // ── (c) User-defined targets (price % / market cap, optional deadline) ────
  await checkTargets(token.id, symbol, token.address, price, snap.marketCapUsd ?? null);

  await prisma.watchToken.update({ where: { id: token.id }, data: patch });
}

async function checkTargets(
  tokenId: string,
  symbol: string,
  address: string,
  price: number,
  marketCap: number | null,
): Promise<void> {
  const targets = await prisma.watchTarget.findMany({
    where: { tokenId, status: "PENDING" },
  });

  for (const t of targets) {
    const isMcap = t.metric === "MARKET_CAP";
    const current = isMcap ? marketCap : price;

    // Backfill a missing baseline (target created while price data was down).
    if (!isMcap && t.baseline == null && current != null) {
      await prisma.watchTarget.update({ where: { id: t.id }, data: { baseline: current } });
      t.baseline = current;
    }

    let hit = false;
    let progressLine = "";
    if (current != null) {
      if (isMcap) {
        hit = t.direction === "UP" ? current >= t.value : current <= t.value;
        progressLine = `Market cap now ${fmtUsdCompact(current)} (target ${fmtUsdCompact(t.value)})`;
      } else if (t.baseline != null && t.baseline > 0) {
        const pct = ((current - t.baseline) / t.baseline) * 100;
        hit = t.direction === "UP" ? pct >= t.value : pct <= -t.value;
        progressLine = `${fmtPct(pct)} since target set (goal ${t.direction === "UP" ? "+" : "-"}${t.value}%)`;
      }
    }

    if (hit) {
      const up = t.direction === "UP";
      await dispatchAlert({
        type: "TARGET_HIT",
        title: `🎯 $${symbol} hit your ${up ? "upside" : "downside"} target`,
        body:
          (isMcap
            ? `Reached *${fmtUsdCompact(t.value)}* market cap (${t.direction === "UP" ? "▲" : "▼"})\n`
            : `${up ? "Gained" : "Dropped"} *${t.value}%* as you asked\n`) +
          `${progressLine}\nPrice now ${fmtUsd(price)}`,
        tokenAddress: address,
        tokenSymbol: symbol,
        data: { targetId: t.id, metric: t.metric, direction: t.direction, value: t.value, price, marketCap },
        dedupeKey: `target-hit:${t.id}`,
      });
      await prisma.watchTarget.update({
        where: { id: t.id },
        data: { status: "HIT", resolvedAt: new Date() },
      });
      log.info(`$${symbol} target HIT (${t.metric} ${t.direction} ${t.value})`);
      continue;
    }

    // Deadline passed without hitting → tell the user it didn't make it.
    if (t.deadline && t.deadline.getTime() <= Date.now()) {
      await dispatchAlert({
        type: "TARGET_EXPIRED",
        title: `⏰ $${symbol} target expired`,
        body:
          (isMcap
            ? `Didn't reach ${fmtUsdCompact(t.value)} market cap in time\n`
            : `Didn't ${t.direction === "UP" ? "gain" : "drop"} ${t.value}% in time\n`) +
          (progressLine ? `${progressLine}\n` : "") +
          `Price now ${fmtUsd(price)}`,
        tokenAddress: address,
        tokenSymbol: symbol,
        data: { targetId: t.id, metric: t.metric, direction: t.direction, value: t.value, price, marketCap },
        dedupeKey: `target-exp:${t.id}`,
      });
      await prisma.watchTarget.update({
        where: { id: t.id },
        data: { status: "EXPIRED", resolvedAt: new Date() },
      });
      log.info(`$${symbol} target EXPIRED (${t.metric} ${t.direction} ${t.value})`);
    }
  }
}

async function pruneSamples(): Promise<void> {
  const cutoff = new Date(Date.now() - SAMPLE_RETENTION_MIN * 60_000);
  await prisma.priceSample.deleteMany({ where: { ts: { lt: cutoff } } });
}
