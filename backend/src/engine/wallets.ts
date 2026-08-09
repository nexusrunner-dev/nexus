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
      // Buying MORE of a coin already held — update cost basis AND alert.
      const meta = existing.tokenSymbol
        ? { symbol: existing.tokenSymbol }
        : await getTokenMeta(ev.tokenAddress);
      const tok = tokenLabel(meta.symbol, ev.tokenAddress);
      const newAmount = existing.amount + ev.tokenAmount;
      const newCost = existing.costBasisUsd + usdValue;
      const newAvg = newAmount > 0 ? newCost / newAmount : 0;
      await prisma.position.update({
        where: { id: existing.id },
        data: {
          amount: newAmount,
          costBasisUsd: newCost,
          avgEntryPriceUsd: newAvg,
          tokenSymbol: meta.symbol ?? existing.tokenSymbol,
        },
      });

      await dispatchAlert({
        type: "WALLET_ADD",
        title: `🔵 ${who(wallet)} ADDED to ${tok}`,
        body:
          `Bought *${fmtUsdCompact(usdValue)}* (${sol(ev.solAmount)}) more of ${tok}\n` +
          `New avg entry ≈ ${fmtUsd(newAvg)} · position now ≈ ${fmtUsdCompact(newCost)}`,
        tokenAddress: ev.tokenAddress,
        tokenSymbol: meta.symbol ?? undefined,
        walletAddress: wallet.address,
        data: { usdValue, solAmount: ev.solAmount, newAvg, newCost, signature: ev.signature },
        dedupeKey: `add:${wallet.id}:${ev.tokenAddress}:${ev.signature}`,
      });
      log.info(`${who(wallet)} ADD ${tok} (${fmtUsdCompact(usdValue)})`);
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
  if (!holdings || holdings.length === 0) return;

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

/**
 * Reconcile our OPEN positions against what each wallet ACTUALLY holds
 * on-chain. Sells can happen while we're not watching (downtime, missed
 * webhooks, transfers to another wallet) — without this, dead positions stay
 * "open" forever and keep firing bogus 2x/3x alerts.
 *
 * A few closes → one EXIT alert each; a big batch (first run after downtime)
 * → a single summary alert per wallet so Telegram isn't flooded.
 */
export async function reconcileWalletPositions(): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: { active: true },
    include: { positions: { where: { status: "OPEN", amount: { gt: 0 } } } },
  });

  for (const wallet of wallets) {
    if (wallet.positions.length === 0) continue;

    const holdings = await getTokenHoldings(wallet.address);
    if (holdings === null) {
      log.warn(`skipping reconcile for ${shortAddr(wallet.address)} — holdings lookup failed`);
      continue;
    }
    const held = new Map(holdings.map((h) => [h.mint, h.amount]));

    const closed: { symbol: string | null; tokenAddress: string }[] = [];
    for (const pos of wallet.positions) {
      const onChain = held.get(pos.tokenAddress) ?? 0;

      // Fully out (or only dust left) → close the position.
      if (onChain <= pos.amount * DUST_FRACTION) {
        await prisma.position.update({
          where: { id: pos.id },
          data: { amount: 0, costBasisUsd: 0, status: "CLOSED", closedAt: new Date() },
        });
        closed.push({ symbol: pos.tokenSymbol, tokenAddress: pos.tokenAddress });
        continue;
      }

      // Missed a partial sell → quietly sync our amount down to reality.
      if (onChain < pos.amount * 0.98) {
        const fractionLeft = onChain / pos.amount;
        await prisma.position.update({
          where: { id: pos.id },
          data: { amount: onChain, costBasisUsd: pos.costBasisUsd * fractionLeft },
        });
      }
    }

    if (closed.length === 0) continue;

    if (closed.length <= 3) {
      for (const c of closed) {
        const tok = tokenLabel(c.symbol, c.tokenAddress);
        await dispatchAlert({
          type: "WALLET_EXIT",
          title: `🔴 ${who(wallet)} EXITED ${tok}`,
          body: `No longer holds ${tok} — position closed.\n(Detected from on-chain holdings; the sell itself wasn't observed.)`,
          tokenAddress: c.tokenAddress,
          tokenSymbol: c.symbol ?? undefined,
          walletAddress: wallet.address,
          data: { via: "reconcile" },
          dedupeKey: `exit-sync:${wallet.id}:${c.tokenAddress}:${Date.now()}`,
        });
      }
    } else {
      const names = closed.slice(0, 6).map((c) => tokenLabel(c.symbol, c.tokenAddress));
      const extra = closed.length - names.length;
      await dispatchAlert({
        type: "WALLET_EXIT",
        title: `🧹 ${who(wallet)}: ${closed.length} positions closed`,
        body:
          `No longer held on-chain: ${names.join(", ")}` +
          (extra > 0 ? ` +${extra} more` : "") +
          `\nDashboard counts are now synced to reality.`,
        walletAddress: wallet.address,
        data: { via: "reconcile", count: closed.length },
        dedupeKey: `exit-sync-batch:${wallet.id}:${Date.now()}`,
      });
    }
    log.info(`${who(wallet)}: reconciled, closed ${closed.length} stale positions`);
  }
}
