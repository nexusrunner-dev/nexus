# ◆ Nexus — Solana Wallet & Memecoin Tracker

Track Solana wallets and memecoins, get **real-time Telegram alerts**, and ask
**"why is this coin pumping?"** — all from one dashboard.

What it does:

| Feature | What you get |
|---|---|
| 👛 **Wallet tracking** | Alert when a tracked wallet **enters** a coin, **exits** a position, or one of its holdings hits **2x / 3x / 5x…** |
| ⭐ **Memecoin watchlist** | Add coins by address; alert on a **sharp move** (e.g. ±15% in 5 min) and on each **2x** from when you added it |
| 🔍 **Pump analysis** | Paste a token address → plain-language explanation of the likely reason for the move, from on-chain signals |
| 🔔 **Telegram alerts** | Every detection is pushed to your phone in real time |

---

## How it's built

```
Helius (wallet webhooks) ─┐
Birdeye / DexScreener ─────┤→  NEXUS BACKEND (always-on)  ──→  Telegram alerts
Anthropic (analysis) ─────┘         │  REST API
                                     ▼
                          NEXUS DASHBOARD (React)  ←─ you
                                     │
                              PostgreSQL (state)
```

- **`backend/`** — Node + TypeScript (Fastify + Prisma). Runs 24/7: receives Helius webhooks, polls prices, detects events, sends Telegram alerts, serves the API.
- **`frontend/`** — React + Vite dashboard to manage wallets/watchlist and run analysis.

> ⚠️ The backend must run **24/7** to catch movements while you're away — that's why we deploy it to the cloud. The dashboard is just a control panel.

---

## What you need (free to start, ~$50/mo for serious use)

