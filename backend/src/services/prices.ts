import * as birdeye from "./birdeye.js";
import * as dexscreener from "./dexscreener.js";
import { createLogger } from "../logger.js";

// Unified token snapshot, merging Birdeye (primary) and DexScreener (fallback +
// enrichment). Every consumer in the app uses this so we have ONE price source
// of truth and graceful degradation when one provider is down.

const log = createLogger("prices");

export interface TokenSnapshot {
  address: string;
  symbol?: string;
  name?: string;
  priceUsd: number | null;
  liquidityUsd?: number;
  volume24hUsd?: number;
  marketCapUsd?: number;
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  holders?: number;
  txns24h?: { buys?: number; sells?: number };
  pairCreatedAt?: number;
  imageUrl?: string;
  source: "birdeye" | "dexscreener" | "merged" | "none";
}

export async function getSnapshot(address: string): Promise<TokenSnapshot> {
  const [overview, pair] = await Promise.all([
    birdeye.getTokenOverview(address),
    dexscreener.getBestPair(address),
  ]);

  if (!overview && !pair) {
    log.warn(`no price data from any provider for ${address}`);
    return {
      address,
      priceUsd: null,
      priceChange: {},
      source: "none",
    };
  }

  const source: TokenSnapshot["source"] =
    overview && pair ? "merged" : overview ? "birdeye" : "dexscreener";

  return {
    address,
    symbol: overview?.symbol ?? pair?.symbol,
    name: overview?.name ?? pair?.name,
    priceUsd: overview?.priceUsd ?? pair?.priceUsd ?? null,
    liquidityUsd: overview?.liquidityUsd ?? pair?.liquidityUsd,
    volume24hUsd: overview?.volume24hUsd ?? pair?.volume24hUsd,
    marketCapUsd: overview?.marketCapUsd ?? pair?.marketCapUsd,
    priceChange: {
      m5: pair?.priceChange.m5,
      h1: pair?.priceChange.h1,
      h6: pair?.priceChange.h6,
      h24: pair?.priceChange.h24 ?? overview?.priceChange24hPct,
    },
    holders: overview?.holders,
    txns24h: pair?.txns24h,
    pairCreatedAt: pair?.pairCreatedAt,
    imageUrl: pair?.imageUrl,
    source,
  };
}

/** Lightweight price-only lookup (Birdeye → DexScreener). */
export async function getPriceUsd(address: string): Promise<number | null> {
  const fromBirdeye = await birdeye.getPrice(address);
  if (fromBirdeye != null) return fromBirdeye;
  const pair = await dexscreener.getBestPair(address);
  return pair?.priceUsd ?? null;
}

// SOL price is needed to value every swap. Cache it for 60s to avoid hammering
// the provider once per trade.
const SOL_MINT = "So11111111111111111111111111111111111111112";
let solPriceCache: { value: number; at: number } | null = null;

export async function getSolPriceUsd(): Promise<number | null> {
  const now = Date.now();
  if (solPriceCache && now - solPriceCache.at < 60_000) {
    return solPriceCache.value;
  }
  const price = await getPriceUsd(SOL_MINT);
  if (price != null) solPriceCache = { value: price, at: now };
  return price;
}

// Token symbol/name, cached once resolved (used to label wallet alerts).
const metaCache = new Map<string, { symbol?: string; name?: string }>();
export async function getTokenMeta(
  address: string,
): Promise<{ symbol?: string; name?: string }> {
  const cached = metaCache.get(address);
  if (cached) return cached;
  const snap = await getSnapshot(address);
  const meta = { symbol: snap.symbol, name: snap.name };
  if (snap.symbol) metaCache.set(address, meta); // only cache once we actually have it
  return meta;
}
