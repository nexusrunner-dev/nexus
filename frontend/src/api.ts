// Thin API client for the Nexus backend.
// In dev, VITE_API_URL is empty and Vite proxies /api → backend.
// In prod, set VITE_API_URL to the deployed backend origin.

const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { "content-type": "application/json" },
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
  active: boolean;
  positions: number;
  createdAt: string;
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
  createdAt: string;
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
    add: (address: string, label?: string) =>
      req<Wallet>("/wallets", { method: "POST", body: JSON.stringify({ address, label }) }),
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
