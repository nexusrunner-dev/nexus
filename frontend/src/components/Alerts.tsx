import { useEffect, useState } from "react";
import { api, type Alert } from "../api";

const ago = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () =>
    api.alerts
      .list(100)
      .then(setAlerts)
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000); // refresh feed every 15s
    return () => clearInterval(t);
  }, []);

  return (
    <div className="panel">
      <h2>Alert feed</h2>
      <p className="muted small">
        Everything Nexus has detected. These are also pushed to Telegram in
        real time.
      </p>
      {loading ? (
        <div className="spinner" style={{ marginTop: 14 }}>
          Loading…
        </div>
      ) : alerts.length === 0 ? (
        <div className="empty">No alerts yet — they'll appear here as they fire.</div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {alerts.map((a) => (
            <div className="alert-item" key={a.id}>
              <div className="a-title">{a.title}</div>
              <div className="a-body">{a.body}</div>
              <div className="a-time">
                {ago(a.createdAt)}
                {a.tokenAddress && (
                  <>
                    {" · "}
                    <a
                      href={`https://dexscreener.com/solana/${a.tokenAddress}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      chart ↗
                    </a>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
