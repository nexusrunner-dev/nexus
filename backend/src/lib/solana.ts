// Minimal Solana address validation (base58, 32–44 chars). Good enough to
// reject typos before we hand an address to a provider.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidSolanaAddress(addr: unknown): addr is string {
  return typeof addr === "string" && BASE58.test(addr.trim());
}
