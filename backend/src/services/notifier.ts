import type { AlertType, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import * as telegram from "./telegram.js";

// ────────────────────────────────────────────────────────────────────────────
//  Notifier — the single chokepoint every alert flows through.
//  Responsibilities: dedupe / cooldown, persist to the Alert feed, and deliver
//  to Telegram. Keeping this central means the wallet engine and the watchlist
//  watcher never talk to Telegram directly.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("notifier");

export interface AlertInput {
  type: AlertType;
  title: string;
  body: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  walletAddress?: string;
  data?: Prisma.InputJsonValue;
  // Base dedupe key. Identical keys are only ever alerted once.
  dedupeKey: string;
  // If set, the key is bucketed by this many minutes (a soft cooldown):
  // the same logical alert can re-fire only after the bucket rolls over.
  cooldownMin?: number;
}

function bucketedKey(key: string, cooldownMin?: number): string {
  if (!cooldownMin) return key;
  const bucketMs = cooldownMin * 60_000;
  const bucket = Math.floor(Date.now() / bucketMs);
  return `${key}:${bucket}`;
}

/**
 * Persist + deliver an alert, unless an identical one already exists (dedupe).
 * Returns true if a new alert was created and dispatched.
 */
export async function dispatchAlert(input: AlertInput): Promise<boolean> {
  const dedupeKey = bucketedKey(input.dedupeKey, input.cooldownMin);

  // Atomic dedupe via the unique constraint on Alert.dedupeKey.
  let created;
  try {
    created = await prisma.alert.create({
      data: {
        type: input.type,
        title: input.title,
        body: input.body,
        tokenAddress: input.tokenAddress,
        tokenSymbol: input.tokenSymbol,
        walletAddress: input.walletAddress,
        data: input.data,
        dedupeKey,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Duplicate within the cooldown window — silently skip.
      return false;
    }
    throw err;
  }

  const message = formatMessage(input);
  const delivered = await telegram.send(message);
  if (delivered) {
    await prisma.alert.update({
      where: { id: created.id },
      data: { delivered: true },
    });
  } else {
    log.warn(`alert ${created.id} stored but not delivered (telegram down?)`);
  }
  return true;
}

function formatMessage(input: AlertInput): string {
  // Telegram Markdown. Keep it scannable on a phone.
  const lines = [`*${input.title}*`, input.body];
  if (input.tokenAddress) {
    lines.push("");
    lines.push(`\`${input.tokenAddress}\``);
    lines.push(
      `[DexScreener](https://dexscreener.com/solana/${input.tokenAddress})  ·  [Birdeye](https://birdeye.so/token/${input.tokenAddress}?chain=solana)`,
    );
  }
  return lines.join("\n");
}

export const COOLDOWN_MIN = config.ALERT_COOLDOWN_MIN;