| Service | Why | Where | Cost |
|---|---|---|---|
| **Node.js 20** | Build/run locally | [nodejs.org](https://nodejs.org) → LTS | free |
| **Helius** | Solana RPC + real-time wallet webhooks | [dashboard.helius.dev](https://dashboard.helius.dev) | free tier, paid ~$50/mo |
| **Birdeye** | Token prices / OHLCV / analytics | [birdeye.so](https://birdeye.so) → API | paid Starter recommended |
| **Anthropic** | Pump analysis (Claude) | [console.anthropic.com](https://console.anthropic.com) | pay-per-use |
| **Telegram bot** | Notifications | [@BotFather](https://t.me/BotFather) in Telegram | free |
| **PostgreSQL** | Stores wallets/watchlist/alerts | Railway, [Neon](https://neon.tech), or [Supabase](https://supabase.com) | free tier |
| **Railway** (recommended host) | Runs backend + frontend 24/7 | [railway.app](https://railway.app) | ~$5/mo |

> Nexus **degrades gracefully**: missing keys just disable that feature (e.g. no
> Anthropic key → analysis falls back to a rules-based summary). You can wire
> things up one at a time.

---

## Getting your keys (step by step)

**Telegram bot**
1. In Telegram, open [@BotFather](https://t.me/BotFather) → `/newbot` → follow prompts.
2. Copy the **token** it gives you → that's `TELEGRAM_BOT_TOKEN`.
3. After the app is running, message **your** new bot and send `/start` — it replies with your chat id and starts sending you alerts. (You can also paste the chat id in the dashboard's Settings tab.)

**Helius** — sign up at [dashboard.helius.dev](https://dashboard.helius.dev), create an API key → `HELIUS_API_KEY`. The free tier works to start; the Developer/Business plans give higher webhook + RPC limits for tracking many wallets.

**Birdeye** — sign up at [birdeye.so](https://birdeye.so), open the API/Data section, create a key → `BIRDEYE_API_KEY`.

**Anthropic** — sign up at [console.anthropic.com](https://console.anthropic.com), add a little credit, create an API key → `ANTHROPIC_API_KEY`.

**Postgres** — easiest is to let Railway create one (below). For local testing you can use a free [Neon](https://neon.tech) database and copy its connection string → `DATABASE_URL`.

---

## Option A — Deploy to the cloud (recommended, runs 24/7)

We'll use **Railway**. It builds from the Dockerfiles in this repo.

1. **Push this folder to GitHub.** Create an empty repo on GitHub, then from the
   `nexus/` folder:
   ```bash
   git init
   git add .
   git commit -m "Nexus initial"
   git branch -M main
   git remote add origin https://github.com/<you>/nexus.git
   git push -u origin main
   ```

2. **Create a Railway project** → *New Project* → *Deploy from GitHub repo* → pick your repo.

3. **Add a PostgreSQL database**: in the project, *New* → *Database* → *PostgreSQL*. Railway exposes a `DATABASE_URL` variable.

4. **Backend service**: *New* → *GitHub Repo* (same repo) →
   - Settings → **Root Directory** = `backend`
   - Variables (Settings → Variables):
     - `DATABASE_URL` → reference the Postgres one (`${{Postgres.DATABASE_URL}}`)
     - `HELIUS_API_KEY`, `BIRDEYE_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`
     - `WEBHOOK_AUTH_TOKEN` → any long random string
     - Leave `PUBLIC_BASE_URL` and `CORS_ORIGINS` empty for now — set them in step 6.
   - Deploy. Once it's up, open Settings → **Networking** → *Generate Domain*. Copy it, e.g. `https://nexus-api.up.railway.app`.

5. **Frontend service**: *New* → *GitHub Repo* (same repo) →
   - Settings → **Root Directory** = `frontend`
   - Variables → `VITE_API_URL` = your backend domain from step 4.
   - Deploy, then *Generate Domain* → e.g. `https://nexus.up.railway.app`.

6. **Wire them together** (backend Variables):
   - `PUBLIC_BASE_URL` = backend domain (step 4) — needed so Helius can call back.
   - `CORS_ORIGINS` = frontend domain (step 5).
   - Redeploy the backend.

7. **Open the dashboard** (frontend domain), go to **Settings**, message your Telegram bot `/start`, hit **Send test** — you should get a Telegram message. Add a wallet and a coin. Done. 🎉

Database tables are created automatically on the backend's first boot
(`prisma db push` runs in the Dockerfile's start command — see *Database* below).

---

## Option B — Run locally first

You need **Node 20+** and a Postgres `DATABASE_URL` (a free Neon DB is easiest).

**Backend**
```bash
cd backend
cp .env.example .env          # then edit .env with your keys + DATABASE_URL
npm install
npm run db:push               # create the database tables
npm run dev                   # starts on http://localhost:8080
```

**Frontend** (in a second terminal)
```bash
cd frontend
npm install
npm run dev                   # opens http://localhost:5173 (proxies /api to :8080)
```

Open <http://localhost:5173>.

> **Wallet alerts locally:** Helius needs a **public** URL to send webhooks to.
> When running on your own machine, expose the backend with
> [ngrok](https://ngrok.com): `ngrok http 8080`, then set `PUBLIC_BASE_URL` in
> `backend/.env` to the `https://…ngrok…` URL and restart. (Watchlist price
> alerts and analysis work without this — only wallet enter/exit/2x needs it.)

---

## Using it

- **Wallets tab** — paste a Solana wallet address (optionally a label) → *Track*. When it's added we snapshot its current holdings as a baseline, so "2x" is measured from now and you won't get a false "exit" on a bag it held before.
- **Watchlist tab** — paste a token **mint** address → *Add*. Optionally set a custom move %.
- **Alerts tab** — live feed of everything detected (also sent to Telegram).
- **Analysis tab** — paste a token address → *Analyze* → plain-language reason for the move + key on-chain signals.
- **Settings tab** — connect Telegram, send a test alert, see which integrations are live.

---

## Configuration reference

All backend config lives in `backend/.env` (see `backend/.env.example`):

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PUBLIC_BASE_URL` | Public URL of the backend (for Helius webhook registration) |
| `CORS_ORIGINS` | Comma-separated dashboard origins allowed to call the API |
| `HELIUS_API_KEY` / `BIRDEYE_API_KEY` / `ANTHROPIC_API_KEY` | Provider keys |
| `ANTHROPIC_MODEL` | Analysis model (default `claude-opus-4-8`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Notifications |
| `WEBHOOK_AUTH_TOKEN` | Shared secret protecting the Helius webhook endpoint |
| `PRICE_POLL_SECONDS` | How often to poll prices (default 45) |
| `WATCH_DEFAULT_MOVE_PCT` / `WATCH_DEFAULT_WINDOW_MIN` | Default watchlist move trigger |
| `ALERT_COOLDOWN_MIN` | Min minutes between repeat alerts for the same condition |

---

## Database

Schema is defined in `backend/prisma/schema.prisma`. Commands (run in `backend/`):

- `npm run db:push` — create/update tables to match the schema (dev).
- `npm run db:migrate` — apply migrations (prod; the Docker image runs this on boot).
- `npm run db:studio` — open Prisma Studio to inspect data.

---

## How detection works (so you can trust the alerts)

- **Wallet enter/exit** — Helius pushes the wallet's swaps in real time; we parse buy/sell legs, maintain a USD cost basis per position, and fire `ENTER` on a fresh buy and `EXIT` (with realized PnL) on a full sell-out.
- **Wallet 2x/3x…** — every poll we compare each open position's current price to its average entry and alert the first time it crosses each rung.
- **Watchlist move** — we sample each coin's price every `PRICE_POLL_SECONDS` and alert when it moves ≥ the threshold within the lookback window, or crosses a new Nx vs. the price when you added it.
- **Dedupe** — every alert has a key (with a cooldown bucket) so you don't get spammed for the same thing.

---

## Cost expectations

- **Railway**: ~$5/mo for the two services + Postgres on the hobby plan.
- **Helius**: free tier to start; ~$50/mo unlocks serious webhook/RPC volume.
- **Birdeye**: from ~$0 (limited) up to paid tiers for higher rate limits.
- **Anthropic**: pennies per analysis (only when you click Analyze).

---

## Troubleshooting

- **"backend offline" badge** → backend isn't reachable. Check the service is up and `VITE_API_URL` points at it.
- **No Telegram alerts** → Settings → *Send test*. If it fails, recheck `TELEGRAM_BOT_TOKEN` and that you sent `/start` to the bot.
- **No wallet alerts** → confirm `HELIUS_API_KEY` and `PUBLIC_BASE_URL` are set and the backend is publicly reachable; check backend logs for "created/updated webhook".
- **No prices / analysis thin** → add `BIRDEYE_API_KEY` (DexScreener-only fallback is more limited).
- **A provider endpoint changed** → each provider lives in its own file under `backend/src/services/` with the URL/headers clearly marked; adjust there.

---

Not financial advice. This is a monitoring/analysis tool — always do your own research.
