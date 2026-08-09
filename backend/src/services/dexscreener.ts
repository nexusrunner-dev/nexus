import { fetchJson } from "../lib/http.js";
import { createLogger } from "../logger.js";

// ────────────────────────────────────────────────────────────────────────────
//  DexScreener — FREE token/pair data. Used as a fallback price source and to
//  enrich pump analysis (txn counts, price-change buckets, pair age).
//
//  Endpoint : https://api.dexscreener.com/latest/dex/tokens/{address}
//  Auth     : none. Rate limited (~300 req/min) — fine for fallback use.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("dexscreener");
const BASE = "https://api.dexscreener.com";

export interface DexPair {
  priceUsd: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns24h?: { buys?: number; sells?: number };
  symbol?: string;
  name?: string;
  marketCapUsd?: number;
  fdvUsd?: number;
  pairCreatedAt?: number;
  dexId?: string;
  url?: string;
  imageUrl?: string;
}

/** Returns the most-liquid Solana pair for a token, or null. */
export async function getBestPair(address: string): Promise<DexPair | null> {
  try {
    const res = await fetchJson<{ pairs?: any[] }>(
      `${BASE}/latest/dex/tokens/${address}`,
    );
    const pairs = (res?.pairs ?? []).filter(
      (p) => p.chainId === "solana" || !p.chainId,
    );
    if (pairs.length === 0) return null;

    // Pick the pair with the deepest liquidity (most representative price).
    pairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const p = pairs[0];

    return {
      priceUsd: Number(p.priceUsd),
      liquidityUsd: p.liquidity?.usd,
      volume24hUsd: p.volume?.h24,
      priceChange: {
        m5: p.priceChange?.m5,
        h1: p.priceChange?.h1,
        h6: p.priceChange?.h6,
        h24: p.priceChange?.h24,
      },
      txns24h: { buys: p.txns?.h24?.buys, sells: p.txns?.h24?.sells },
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
      marketCapUsd: p.marketCap,
      fdvUsd: p.fdv,
      pairCreatedAt: p.pairCreatedAt,
      dexId: p.dexId,
      url: p.url,
      imageUrl: p.info?.imageUrl,
    };
  } catch (err) {
    log.warn(`getBestPair failed for ${address}`, String(err));
    return null;
  }
}
