import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { dispatchAlert } from "../services/notifier.js";
import {
  getSolPriceUsd,
  getPriceUsd,
  getTokenMeta,
  getSnapshot,
} from "../services/prices.js";
import { highestNewRung } from "./multiples.js";
import type { SwapEvent } from "../services/helius.js";
import { getTokenHoldings } from "../services/helius.js";
import { fmtUsd, fmtUsdCompact, fmtMultiple, shortAddr } from "../lib/format.js";

// ────────────────────────────────────────────────────────────────────────────
//  Wallet tracking engine.
//
//  Alerts fired:
//   • ENTER    — wallet opens a fresh position (buys a coin it didn't hold)
//   • TRIM     — wallet sells PART of a position
//   • EXIT     — wallet sells out completely (with realized PnL)
//   • MULTIPLE — a held position crosses +50% / 2x / 3x / … / 1000x
//
//  Each alert shows the wallet's emoji+name, the token's ticker (when known),
//  and the trade size in both SOL and USD.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("wallet-engine");

// Below this fraction of the original size we treat a position as fully exited.
const DUST_FRACTION = 0.02;

type WalletLike = { emoji: string | null; label: string | null; address: string };

/** "🐳 whale.sol" / "💎 Smart Money" / "7xKX…9fQ2" */
function who(w: WalletLike): string {
  const name = w.label || shortAddr(w.address);
  return w.emoji ? `${w.emoji} ${name}` : name;
}

/** "$WIF" when we know the ticker, otherwise a short mint. */
function tokenLabel(symbol: string | null | undefined, address: string): string {
  return symbol ? `$${symbol}` : `${address.slice(0, 6)}…`;
}

const sol = (n: number) => `${n.toFixed(2)} SOL`;

export async function processSwapEvents(events: SwapEvent[]): Promise<void> {
  if (events.length === 0) return;
  const solPrice = await getSolPriceUsd();
  if (solPrice == null) {
    log.warn("no SOL price available — deferring swap processing");
    return;
  }

  for (const ev of events) {
    try {
      await processOne(ev, solPrice);
    } catch (err) {
      log.error(`failed processing swap ${ev.signature}`, String(err));
    }
  }
}

