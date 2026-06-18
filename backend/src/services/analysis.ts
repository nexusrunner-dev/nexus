import Anthropic from "@anthropic-ai/sdk";
import { config, features } from "../config.js";
import { createLogger } from "../logger.js";
import { getSnapshot } from "./prices.js";
import * as birdeye from "./birdeye.js";
import { fmtUsd, fmtUsdCompact, fmtPct } from "../lib/format.js";

// ────────────────────────────────────────────────────────────────────────────
//  Pump analysis — "why is this coin moving?"
//
//  Gathers on-chain signals (price action, volume, liquidity, holders, recent
//  candles, top traders) and asks Claude to explain the likely driver of the
//  move in plain language. Falls back to a rules-based summary if no Anthropic
//  key is configured.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("analysis");

export interface AnalysisResult {
  address: string;
  symbol?: string;
  name?: string;
  priceUsd: number | null;
  signals: Record<string, unknown>;
  summary: string;
  model: string | null;
}

export async function analyzeToken(address: string): Promise<AnalysisResult> {
  const snap = await getSnapshot(address);

  // Pull ~24h of 15-minute candles + top traders for richer context.
  const nowSec = Math.floor(now() / 1000);
  const dayAgo = nowSec - 24 * 3600;
  const [candles, topTraders] = await Promise.all([
    birdeye.getOhlcv(address, "15m", dayAgo, nowSec),
    birdeye.getTopTraders(address),
  ]);

  // Condense candles into a few descriptive stats (don't dump 96 rows to the LLM).
  const candleStats = summarizeCandles(candles);

  const signals = {
    price: snap.priceUsd,
    priceChange: snap.priceChange,
    liquidityUsd: snap.liquidityUsd,
    volume24hUsd: snap.volume24hUsd,
    marketCapUsd: snap.marketCapUsd,
    holders: snap.holders,
    txns24h: snap.txns24h,
    pairAgeHours: snap.pairCreatedAt
      ? Math.round((now() - snap.pairCreatedAt) / 3_600_000)
      : undefined,
    candleStats,
    topTraderCount: topTraders.length,
    topTraderVolumeUsd: topTraders.reduce((a, t) => a + (t.volumeUsd ?? 0), 0),
    dataSource: snap.source,
  };

  let summary: string;
  let model: string | null = null;

  if (features.anthropic) {
    try {
      summary = await llmSummary(snap, signals);
      model = config.ANTHROPIC_MODEL;
    } catch (err) {
      log.error("LLM analysis failed, using fallback", String(err));
      summary = ruleBasedSummary(snap, signals);
    }
  } else {
    summary = ruleBasedSummary(snap, signals);
  }

  return {
    address,
    symbol: snap.symbol,
    name: snap.name,
    priceUsd: snap.priceUsd,
    signals,
    summary,
    model,
  };
}

// ─── LLM path ────────────────────────────────────────────────────────────────

async function llmSummary(
  snap: Awaited<ReturnType<typeof getSnapshot>>,
  signals: Record<string, unknown>,
): Promise<string> {
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const prompt = [
    `You are a Solana memecoin analyst. Given on-chain signals for a token, explain in plain language the most likely reason(s) it is pumping or dumping right now.`,
    ``,
    `Token: ${snap.name ?? "unknown"} ($${snap.symbol ?? "?"})`,
    `Mint: ${snap.address}`,
    ``,
    `On-chain signals (JSON):`,
    "```json",
    JSON.stringify(signals, null, 2),
    "```",
    ``,
    `Write a concise analysis (4-7 sentences). Cover, where the data supports it:`,
    `- Whether this looks like organic demand, a coordinated pump, fresh-launch hype, or a sell-off.`,
    `- What the volume / liquidity / holder / transaction balance implies (e.g. buys >> sells).`,
    `- Notable risk flags (very new pair, thin liquidity, few holders, concentrated top-trader volume).`,
    `- A blunt one-line verdict at the end starting with "Verdict:".`,
    `Do not give financial advice or price targets. If data is missing, say so rather than guessing.`,
  ].join("\n");

  const res = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();

  return text || ruleBasedSummary(snap, signals);
}

// ─── Fallback path (no API key / LLM error) ──────────────────────────────────

function ruleBasedSummary(
  snap: Awaited<ReturnType<typeof getSnapshot>>,
  signals: Record<string, unknown>,
): string {
  const parts: string[] = [];
  const buys = snap.txns24h?.buys ?? 0;
  const sells = snap.txns24h?.sells ?? 0;
  const ageH = (signals.pairAgeHours as number | undefined) ?? undefined;

  parts.push(
    `$${snap.symbol ?? "token"} is at ${fmtUsd(snap.priceUsd)} ` +
      `(24h ${fmtPct(snap.priceChange.h24)}, 1h ${fmtPct(snap.priceChange.h1)}).`,
  );
  parts.push(
    `Liquidity ${fmtUsdCompact(snap.liquidityUsd)}, 24h volume ${fmtUsdCompact(snap.volume24hUsd)}` +
      (snap.holders ? `, ${snap.holders.toLocaleString()} holders.` : "."),
  );
  if (buys || sells) {
    const ratio = sells > 0 ? (buys / sells).toFixed(2) : "∞";
    parts.push(`24h transactions: ${buys} buys / ${sells} sells (buy:sell ${ratio}).`);
  }
  if (ageH != null && ageH < 24) {
    parts.push(`⚠️ Very new pair (~${ageH}h old) — high risk, likely launch-driven.`);
  }
  if ((snap.liquidityUsd ?? 0) < 20000) {
    parts.push(`⚠️ Thin liquidity — price is easily moved and hard to exit.`);
  }
  const upside = (snap.priceChange.h1 ?? 0) > 10 || (snap.priceChange.h24 ?? 0) > 30;
  parts.push(
    `Verdict: ${
      upside
        ? "momentum is up; check buy/sell balance and liquidity before chasing."
        : "no strong directional signal from the available data."
    }`,
  );
  return parts.join(" ");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function summarizeCandles(candles: birdeye.Candle[]) {
  if (candles.length === 0) return null;
  const closes = candles.map((c) => c.close);
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const first = closes[0];
  const last = closes[closes.length - 1];
  const totalVol = candles.reduce((a, c) => a + (c.volumeUsd ?? 0), 0);
  // Largest single-candle gain (a sharp green candle often marks the catalyst).
  let biggestPump = 0;
  for (const c of candles) {
    if (c.open > 0) biggestPump = Math.max(biggestPump, (c.close - c.open) / c.open);
  }
  return {
    candles: candles.length,
    rangeChangePct: first > 0 ? ((last - first) / first) * 100 : null,
    highLowSpreadPct: low > 0 ? ((high - low) / low) * 100 : null,
    biggestSingleCandlePct: biggestPump * 100,
    totalVolumeUsd: totalVol,
  };
}

// Date.now() wrapper kept in one place (workflow-safe code style).
function now(): number {
  return Date.now();
}
