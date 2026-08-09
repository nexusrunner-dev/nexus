import { useEffect, useState } from "react";
import { api, type WatchToken, type WatchTarget } from "../api";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const price = (p: number | null) =>
  p == null ? "—" : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(4)}`;
const compact = (n: number | null | undefined) => {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};

export function TokenAvatar({
  src,
  symbol,
  size = 40,
}: {
  src: string | null;
  symbol: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      <img
        className="token-img"
        style={{ width: size, height: size }}
        src={src}
        alt={symbol ?? "token"}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div className="token-img token-img-fallback" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {(symbol ?? "?").replace(/^\$/, "").charAt(0).toUpperCase()}
    </div>
  );
}

export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // clipboard API blocked — fall back to a hidden textarea
      const ta = document.createElement("textarea");
      ta.value = address;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button className="copy-btn mono small" onClick={copy} title="Copy contract address">
      {copied ? "✓ copied" : "📋 copy CA"}
    </button>
  );
}

function targetLabel(t: WatchTarget): string {
  const dir = t.direction === "UP" ? "▲" : "▼";
  const what =
    t.metric === "MARKET_CAP" ? `${dir} ${compact(t.value)} mcap` : `${dir} ${t.value}%`;
  if (!t.deadline) return what;
  const left = new Date(t.deadline).getTime() - Date.now();
  if (t.status !== "PENDING" || left <= 0) return what;
  const hrs = left / 3_600_000;
  const time = hrs >= 48 ? `${Math.round(hrs / 24)}d` : hrs >= 1 ? `${Math.round(hrs)}h` : `${Math.max(1, Math.round(left / 60_000))}m`;
  return `${what} · ${time} left`;
}

export function Watchlist() {
  const [tokens, setTokens] = useState<WatchToken[]>([]);
  const [address, setAddress] = useState("");
  const [movePct, setMovePct] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null); // expanded editor
  const [confirmId, setConfirmId] = useState<string | null>(null); // pending remove

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
      await api.watchlist.add(address.trim(), movePct ? Math.abs(Number(movePct)) : undefined);
      setAddress("");
      setMovePct("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      await api.watchlist.remove(id);
      setConfirmId(null);
      load();
    } catch (e: any) {
      setError(`Remove failed: ${e.message}`);
      setConfirmId(null);
    }
  };

  return (
    <div className="panel">
      <h2>Memecoin watchlist</h2>
      <p className="muted small">
        Add coins by mint address. You'll be alerted on a sharp move (default ±15%
        in ~5 min), on each <b>2x / 3x / 5x…</b>, and on any custom{" "}
        <b>🎯 targets</b> you set (tap ⚙️ on a coin).
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
            <li key={t.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                  <TokenAvatar src={t.imageUrl} symbol={t.symbol} />
                  <div>
                    <div>
                      <b>${t.symbol ?? short(t.address)}</b>{" "}
                      {t.name && <span className="muted small">{t.name}</span>}{" "}
                      <span className="tag">{price(t.lastPrice)}</span>{" "}
                      {t.lastMarketCap != null && (
                        <span className="tag">MC {compact(t.lastMarketCap)}</span>
                      )}{" "}
                      <span className="tag yellow">±{Math.abs(t.movePct ?? 15)}%</span>{" "}
                      {t.targets
                        .filter((x) => x.status === "PENDING")
                        .map((x) => (
                          <span key={x.id} className="tag green">
                            🎯 {targetLabel(x)}
                          </span>
                        ))}
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 2 }}>
                      <span className="mono small muted">{short(t.address)}</span>
                      <CopyAddress address={t.address} />
                      <a
                        className="small"
                        href={`https://trade.padre.gg/trade/solana/${t.address}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Padre ↗
                      </a>
                      <a
                        className="small"
                        href={`https://dexscreener.com/solana/${t.address}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        DexScreener ↗
                      </a>
                    </div>
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="ghost"
                    onClick={() => {
                      setOpenId(openId === t.id ? null : t.id);
                      setConfirmId(null);
                    }}
                  >
                    ⚙️ {openId === t.id ? "Close" : "Edit"}
                  </button>
                  {confirmId === t.id ? (
                    <>
                      <button className="btn" style={{ background: "var(--red)" }} onClick={() => remove(t.id)}>
                        Yes, remove
                      </button>
                      <button className="ghost" onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="ghost danger" onClick={() => setConfirmId(t.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {openId === t.id && <TokenEditor token={t} onChanged={load} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Per-coin editor: move threshold + custom targets ────────────────────────
function TokenEditor({ token, onChanged }: { token: WatchToken; onChanged: () => void }) {
  const [pct, setPct] = useState(token.movePct != null ? String(Math.abs(token.movePct)) : "");
  const [metric, setMetric] = useState<"PRICE_PCT" | "MARKET_CAP">("PRICE_PCT");
  const [direction, setDirection] = useState<"UP" | "DOWN">("UP");
  const [value, setValue] = useState("");
  const [hours, setHours] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const savePct = async () => {
    setErr("");
    setMsg("");
    try {
      await api.watchlist.update(token.id, {
        movePct: pct.trim() === "" ? null : Math.abs(Number(pct)),
      });
      setMsg("Move threshold saved ✓");
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const addTarget = async () => {
    setErr("");
    setMsg("");
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      setErr(metric === "MARKET_CAP" ? "Enter the target market cap in USD" : "Enter a percent, e.g. 30");
      return;
    }
    setBusy(true);
    try {
      await api.watchlist.addTarget(token.id, {
        metric,
        direction,
        value: v,
        deadlineHours: hours.trim() === "" ? undefined : Number(hours),
      });
      setValue("");
      setHours("");
      setMsg("Target set ✓ — you'll get a Telegram alert");
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeTarget = async (targetId: string) => {
    setErr("");
    try {
      await api.watchlist.removeTarget(token.id, targetId);
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="editor">
      <div className="row" style={{ marginTop: 10 }}>
        <span className="small muted">Alert on sharp move of ±</span>
        <input
          className="small"
          placeholder="15"
          value={pct}
          onChange={(e) => setPct(e.target.value)}
        />
        <span className="small muted">% (blank = default 15%)</span>
        <button className="ghost" onClick={savePct}>
          Save
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="small" style={{ marginBottom: 6 }}>
          <b>🎯 Targets</b>{" "}
          <span className="muted">— get one alert when it hits (or when time runs out)</span>
        </div>
        {token.targets.length > 0 && (
          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            {token.targets.map((t) => (
              <span
                key={t.id}
                className={`tag ${t.status === "HIT" ? "green" : t.status === "EXPIRED" ? "red" : ""}`}
              >
                {targetLabel(t)}
                {t.status !== "PENDING" && ` · ${t.status.toLowerCase()}`}
                {t.status === "PENDING" && (
                  <button className="chip-x" onClick={() => removeTarget(t.id)} title="Delete target">
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="row">
          <select value={metric} onChange={(e) => setMetric(e.target.value as any)}>
            <option value="PRICE_PCT">Price move %</option>
            <option value="MARKET_CAP">Market cap $</option>
          </select>
          <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="UP">{metric === "MARKET_CAP" ? "rises to" : "gains"}</option>
            <option value="DOWN">{metric === "MARKET_CAP" ? "drops to" : "drops"}</option>
          </select>
          <input
            className="small"
            style={{ width: 120 }}
            placeholder={metric === "MARKET_CAP" ? "e.g. 5000000" : "e.g. 30"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className="small muted">{metric === "MARKET_CAP" ? "USD" : "%"}</span>
          <input
            className="small"
            style={{ width: 90 }}
            placeholder="hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <span className="small muted">time limit (blank = none)</span>
          <button className="btn" onClick={addTarget} disabled={busy || !value.trim()}>
            Set target
          </button>
        </div>
        {metric === "MARKET_CAP" && value.trim() !== "" && Number(value) > 0 && (
          <div className="small muted" style={{ marginTop: 4 }}>
            = {compact(Number(value))} market cap
          </div>
        )}
      </div>

      {msg && <div className="ok">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}
