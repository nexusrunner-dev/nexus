import { useEffect, useState } from "react";
import { api, type Wallet } from "../api";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function Wallets() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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
      await api.wallets.add(address.trim(), label.trim() || undefined);
      setAddress("");
      setLabel("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Stop tracking this wallet?")) return;
    await api.wallets.remove(id);
    load();
  };

  return (
    <div className="panel">
      <h2>Tracked wallets</h2>
      <p className="muted small">
        Get a Telegram alert when these wallets <b>enter</b> a coin, <b>exit</b> a
        position, or one of their holdings hits <b>2x / 3x / 5x…</b>
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          className="grow mono"
          placeholder="Solana wallet address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input
          className="small"
          style={{ width: 130 }}
          placeholder="label (optional)"
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
            <li key={w.id}>
              <div>
                <div>
                  {w.label ? <b>{w.label}</b> : <span className="mono">{short(w.address)}</span>}{" "}
                  <span className="tag">{w.positions} positions</span>
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
              <button className="ghost danger" onClick={() => remove(w.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
