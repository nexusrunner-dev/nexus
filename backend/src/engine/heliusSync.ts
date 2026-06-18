import { prisma, getSetting, setSetting } from "../db.js";
import { syncWalletWebhook } from "../services/helius.js";
import { createLogger } from "../logger.js";

// Keeps the single Helius webhook's address list in sync with our active
// wallets, persisting the webhook id in the Setting table. Call after any
// wallet add/remove and once at startup.

const log = createLogger("helius-sync");
const WEBHOOK_ID_KEY = "helius_webhook_id";

let syncing = false;

export async function syncWebhook(): Promise<void> {
  // Avoid overlapping syncs (e.g. two rapid wallet adds).
  if (syncing) return;
  syncing = true;
  try {
    const wallets = await prisma.wallet.findMany({
      where: { active: true },
      select: { address: true },
    });
    const addresses = wallets.map((w) => w.address);
    const existingId = await getSetting(WEBHOOK_ID_KEY);
    const newId = await syncWalletWebhook(addresses, existingId);
    if (newId && newId !== existingId) {
      await setSetting(WEBHOOK_ID_KEY, newId);
    }
  } catch (err) {
    log.error("syncWebhook failed", String(err));
  } finally {
    syncing = false;
  }
}
