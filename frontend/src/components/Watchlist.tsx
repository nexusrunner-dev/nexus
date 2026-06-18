import { useEffect, useState } from "react";
import { api, type WatchToken } from "../api";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const price = (p: number | null) =>
  p == null ? "—" : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(4)}`;

export function Watchlist() {
  const [tokens, setTokens] = useState<WatchToken[]>([]);
  const [address, setAddress] = useState("");
  const [movePct, setMovePct] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () =>
    api.watchlist
      .list()
      .then(setTokens)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    setError("");
    try {
      await api.watchlist.add(
        address.trim(),
        movePct ? Number(movePct) : undefined,
      );
      setAddress("");
      setMovePct("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove from watchlist?")) return;
    await api.watchlist.remove(id);
    load();
  };

  return (
    <div className="panel">
      <h2>Memecoin watchlist</h2>
      <p className="muted small">
        Add coins by mint address. You'll be alerted on a sharp move (default
        ±15% in ~5 min) and on each <b>2x / 3x / 5x…</b> from when you added it.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          className="grow mono"
          placeholder="Token mint address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input
          className="small"
          placeholder="move %"
          value={movePct}
          onChange={(e) => setMovePct(e.target.value)}
        />
        <button className="btn" onClick={add} disabled={!address.trim()}>
          Add
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="spinner" style={{ marginTop: 14 }}>
          Loading…
        </div>
      ) : tokens.length === 0 ? (
        <div className="empty">Watchlist is empty.</div>
      ) : (
        <ul className="list" style={{ marginTop: 12 }}>
          {tokens.map((t) => (
            <li key={t.id}>
              <div>
                <div>
                  <b>${t.symbol ?? short(t.address)}</b>{" "}
                  <span className="tag">{price(t.lastPrice)}</span>{" "}
                  <span className="tag yellow">±{t.movePct ?? 15}%</span>
                </div>
                <a
                  className="mono small muted"
                  href={`https://dexscreener.com/solana/${t.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(t.address)} ↗
                </a>
              </div>
              <button className="ghost danger" onClick={() => remove(t.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
