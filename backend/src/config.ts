import "dotenv/config";
import { z } from "zod";

// Validate & normalise all environment configuration in one place.
// Anything optional has a sane default so the app still boots for local dev,
// but features whose keys are missing will log a clear warning at startup.

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  HELIUS_API_KEY: z.string().optional(),
  BIRDEYE_API_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  WEBHOOK_AUTH_TOKEN: z.string().default("change-me"),

  PRICE_POLL_SECONDS: z.coerce.number().default(45),
  WATCH_DEFAULT_MOVE_PCT: z.coerce.number().default(15),
  WATCH_DEFAULT_WINDOW_MIN: z.coerce.number().default(5),
  ALERT_COOLDOWN_MIN: z.coerce.number().default(10),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const corsOrigins = config.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Feature availability flags — used to skip workers whose keys aren't set yet.
export const features = {
  helius: Boolean(config.HELIUS_API_KEY),
  birdeye: Boolean(config.BIRDEYE_API_KEY),
  anthropic: Boolean(config.ANTHROPIC_API_KEY),
  telegram: Boolean(config.TELEGRAM_BOT_TOKEN),
};
