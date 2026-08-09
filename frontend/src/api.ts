// Thin API client for the Nexus backend.
// In dev, VITE_API_URL is empty and Vite proxies /api → backend.
// In prod, set VITE_API_URL to the deployed backend origin.

const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    // Only claim a JSON body when there IS one — Fastify rejects bodyless
    // requests (DELETE) that carry a json content-type with 400 Bad Request.
    headers: options?.body ? { "content-type": "application/json" } : {},
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data as T;
}

// ─── Types ───────────────────────────────────────────────────────────────────
export interface Wallet {
  id: string;
  address: string;
  label: string | null;
  emoji: string | null;
  active: boolean;
  positions: number;
  createdAt: string;
}

export interface WatchTarget {
  id: string;
  tokenId: string;
  metric: "PRICE_PCT" | "MARKET_CAP";
  direction: "UP" | "DOWN";
  value: number;
  baseline: number | null;
  deadline: string | null;
  status: "PENDING" | "HIT" | "EXPIRED";
  createdAt: string;
  resolvedAt: string | null;
}

export interface WatchToken {
  id: string;
  address: string;
  symbol: string | null;
  name: string | null;
  active: boolean;
  movePct: number | null;
  windowMin: number | null;
  baselinePrice: number | null;
  lastPrice: number | null;
  lastMarketCap: number | null;
  createdAt: string;
  targets: WatchTarget[];
}

export interface Alert {
  id: string;
  type: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  walletAddress: string | null;
  title: string;
  body: string;
  data: any;
  createdAt: string;
}

export interface AnalysisResult {
  address: string;
  symbol?: string;
  name?: string;
  priceUsd: number | null;
  signals: Record<string, unknown>;
  summary: string;
  model: string | null;
}

export interface Settings {
  telegramChatId: string | null;
  features: { helius: boolean; birdeye: boolean; anthropic: boolean; telegram: boolean };
}

// ─── Endpoints ───────────────────────────────────────────────────────────────
export const api = {
  wallets: {
    list: () => req<Wallet[]>("/wallets"),
    add: (address: string, label?: string, emoji?: string) =>
      req<Wallet>("/wallets", {
        method: "POST",
        body: JSON.stringify({ address, label, emoji }),
      }),
    update: (id: string, patch: { label?: string | null; emoji?: string | null }) =>
      req<Wallet>(`/wallets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/wallets/${id}`, { method: "DELETE" }),
  },
  watchlist: {
    list: () => req<WatchToken[]>("/watchlist"),
    add: (address: string, movePct?: number, windowMin?: number) =>
      req<WatchToken>("/watchlist", {
        method: "POST",
        body: JSON.stringify({ address, movePct, windowMin }),
      }),
    update: (id: string, patch: Partial<Pick<WatchToken, "movePct" | "windowMin" | "active">>) =>
      req<WatchToken>(`/watchlist/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    remove: (id: string) => req<{ ok: true }>(`/watchlist/${id}`, { method: "DELETE" }),
    addTarget: (
      id: string,
      target: {
        metric: "PRICE_PCT" | "MARKET_CAP";
        direction: "UP" | "DOWN";
        value: number;
        deadlineHours?: number;
      },
    ) =>
      req<WatchTarget>(`/watchlist/${id}/targets`, {
        method: "POST",
        body: JSON.stringify(target),
      }),
    removeTarget: (id: string, targetId: string) =>
      req<{ ok: true }>(`/watchlist/${id}/targets/${targetId}`, { method: "DELETE" }),
  },
  alerts: {
    list: (limit = 50) => req<Alert[]>(`/alerts?limit=${limit}`),
  },
  analyze: (address: string) =>
    req<AnalysisResult>("/analyze", { method: "POST", body: JSON.stringify({ address }) }),
  settings: {
    get: () => req<Settings>("/settings"),
    setTelegram: (chatId: string) =>
      req<{ ok: true }>("/settings/telegram", { method: "POST", body: JSON.stringify({ chatId }) }),
    testAlert: () => req<{ ok: true }>("/settings/test-alert", { method: "POST" }),
  },
};
