import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { dispatchAlert } from "../services/notifier.js";
import { getSolPriceUsd, getPriceUsd } from "../services/prices.js";
import { highestNewRung } from "./multiples.js";
import type { SwapEvent } from "../services/helius.js";
import { getTokenHoldings } from "../services/helius.js";
import {
  fmtUsd,
  fmtUsdCompact,
  fmtMultiple,
  shortAddr,
} from "../lib/format.js";

// ────────────────────────────────────────────────────────────────────────────
//  Wallet tracking engine.
//
//  • processSwapEvents — consumes normalised BUY/SELL events (from the Helius
//    webhook) and maintains each wallet's position + cost basis, firing
//    ENTER and EXIT alerts.
//  • checkWalletMultiples — run by the price watcher; for every OPEN position it
//    compares the current price to the average entry and fires 2x/3x/… alerts.
//  • seedWalletPositions — snapshots a newly-added wallet's current holdings so
//    we have a baseline (no false ENTER, and a starting point for multiples).
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("wallet-engine");

// Below this fraction of the original size we treat a position as fully exited.
const DUST_FRACTION = 0.02;

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
  const wallet = await prisma.wallet.findUnique({
    where: { address: ev.owner },
  });
  if (!wallet || !wallet.active) return;

  const usdValue = ev.solAmount * solPrice;
  const executedPrice = ev.tokenAmount > 0 ? usdValue / ev.tokenAmount : 0;
  const label = wallet.label || shortAddr(wallet.address);

  const existing = await prisma.position.findUnique({
    where: {
      walletId_tokenAddress: {
        walletId: wallet.id,
        tokenAddress: ev.tokenAddress,
      },
    },
  });

  if (ev.direction === "BUY") {
    if (!existing || existing.status === "CLOSED" || existing.amount <= 0) {
      // Fresh entry (or re-entry after a full exit).
      await prisma.position.upsert({
        where: {
          walletId_tokenAddress: {
            walletId: wallet.id,
            tokenAddress: ev.tokenAddress,
          },
        },
        create: {
          walletId: wallet.id,
          tokenAddress: ev.tokenAddress,
          amount: ev.tokenAmount,
          costBasisUsd: usdValue,
          avgEntryPriceUsd: executedPrice,
          status: "OPEN",
          maxMultipleAlerted: 1,
          openedAt: new Date(),
        },
        update: {
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
        title: `🟢 ${label} ENTERED a position`,
        body:
          `Bought ${fmtUsdCompact(usdValue)} of ` +
          `*${ev.tokenAddress.slice(0, 6)}…*\n` +
          `Entry ≈ ${fmtUsd(executedPrice)} · ${ev.tokenAmount.toLocaleString()} tokens`,
        tokenAddress: ev.tokenAddress,
        walletAddress: wallet.address,
        data: { usdValue, executedPrice, signature: ev.signature },
        // One alert per (wallet, token, signature) — never repeats.
        dedupeKey: `enter:${wallet.id}:${ev.tokenAddress}:${ev.signature}`,
      });
      log.info(`${label} ENTER ${ev.tokenAddress} (${fmtUsdCompact(usdValue)})`);
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

  // ── SELL ───────────────────────────────────────────────────────────────────
  if (!existing || existing.status === "CLOSED" || existing.amount <= 0) {
    // We never saw them buy this — ignore (avoids phantom exits).
    return;
  }

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
      existing.avgEntryPriceUsd > 0
        ? executedPrice / existing.avgEntryPriceUsd
        : 0;
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
      title: `🔴 ${label} EXITED a position`,
      body:
        `Sold out of *${ev.tokenAddress.slice(0, 6)}…*\n` +
        `${pnlEmoji} Realized PnL: *${fmtUsd(totalRealized)}* (${fmtMultiple(exitMultiple)})`,
      tokenAddress: ev.tokenAddress,
      walletAddress: wallet.address,
      data: { realized: totalRealized, exitMultiple, signature: ev.signature },
      dedupeKey: `exit:${wallet.id}:${ev.tokenAddress}:${ev.signature}`,
    });
    log.info(`${label} EXIT ${ev.tokenAddress} PnL ${fmtUsd(totalRealized)}`);
  } else {
    // Partial trim — reduce position, accumulate realized PnL, no alert.
    await prisma.position.update({
      where: { id: existing.id },
      data: {
        amount: remaining,
        costBasisUsd: existing.costBasisUsd * (1 - fractionSold),
        realizedPnlUsd: existing.realizedPnlUsd + realized,
      },
    });
  }
}

/**
 * Price-watcher hook: for each OPEN position, compare current price to average
 * entry and fire a 2x/3x/5x… alert the first time each rung is crossed.
 * Tokens are deduped so we price each one only once per pass.
 */
export async function checkWalletMultiples(): Promise<void> {
  const positions = await prisma.position.findMany({
    where: { status: "OPEN", amount: { gt: 0 } },
    include: { wallet: true },
  });
  if (positions.length === 0) return;

  // Price each distinct token once.
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

    const label = pos.wallet.label || shortAddr(pos.wallet.address);
    const currentValue = pos.amount * price;
    await dispatchAlert({
      type: "WALLET_MULTIPLE",
      title: `🚀 ${label} is up ${rung}x`,
      body:
        `Position in *${pos.tokenAddress.slice(0, 6)}…* hit *${fmtMultiple(multiple)}*\n` +
        `Entry ${fmtUsd(pos.avgEntryPriceUsd)} → now ${fmtUsd(price)}\n` +
        `Unrealized value ≈ ${fmtUsdCompact(currentValue)}`,
      tokenAddress: pos.tokenAddress,
      walletAddress: pos.wallet.address,
      data: { multiple, rung, price, entry: pos.avgEntryPriceUsd },
      dedupeKey: `wmult:${pos.id}:${rung}`,
    });
    await prisma.position.update({
      where: { id: pos.id },
      data: { maxMultipleAlerted: rung },
    });
    log.info(`${label} ${rung}x on ${pos.tokenAddress}`);
  }
}

/**
 * Snapshot a newly-added wallet's existing holdings as OPEN positions, using
 * the current price as the entry baseline. This means we won't fire a false
 * EXIT when they sell a bag they held before tracking, and 2x is measured from
 * the moment you started tracking them.
 */
export async function seedWalletPositions(
  walletId: string,
  address: string,
): Promise<void> {
  const holdings = await getTokenHoldings(address);
  if (holdings.length === 0) return;

  for (const h of holdings) {
    const price = await getPriceUsd(h.mint);
    if (price == null || price <= 0) continue;
    const value = h.amount * price;
    if (value < 5) continue; // skip dust positions worth < $5

    await prisma.position.upsert({
      where: { walletId_tokenAddress: { walletId, tokenAddress: h.mint } },
      create: {
        walletId,
        tokenAddress: h.mint,
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
