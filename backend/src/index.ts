import { buildServer } from "./server.js";
import { config, features } from "./config.js";
import { createLogger } from "./logger.js";
import { prisma } from "./db.js";
import { startBot } from "./services/telegram.js";
import { syncWebhook } from "./engine/heliusSync.js";
import { checkWatchlist } from "./engine/watchlist.js";
import { checkWalletMultiples, reconcileWalletPositions } from "./engine/wallets.js";

const log = createLogger("main");

async function main() {
  // 1) HTTP API + Helius webhook receiver.
  const app = buildServer();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  log.info(`API listening on :${config.PORT}`);

  // 2) Telegram bot (captures chat id via /start, sends alerts).
  await startBot();

  // 3) Register / refresh the Helius wallet webhook for all active wallets.
  await syncWebhook();

  // 4) Price-polling loop: watchlist moves + wallet 2x/3x/… detection.
  let polling = false;
  const tick = async () => {
    if (polling) return; // skip if the previous pass is still running
    polling = true;
    try {
      await checkWatchlist();
      await checkWalletMultiples();
    } catch (err) {
      log.error("poll tick failed", String(err));
    } finally {
      polling = false;
    }
  };
  setInterval(tick, config.PRICE_POLL_SECONDS * 1000);
  setTimeout(tick, 5_000); // first pass shortly after boot
  log.info(`price watcher running every ${config.PRICE_POLL_SECONDS}s`);

  // 5) Holdings reconciliation: close positions whose sells we never saw
  //    (downtime, missed webhooks, transfers). Runs at boot and every 10 min.
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await reconcileWalletPositions();
    } catch (err) {
      log.error("reconcile failed", String(err));
    } finally {
      reconciling = false;
    }
  };
  setInterval(reconcile, 10 * 60_000);
  setTimeout(reconcile, 15_000); // clean up stale positions shortly after boot
  log.info("holdings reconciler running every 10m");

  // Startup warnings for any missing integrations.
  if (!features.helius)
    log.warn("HELIUS_API_KEY missing — wallet tracking disabled");
  if (!features.birdeye)
    log.warn("BIRDEYE_API_KEY missing — prices fall back to DexScreener only");
  if (!features.telegram)
    log.warn("TELEGRAM_BOT_TOKEN missing — notifications disabled");
  if (!features.anthropic)
    log.warn("ANTHROPIC_API_KEY missing — analysis uses rule-based fallback");
}

async function shutdown() {
  log.info("shutting down…");
  try {
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  log.error("fatal startup error", String(err));
  process.exit(1);
});
