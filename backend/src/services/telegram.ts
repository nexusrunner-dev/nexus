import { Bot } from "grammy";
import { config, features } from "../config.js";
import { getSetting, setSetting } from "../db.js";
import { createLogger } from "../logger.js";

// ────────────────────────────────────────────────────────────────────────────
//  Telegram — the notification channel.
//
//  • The user creates a bot via @BotFather and pastes the token into env.
//  • They DM the bot and send /start; the bot records & echoes their chat id.
//  • dispatchAlert() / send() push messages to that chat id.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("telegram");
const CHAT_ID_KEY = "telegram_chat_id";

let bot: Bot | null = null;

export function getBot(): Bot | null {
  if (!features.telegram) return null;
  if (!bot) bot = new Bot(config.TELEGRAM_BOT_TOKEN!);
  return bot;
}

/** Resolve the destination chat id: DB setting first, then env fallback. */
export async function getChatId(): Promise<string | null> {
  const fromDb = await getSetting(CHAT_ID_KEY);
  return fromDb ?? config.TELEGRAM_CHAT_ID ?? null;
}

export async function setChatId(id: string): Promise<void> {
  await setSetting(CHAT_ID_KEY, id);
}

/** Send a Markdown message to the configured chat. Returns success boolean. */
export async function send(text: string): Promise<boolean> {
  const b = getBot();
  if (!b) {
    log.warn("telegram not configured — message dropped");
    return false;
  }
  const chatId = await getChatId();
  if (!chatId) {
    log.warn("no telegram chat id set — message dropped");
    return false;
  }
  try {
    await b.api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    // Markdown can fail if a token symbol has an unbalanced * or _.
    // Retry as plain text so the alert is never silently dropped.
    log.warn("markdown send failed, retrying as plain text", String(err));
    try {
      await b.api.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (err2) {
      log.error("sendMessage failed", String(err2));
      return false;
    }
  }
}

/**
 * Register bot commands and start long-polling. Called once at boot.
 * /start  — capture the chat id and confirm wiring works.
 * /id     — echo the current chat id.
 * /ping   — connectivity check.
 */
export async function startBot(): Promise<void> {
  const b = getBot();
  if (!b) {
    log.warn("TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }

  b.command("start", async (ctx) => {
    const id = String(ctx.chat.id);
    await setChatId(id);
    await ctx.reply(
      `✅ *Nexus connected!*\nYour chat id is \`${id}\`.\nYou'll now receive wallet + watchlist alerts here.`,
      { parse_mode: "Markdown" },
    );
    log.info(`captured chat id ${id}`);
  });

  b.command("id", async (ctx) => {
    await ctx.reply(`Your chat id: \`${ctx.chat.id}\``, {
      parse_mode: "Markdown",
    });
  });

  b.command("ping", async (ctx) => {
    await ctx.reply("pong 🏓");
  });

  // Long-poll in the background (don't await — it runs for the process lifetime).
  b.start({
    onStart: () => log.info("telegram bot started (long polling)"),
    drop_pending_updates: true,
  }).catch((err) => log.error("bot crashed", String(err)));
}
