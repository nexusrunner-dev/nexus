import { useEffect, useState } from "react";
import { api, type Wallet } from "../api";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function Wallets() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [emoji, setEmoji] = useState("");
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

  const rename = async (w: Wallet) => {
    const newLabel = prompt("Wallet name:", w.label ?? "");
    if (newLabel === null) return; // cancelled
    const newEmoji = prompt("Emoji for this wallet (e.g. 🐳 💎 🦈):", w.emoji ?? "");
    await api.wallets.update(w.id, {
      label: newLabel,
      emoji: newEmoji ?? "",
    });
    load();
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
        Get a Telegram alert when these wallets <b>enter</b> a coin, <b>trim</b> or
        <b> exit</b> a position, or a holding is up <b>+50% / 2x / 3x …</b>
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
            <li key={w.id}>
              <div>
                <div>
                  {w.emoji && <span style={{ marginRight: 6 }}>{w.emoji}</span>}
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
              <div className="row" style={{ gap: 6 }}>
                <button className="ghost" onClick={() => rename(w)}>
                  ✏️ Edit
                </button>
                <button className="ghost danger" onClick={() => remove(w.id)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
