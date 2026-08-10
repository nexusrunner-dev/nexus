import { prisma, getSetting, setSetting } from "../db.js";
import { syncWalletWebhook, listWebhooks } from "../services/helius.js";
import { config, features } from "../config.js";
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

/**
 * Watchdog: compare what Helius is ACTUALLY watching against our active
 * wallets and repair on drift. The registration has been observed empty in the
 * wild (e.g. after long downtime Helius drops the webhook and a recreate can
 * land wrong) — without this, wallet buy/sell alerts silently stop forever.
 */
export async function verifyWebhook(): Promise<void> {
  if (!features.helius || !config.PUBLIC_BASE_URL) return;
  try {
    const wallets = await prisma.wallet.findMany({
      where: { active: true },
      select: { address: true },
    });
    if (wallets.length === 0) return;
    const want = new Set(wallets.map((w) => w.address));

    const url = `${config.PUBLIC_BASE_URL}/webhooks/helius`;
    const hooks = await listWebhooks();
    const hook = hooks.find((h) => h.webhookURL === url);

    const have = new Set(hook?.accountAddresses ?? []);
    const inSync =
      hook != null &&
      have.size === want.size &&
      [...want].every((a) => have.has(a));
    if (inSync) return;

    log.warn(
      `webhook drift detected — helius watching ${have.size}/${want.size} wallets, repairing`,
    );
    // Trust the webhook we found by URL over any stored id.
    const storedId = await getSetting(WEBHOOK_ID_KEY);
    const newId = await syncWalletWebhook([...want], hook?.webhookID ?? storedId);
    if (newId && newId !== storedId) await setSetting(WEBHOOK_ID_KEY, newId);
  } catch (err) {
    log.error("verifyWebhook failed", String(err));
  }
}