async function processOne(ev: SwapEvent, solPrice: number): Promise<void> {
  const wallet = await prisma.wallet.findUnique({ where: { address: ev.owner } });
  if (!wallet || !wallet.active) return;

  const usdValue = ev.solAmount * solPrice;
  const executedPrice = ev.tokenAmount > 0 ? usdValue / ev.tokenAmount : 0;

  const existing = await prisma.position.findUnique({
    where: {
      walletId_tokenAddress: { walletId: wallet.id, tokenAddress: ev.tokenAddress },
    },
  });

  // ── BUY ─────────────────────────────────────────────────────────────────
  if (ev.direction === "BUY") {
    if (!existing || existing.status === "CLOSED" || existing.amount <= 0) {
      const meta = await getTokenMeta(ev.tokenAddress);
      const tok = tokenLabel(meta.symbol, ev.tokenAddress);

      await prisma.position.upsert({
        where: {
          walletId_tokenAddress: { walletId: wallet.id, tokenAddress: ev.tokenAddress },
        },
        create: {
          walletId: wallet.id,
          tokenAddress: ev.tokenAddress,
          tokenSymbol: meta.symbol ?? null,
          amount: ev.tokenAmount,
          costBasisUsd: usdValue,
          avgEntryPriceUsd: executedPrice,
          status: "OPEN",
          maxMultipleAlerted: 1,
          openedAt: new Date(),
        },
        update: {
          tokenSymbol: meta.symbol ?? null,
          amount: ev.tokenAmount,
          costBasisUsd: usdValue,
          avgEntryPriceUsd: executedPrice,
          realizedPnlUsd: 0,
          status: "OPEN",
          maxMultipleAlerted: 1,
          openedAt: new Date(),
          closedAt: null,
        },
      });

      await dispatchAlert({
        type: "WALLET_ENTER",
        title: `🟢 ${who(wallet)} ENTERED ${tok}`,
        body:
          `Bought *${fmtUsdCompact(usdValue)}* (${sol(ev.solAmount)}) of ${tok}\n` +
          `Entry ≈ ${fmtUsd(executedPrice)} · ${ev.tokenAmount.toLocaleString()} tokens`,
        tokenAddress: ev.tokenAddress,
        tokenSymbol: meta.symbol ?? undefined,
        walletAddress: wallet.address,
        data: { usdValue, solAmount: ev.solAmount, executedPrice, signature: ev.signature },
        dedupeKey: `enter:${wallet.id}:${ev.tokenAddress}:${ev.signature}`,
      });
      log.info(`${who(wallet)} ENTER ${tok} (${fmtUsdCompact(usdValue)})`);
    } else {
      // Adding to an existing position — update cost basis, no alert.
      const newAmount = existing.amount + ev.tokenAmount;
      const newCost = existing.costBasisUsd + usdValue;
      await prisma.position.update({
        where: { id: existing.id },
        data: {
          amount: newAmount,
          costBasisUsd: newCost,
          avgEntryPriceUsd: newAmount > 0 ? newCost / newAmount : 0,
        },
      });
    }
    return;
  }

  // ── SELL ────────────────────────────────────────────────────────────────
  if (!existing || existing.status === "CLOSED" || existing.amount <= 0) return;

  const tok = tokenLabel(existing.tokenSymbol, ev.tokenAddress);
  const soldAmount = Math.min(ev.tokenAmount, existing.amount);
  const fractionSold = soldAmount / existing.amount;
  const proceedsUsd = usdValue;
  const costOfSold = existing.avgEntryPriceUsd * soldAmount;
  const realized = proceedsUsd - costOfSold;
  const remaining = existing.amount - soldAmount;
  const fullyOut = remaining <= existing.amount * DUST_FRACTION;

  if (fullyOut) {
    const totalRealized = existing.realizedPnlUsd + realized;
    const exitMultiple =
      existing.avgEntryPriceUsd > 0 ? executedPrice / existing.avgEntryPriceUsd : 0;
    await prisma.position.update({
      where: { id: existing.id },
      data: {
        amount: 0,
        costBasisUsd: 0,
        realizedPnlUsd: totalRealized,
        status: "CLOSED",
        closedAt: new Date(),
      },
    });

    const pnlEmoji = totalRealized >= 0 ? "🟩" : "🟥";
    await dispatchAlert({
      type: "WALLET_EXIT",
      title: `🔴 ${who(wallet)} EXITED ${tok}`,
      body:
        `Sold out — *${fmtUsdCompact(proceedsUsd)}* (${sol(ev.solAmount)})\n` +
        `${pnlEmoji} Realized PnL: *${fmtUsd(totalRealized)}* (${fmtMultiple(exitMultiple)})`,
      tokenAddress: ev.tokenAddress,
      tokenSymbol: existing.tokenSymbol ?? undefined,
      walletAddress: wallet.address,
      data: { realized: totalRealized, exitMultiple, proceedsUsd, solAmount: ev.solAmount, signature: ev.signature },
      dedupeKey: `exit:${wallet.id}:${ev.tokenAddress}:${ev.signature}`,
    });
    log.info(`${who(wallet)} EXIT ${tok} PnL ${fmtUsd(totalRealized)}`);
  } else {
    // Partial trim — reduce position and ALERT on the % sold.
    await prisma.position.update({
      where: { id: existing.id },
      data: {
        amount: remaining,
        costBasisUsd: existing.costBasisUsd * (1 - fractionSold),
        realizedPnlUsd: existing.realizedPnlUsd + realized,
      },
    });

    const pct = Math.round(fractionSold * 100);
    await dispatchAlert({
      type: "WALLET_TRIM",
      title: `🟠 ${who(wallet)} SOLD ${pct}% of ${tok}`,
      body:
        `Trimmed *${pct}%* — ${fmtUsdCompact(proceedsUsd)} (${sol(ev.solAmount)})\n` +
        `Still holding ≈ ${remaining.toLocaleString()} tokens`,
      tokenAddress: ev.tokenAddress,
      tokenSymbol: existing.tokenSymbol ?? undefined,
      walletAddress: wallet.address,
      data: { pct, proceedsUsd, solAmount: ev.solAmount, remaining, signature: ev.signature },
      dedupeKey: `trim:${wallet.id}:${ev.tokenAddress}:${ev.signature}`,
    });
    log.info(`${who(wallet)} TRIM ${pct}% ${tok}`);
  }
}

