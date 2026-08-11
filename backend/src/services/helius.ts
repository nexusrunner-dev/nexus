import { config, features } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { createLogger } from "../logger.js";

// ────────────────────────────────────────────────────────────────────────────
//  Helius — real-time Solana wallet activity via WEBHOOKS, plus DAS holdings.
//
//  Webhook REST : https://api.helius.xyz/v0/webhooks   (?api-key=KEY)
//  RPC / DAS    : https://mainnet.helius-rpc.com/?api-key=KEY
//
//  We keep ONE "enhanced" webhook registered with all active wallet addresses.
//  When any of those wallets transacts, Helius POSTs parsed transactions to our
//  /webhooks/helius endpoint, which we normalise into BUY/SELL events.
// ────────────────────────────────────────────────────────────────────────────

const log = createLogger("helius");
const API = "https://api.helius.xyz/v0";
const RPC = () => `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
export const SOL_MINT = "So11111111111111111111111111111111111111112";

function apiUrl(path: string) {
  return `${API}${path}?api-key=${config.HELIUS_API_KEY}`;
}

// ─── Webhook management ──────────────────────────────────────────────────────

interface HeliusWebhook {
  webhookID: string;
  accountAddresses: string[];
  webhookURL: string;
  transactionTypes: string[];
}

export async function listWebhooks(): Promise<HeliusWebhook[]> {
  if (!features.helius) return [];
  return fetchJson<HeliusWebhook[]>(apiUrl("/webhooks"));
}

// NOTE: the LIST endpoint above omits accountAddresses (observed 2026-08);
// only this single-webhook GET reliably returns the registered address list.
export async function getWebhook(id: string): Promise<HeliusWebhook | null> {
  if (!features.helius) return null;
  try {
    return await fetchJson<HeliusWebhook>(apiUrl(`/webhooks/${id}`));
  } catch (err) {
    log.warn(`getWebhook ${id} failed`, String(err));
    return null;
  }
}

async function createWebhook(addresses: string[]): Promise<HeliusWebhook> {
  const webhookURL = `${config.PUBLIC_BASE_URL}/webhooks/helius`;
  return fetchJson<HeliusWebhook>(apiUrl("/webhooks"), {
    method: "POST",
    body: {
      webhookURL,
      transactionTypes: ["SWAP", "TRANSFER"],
      accountAddresses: addresses,
      webhookType: "enhanced",
      authHeader: config.WEBHOOK_AUTH_TOKEN,
    },
  });
}

async function editWebhook(
  id: string,
  addresses: string[],
): Promise<HeliusWebhook> {
  const webhookURL = `${config.PUBLIC_BASE_URL}/webhooks/helius`;
  return fetchJson<HeliusWebhook>(apiUrl(`/webhooks/${id}`), {
    method: "PUT",
    body: {
      webhookURL,
      transactionTypes: ["SWAP", "TRANSFER"],
      accountAddresses: addresses,
      webhookType: "enhanced",
      authHeader: config.WEBHOOK_AUTH_TOKEN,
    },
  });
}

export async function deleteWebhook(id: string): Promise<void> {
  await fetchJson(apiUrl(`/webhooks/${id}`), { method: "DELETE" });
}

/**
 * Ensure a single Helius webhook reflects exactly `addresses`.
 * `existingId` is the id we previously stored (may be null on first run).
 * Returns the active webhook id, or null if there are no addresses to watch.
 */
export async function syncWalletWebhook(
  addresses: string[],
  existingId: string | null,
): Promise<string | null> {
  if (!features.helius) {
    log.warn("HELIUS_API_KEY not set — skipping webhook sync");
    return existingId;
  }
  if (!config.PUBLIC_BASE_URL) {
    log.warn("PUBLIC_BASE_URL not set — cannot register webhook URL yet");
    return existingId;
  }

  // No wallets left → remove the webhook entirely.
  if (addresses.length === 0) {
    if (existingId) {
      try {
        await deleteWebhook(existingId);
        log.info("deleted empty webhook");
      } catch (err) {
        log.warn("failed deleting webhook", String(err));
      }
    }
    return null;
  }

  // Update existing webhook if we have one, otherwise create a fresh one.
  try {
    if (existingId) {
      const wh = await editWebhook(existingId, addresses);
      log.info(
        `updated webhook ${wh.webhookID} — sent ${addresses.length} wallets, ` +
          `helius now has ${wh.accountAddresses?.length ?? "?"}`,
      );
      return wh.webhookID;
    }
    const wh = await createWebhook(addresses);
    log.info(
      `created webhook ${wh.webhookID} — sent ${addresses.length} wallets, ` +
        `helius now has ${wh.accountAddresses?.length ?? "?"}`,
    );
    return wh.webhookID;
  } catch (err) {
    // If the stored id is stale (e.g. deleted in the dashboard), create anew.
    log.warn("webhook sync failed, attempting recreate", String(err));
    try {
      const wh = await createWebhook(addresses);
      log.info(
        `recreated webhook ${wh.webhookID} — helius has ${wh.accountAddresses?.length ?? "?"} wallets`,
      );
      return wh.webhookID;
    } catch (err2) {
      log.error("webhook recreate failed", String(err2));
      return existingId;
    }
  }
}

// ─── Holdings (DAS) — used to seed positions when a wallet is first added ─────

export interface Holding {
  mint: string;
  amount: number;
  decimals: number;
}

// Returns null on error (so callers can tell "API failed" from "holds nothing").
export async function getTokenHoldings(owner: string): Promise<Holding[] | null> {
  if (!features.helius) return null;
  try {
    const res = await fetchJson<{ result?: { items?: any[] } }>(RPC(), {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "nexus",
        method: "searchAssets",
        params: {
          ownerAddress: owner,
          tokenType: "fungible",
          displayOptions: { showZeroBalance: false },
        },
      },
    });
    const items = res?.result?.items ?? [];
    return items
      .map((it) => {
        const info = it.token_info ?? {};
        const decimals = info.decimals ?? 0;
        const raw = Number(info.balance ?? 0);
        return {
          mint: it.id as string,
          amount: decimals ? raw / 10 ** decimals : raw,
          decimals,
        };
      })
      .filter((h) => h.amount > 0);
  } catch (err) {
    log.warn(`getTokenHoldings failed for ${owner}`, String(err));
    return null;
  }
}

// ─── Normalising enhanced-webhook transactions into BUY/SELL events ──────────

export interface SwapEvent {
  owner: string;
  signature: string;
  timestamp: number; // unix seconds
  direction: "BUY" | "SELL";
  tokenAddress: string;
  tokenAmount: number;
  solAmount: number; // SOL on the other leg (absolute)
  source?: string;
}

// A loose shape for the parts of an enhanced tx we care about.
interface EnhancedTx {
  signature: string;
  timestamp: number;
  source?: string;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    mint: string;
    tokenAmount: number;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount: number; // lamports
  }>;
  events?: {
    swap?: {
      tokenInputs?: Array<{
        userAccount?: string;
        mint: string;
        rawTokenAmount?: { tokenAmount: string; decimals: number };
      }>;
      tokenOutputs?: Array<{
        userAccount?: string;
        mint: string;
        rawTokenAmount?: { tokenAmount: string; decimals: number };
      }>;
      nativeInput?: { account?: string; amount: string };
      nativeOutput?: { account?: string; amount: string };
    };
  };
}

const LAMPORTS = 1_000_000_000;

/**
 * Turn a batch of enhanced transactions into BUY/SELL events for the given
 * set of tracked wallet addresses. Non-swap or irrelevant txs are ignored.
 */
export function normalizeSwaps(
  txs: EnhancedTx[],
  trackedOwners: Set<string>,
): SwapEvent[] {
  const out: SwapEvent[] = [];

  for (const tx of txs) {
    // Which tracked wallet is involved in this tx?
    const owner = findOwner(tx, trackedOwners);
    if (!owner) continue;

    const swap = tx.events?.swap;
    let direction: "BUY" | "SELL" | null = null;
    let tokenAddress: string | null = null;
    let tokenAmount = 0;
    let solAmount = 0;

    if (swap) {
      // Token the owner RECEIVED (output) → BUY ; token the owner SENT → SELL.
      const recv = (swap.tokenOutputs ?? []).find(
        (t) => t.userAccount === owner && t.mint !== SOL_MINT,
      );
      const sent = (swap.tokenInputs ?? []).find(
        (t) => t.userAccount === owner && t.mint !== SOL_MINT,
      );

      if (recv) {
        direction = "BUY";
        tokenAddress = recv.mint;
        tokenAmount = rawAmount(recv.rawTokenAmount);
        solAmount = Number(swap.nativeInput?.amount ?? 0) / LAMPORTS;
      } else if (sent) {
        direction = "SELL";
        tokenAddress = sent.mint;
        tokenAmount = rawAmount(sent.rawTokenAmount);
        solAmount = Number(swap.nativeOutput?.amount ?? 0) / LAMPORTS;
      }
    }

    // Fallback: infer from raw token/native transfers when no swap event.
    if (!direction) {
      const inferred = inferFromTransfers(tx, owner);
      if (inferred) {
        direction = inferred.direction;
        tokenAddress = inferred.tokenAddress;
        tokenAmount = inferred.tokenAmount;
        solAmount = inferred.solAmount;
      }
    }

    if (!direction || !tokenAddress || tokenAmount <= 0) continue;

    out.push({
      owner,
      signature: tx.signature,
      timestamp: tx.timestamp,
      direction,
      tokenAddress,
      tokenAmount,
      solAmount,
      source: tx.source,
    });
  }

  return out;
}

function rawAmount(raw?: { tokenAmount: string; decimals: number }): number {
  if (!raw) return 0;
  const decimals = raw.decimals ?? 0;
  return Number(raw.tokenAmount) / 10 ** decimals;
}

function findOwner(tx: EnhancedTx, owners: Set<string>): string | null {
  for (const t of tx.tokenTransfers ?? []) {
    if (t.fromUserAccount && owners.has(t.fromUserAccount)) return t.fromUserAccount;
    if (t.toUserAccount && owners.has(t.toUserAccount)) return t.toUserAccount;
  }
  for (const n of tx.nativeTransfers ?? []) {
    if (n.fromUserAccount && owners.has(n.fromUserAccount)) return n.fromUserAccount;
    if (n.toUserAccount && owners.has(n.toUserAccount)) return n.toUserAccount;
  }
  return null;
}

function inferFromTransfers(
  tx: EnhancedTx,
  owner: string,
): Omit<SwapEvent, "owner" | "signature" | "timestamp" | "source"> | null {
  const tokenIn = (tx.tokenTransfers ?? []).find(
    (t) => t.toUserAccount === owner && t.mint !== SOL_MINT,
  );
  const tokenOut = (tx.tokenTransfers ?? []).find(
    (t) => t.fromUserAccount === owner && t.mint !== SOL_MINT,
  );
  const solIn = (tx.nativeTransfers ?? [])
    .filter((n) => n.toUserAccount === owner)
    .reduce((a, n) => a + n.amount, 0) / LAMPORTS;
  const solOut = (tx.nativeTransfers ?? [])
    .filter((n) => n.fromUserAccount === owner)
    .reduce((a, n) => a + n.amount, 0) / LAMPORTS;

  if (tokenIn && solOut > 0) {
    return {
      direction: "BUY",
      tokenAddress: tokenIn.mint,
      tokenAmount: tokenIn.tokenAmount,
      solAmount: solOut,
    };
  }
  if (tokenOut && solIn > 0) {
    return {
      direction: "SELL",
      tokenAddress: tokenOut.mint,
      tokenAmount: tokenOut.tokenAmount,
      solAmount: solIn,
    };
  }
  return null;
}
