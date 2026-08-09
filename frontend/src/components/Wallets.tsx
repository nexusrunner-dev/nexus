import { useEffect, useState } from "react";
import { api, type Wallet, type WalletPosition } from "../api";
import { TokenAvatar } from "./Watchlist";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usd = (n: number | null | undefined) => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  const s =
    abs >= 1e6 ? `$${(abs / 1e6).toFixed(2)}M` :
    abs >= 1e3 ? `$${(abs / 1e3).toFixed(1)}K` :
    abs >= 1 ? `$${abs.toFixed(2)}` : `$${abs.toPrecision(3)}`;
  return n < 0 ? `-${s}` : s;
};
const priceFmt = (p: number | null) =>
  p == null ? "—" : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(4)}`;

export function Wallets() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null); // pending remove
  const [editId, setEditId] = useState<string | null>(null); // inline rename
  const [editLabel, setEditLabel] = useState("");
  const [editEmoji, setEditEmoji] = useState("");
  const [posId, setPosId] = useState<string | null>(null); // expanded positions
  const [positions, setPositions] = useState<WalletPosition[] | null>(null);
  const [posLoading, setPosLoading] = useState(false);

  const togglePositions = async (id: string) => {
    if (posId === id) {
      setPosId(null);
      setPositions(null);
      return;
    }
    setPosId(id);
    setPositions(null);
    setPosLoading(true);
    try {
      setPositions(await api.wallets.positions(id));
    } catch (e: any) {
      setError(`Couldn't load positions: ${e.message}`);
      setPosId(null);
    } finally {
      setPosLoading(false);
    }
  };

  const load = () =>
    api.wallets
      .list()
      .then(setWallets)
      .catch((e) => setError(String(e.message)))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    setError("");
    try {
      await api.wallets.add(
        address.trim(),
        label.trim() || undefined,
        emoji.trim() || undefined,
      );
      setAddress("");
      setLabel("");
      setEmoji("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const startEdit = (w: Wallet) => {
    setEditId(w.id);
    setEditLabel(w.label ?? "");
    setEditEmoji(w.emoji ?? "");
    setConfirmId(null);
    setError("");
  };

  const saveEdit = async (id: string) => {
    setError("");
    try {
      await api.wallets.update(id, { label: editLabel, emoji: editEmoji });
      setEditId(null);
      load();
    } catch (e: any) {
      setError(`Save failed: ${e.message}`);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      await api.wallets.remove(id);
      setConfirmId(null);
      load();
    } catch (e: any) {
      setError(`Remove failed: ${e.message}`);
      setConfirmId(null);
    }
  };

  return (
    <div className="panel">
      <h2>Tracked wallets</h2>
      <p className="muted small">
        Get a Telegram alert when these wallets <b>enter</b> a coin, <b>trim</b> or
        <b> exit</b> a position, or a holding is up <b>+50% / 2x / 3x …</b>{" "}
        Positions auto-sync with what the wallet actually holds on-chain.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          className="small"
          style={{ width: 56, textAlign: "center" }}
          placeholder="🐳"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
        />
        <input
          className="grow mono"
          placeholder="Solana wallet address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input
          className="small"
          style={{ width: 130 }}
          placeholder="name (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button className="btn" onClick={add} disabled={!address.trim()}>
          Track
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="spinner" style={{ marginTop: 14 }}>
          Loading…
        </div>
      ) : wallets.length === 0 ? (
        <div className="empty">No wallets tracked yet.</div>
      ) : (
        <ul className="list" style={{ marginTop: 12 }}>
          {wallets.map((w) => (
            <li key={w.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div>
                    {w.emoji && <span style={{ marginRight: 6 }}>{w.emoji}</span>}
                    {w.label ? <b>{w.label}</b> : <span className="mono">{short(w.address)}</span>}{" "}
                    <span className="tag">{w.positions} open positions</span>
                  </div>
                  <a
                    className="mono small muted"
                    href={`https://solscan.io/account/${w.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(w.address)} ↗
                  </a>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="ghost" onClick={() => togglePositions(w.id)}>
                    📊 {posId === w.id ? "Hide" : "Positions"}
                  </button>
                  <button className="ghost" onClick={() => (editId === w.id ? setEditId(null) : startEdit(w))}>
                    ✏️ {editId === w.id ? "Close" : "Edit"}
                  </button>
                  {confirmId === w.id ? (
                    <>
                      <button className="btn" style={{ background: "var(--red)" }} onClick={() => remove(w.id)}>
                        Yes, stop tracking
                      </button>
                      <button className="ghost" onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="ghost danger" onClick={() => { setConfirmId(w.id); setEditId(null); }}>
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {posId === w.id && (
                <div className="editor">
                  {posLoading ? (
                    <div className="spinner" style={{ marginTop: 10 }}>
                      Loading positions…
                    </div>
                  ) : !positions || positions.length === 0 ? (
                    <div className="empty">No open positions right now.</div>
                  ) : (
                    <ul className="list" style={{ marginTop: 6 }}>
                      {positions.map((p) => {
                        const pnl = p.unrealizedPnlUsd;
                        const up = pnl != null && pnl >= 0;
                        return (
                          <li key={p.id}>
                            <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                              <TokenAvatar src={p.imageUrl} symbol={p.tokenSymbol} size={34} />
                              <div>
                                <div>
                                  <b>${p.tokenSymbol ?? short(p.tokenAddress)}</b>{" "}
                                  <span className="tag">{usd(p.valueUsd)} held</span>{" "}
                                  {pnl != null && (
                                    <span className={`tag ${up ? "green" : "red"}`}>
                                      {up ? "▲" : "▼"} {usd(pnl)}
                                      {p.multiple != null && ` (${p.multiple.toFixed(2)}x)`}
                                    </span>
                                  )}
                                </div>
                                <div className="small muted">
                                  entry {priceFmt(p.avgEntryPriceUsd)} → now {priceFmt(p.priceUsd)}{" "}
                                  · since {new Date(p.openedAt).toLocaleDateString()}
                                </div>
                              </div>
                            </div>
                            <a
                              className="mono small muted"
                              href={`https://dexscreener.com/solana/${p.tokenAddress}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {short(p.tokenAddress)} ↗
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {editId === w.id && (
                <div className="editor">
                  <div className="row" style={{ marginTop: 10 }}>
                    <input
                      className="small"
                      style={{ width: 56, textAlign: "center" }}
                      placeholder="🐳"
                      value={editEmoji}
                      onChange={(e) => setEditEmoji(e.target.value)}
                    />
                    <input
                      className="grow"
                      placeholder="wallet name"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                    />
                    <button className="btn" onClick={() => saveEdit(w.id)}>
                      Save
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