/**
 * Price-watcher hook: for each OPEN position compare current price to average
 * entry and fire a +50% / 2x / 3x / … alert the first time each rung is crossed.
 */
export async function checkWalletMultiples(): Promise<void> {
  const positions = await prisma.position.findMany({
    where: { status: "OPEN", amount: { gt: 0 } },
    include: { wallet: true },
  });
  if (positions.length === 0) return;

  const tokens = [...new Set(positions.map((p) => p.tokenAddress))];
  const priceMap = new Map<string, number>();
  for (const t of tokens) {
    const price = await getPriceUsd(t);
    if (price != null) priceMap.set(t, price);
  }

  for (const pos of positions) {
    const price = priceMap.get(pos.tokenAddress);
    if (price == null || pos.avgEntryPriceUsd <= 0) continue;
    const multiple = price / pos.avgEntryPriceUsd;
    const rung = highestNewRung(multiple, pos.maxMultipleAlerted);
    if (!rung) continue;

    const tok = tokenLabel(pos.tokenSymbol, pos.tokenAddress);
    const rungLabel = rung === 1.5 ? "+50%" : `${rung}x`;
    const currentValue = pos.amount * price;
    await dispatchAlert({
      type: "WALLET_MULTIPLE",
      title: `🚀 ${who(pos.wallet)} is up ${rungLabel} on ${tok}`,
      body:
        `Position in ${tok} hit *${fmtMultiple(multiple)}*\n` +
        `Entry ${fmtUsd(pos.avgEntryPriceUsd)} → now ${fmtUsd(price)}\n` +
        `Unrealized value ≈ ${fmtUsdCompact(currentValue)}`,
      tokenAddress: pos.tokenAddress,
      tokenSymbol: pos.tokenSymbol ?? undefined,
      walletAddress: pos.wallet.address,
      data: { multiple, rung, price, entry: pos.avgEntryPriceUsd },
      dedupeKey: `wmult:${pos.id}:${rung}`,
    });
    await prisma.position.update({
      where: { id: pos.id },
      data: { maxMultipleAlerted: rung },
    });
    log.info(`${who(pos.wallet)} ${rungLabel} on ${tok}`);
  }
}

/**
 * Snapshot a newly-added wallet's existing holdings as OPEN positions (with the
 * current price as the entry baseline), so we don't fire a false EXIT on a bag
 * they held before tracking, and multiples are measured from when you added them.
 */
export async function seedWalletPositions(
  walletId: string,
  address: string,
): Promise<void> {
  const holdings = await getTokenHoldings(address);
  if (holdings.length === 0) return;

  for (const h of holdings) {
    const snap = await getSnapshot(h.mint);
    const price = snap.priceUsd;
    if (price == null || price <= 0) continue;
    const value = h.amount * price;
    if (value < 5) continue; // skip dust worth < $5

    await prisma.position.upsert({
      where: { walletId_tokenAddress: { walletId, tokenAddress: h.mint } },
      create: {
        walletId,
        tokenAddress: h.mint,
        tokenSymbol: snap.symbol ?? null,
        amount: h.amount,
        costBasisUsd: value,
        avgEntryPriceUsd: price,
        status: "OPEN",
        maxMultipleAlerted: 1,
      },
      update: {}, // don't clobber an existing tracked position
    });
  }
  log.info(`seeded ${holdings.length} holdings for ${shortAddr(address)}`);
}
