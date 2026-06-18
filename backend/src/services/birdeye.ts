import { config, features } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { createLogger } from "../logger.js";

// ────────────────────────────────────────────────────────────────────────────
//  Birdeye — Solana token prices, overview metrics, OHLCV, top traders.
//
//  Base URL : https://public-api.birdeye.so
//  Auth     : header  X-API-KEY: <key>
//  Chain    : header  x-chain: solana
//
//  NOTE: Birdeye occasionally re-versions its paths (e.g. /defi/* vs /defi/v3/*).
//  If a call starts 404-ing, update the path constants below — nothing else in
//  the app needs to change.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("birdeye");
const BASE = "https://public-api.birdeye.so";

function headers() {
  return {
    "X-API-KEY": config.BIRDEYE_API_KEY ?? "",
    "x-chain": "solana",
  };
}

export interface TokenOverview {
  address: string;
  symbol?: string;
  name?: string;
  priceUsd: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  marketCapUsd?: number;
  priceChange24hPct?: number;
  holders?: number;
  decimals?: number;
}

/** Current USD price for a token, or null on failure. */
export async function getPrice(address: string): Promise<number | null> {
  if (!features.birdeye) return null;
  try {
    const res = await fetchJson<{ data?: { value?: number } }>(
      `${BASE}/defi/price?address=${address}`,
      { headers: headers() },
    );
    const v = res?.data?.value;
    return typeof v === "number" ? v : null;
  } catch (err) {
    log.warn(`getPrice failed for ${address}`, String(err));
    return null;
  }
}

/** Rich token snapshot used for both watchlist alerts and pump analysis. */
export async function getTokenOverview(
  address: string,
): Promise<TokenOverview | null> {
  if (!features.birdeye) return null;
  try {
    const res = await fetchJson<{ data?: Record<string, any> }>(
      `${BASE}/defi/token_overview?address=${address}`,
      { headers: headers() },
    );
    const d = res?.data;
    if (!d || typeof d.price !== "number") return null;
    return {
      address,
      symbol: d.symbol,
      name: d.name,
      priceUsd: d.price,
      liquidityUsd: d.liquidity,
      volume24hUsd: d.v24hUSD ?? d.volume24h,
      marketCapUsd: d.mc ?? d.marketCap,
      priceChange24hPct: d.priceChange24hPercent,
      holders: d.holder ?? d.holders,
      decimals: d.decimals,
    };
  } catch (err) {
    log.warn(`getTokenOverview failed for ${address}`, String(err));
    return null;
  }
}

export interface Candle {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd?: number;
}

/**
 * OHLCV candles for a token over a recent window.
 * `type` examples: "1m", "5m", "15m", "1H", "4H", "1D".
 */
export async function getOhlcv(
  address: string,
  type: string,
  fromUnix: number,
  toUnix: number,
): Promise<Candle[]> {
  if (!features.birdeye) return [];
  try {
    const res = await fetchJson<{ data?: { items?: any[] } }>(
      `${BASE}/defi/ohlcv?address=${address}&type=${type}&time_from=${fromUnix}&time_to=${toUnix}`,
      { headers: headers() },
    );
    const items = res?.data?.items ?? [];
    return items.map((c) => ({
      unixTime: c.unixTime,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volumeUsd: c.v,
    }));
  } catch (err) {
    log.warn(`getOhlcv failed for ${address}`, String(err));
    return [];
  }
}

export interface TopTrader {
  owner: string;
  volumeUsd?: number;
  trades?: number;
  side?: string;
}

/** Most active traders of a token in the recent window (for analysis context). */
export async function getTopTraders(address: string): Promise<TopTrader[]> {
  if (!features.birdeye) return [];
  try {
    const res = await fetchJson<{ data?: { items?: any[] } }>(
      `${BASE}/defi/v2/tokens/top_traders?address=${address}&time_frame=24h&sort_type=desc&sort_by=volume&limit=10`,
      { headers: headers() },
    );
    const items = res?.data?.items ?? [];
    return items.map((t) => ({
      owner: t.owner ?? t.address,
      volumeUsd: t.volume ?? t.volumeUsd,
      trades: t.trade ?? t.trades,
      side: t.side,
    }));
  } catch (err) {
    log.warn(`getTopTraders failed for ${address}`, String(err));
    return [];
  }
}
