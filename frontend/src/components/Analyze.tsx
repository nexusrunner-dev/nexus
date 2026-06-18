import { useState } from "react";
import { api, type AnalysisResult } from "../api";

const fmt = (v: unknown) => {
  if (v == null) return "—";
  if (typeof v === "number")
    return Math.abs(v) >= 1000
      ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return String(v);
};

// Which signal keys to surface as cards (the rest stay in the model's prose).
const CARDS: [string, string][] = [
  ["price", "Price (USD)"],
  ["liquidityUsd", "Liquidity"],
  ["volume24hUsd", "24h Volume"],
  ["marketCapUsd", "Market cap"],
  ["holders", "Holders"],
  ["pairAgeHours", "Pair age (h)"],
];

export function Analyze() {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setError("");
    setResult(null);
    setLoading(true);
    try {
      setResult(await api.analyze(address.trim()));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const s = result?.signals as Record<string, unknown> | undefined;

  return (
    <div className="panel">
      <h2>Why is it pumping?</h2>
      <p className="muted small">
        Paste a token mint address. Nexus pulls live on-chain signals and
        explains the likely reason for the move.
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          className="grow mono"
          placeholder="Token mint address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && address.trim() && run()}
        />
        <button className="btn" onClick={run} disabled={!address.trim() || loading}>
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {result && (
        <div style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 6 }}>
            ${result.symbol ?? "?"}{" "}
            <span className="muted small">{result.name}</span>
          </h2>
          <div className="analysis-out">{result.summary}</div>

          {s && (
            <div className="signals">
              {CARDS.map(([key, label]) =>
                s[key] != null ? (
                  <div className="signal" key={key}>
                    <div className="k">{label}</div>
                    <div className="v">{fmt(s[key])}</div>
                  </div>
                ) : null,
              )}
            </div>
          )}
          <div className="muted small" style={{ marginTop: 10 }}>
            {result.model ? `Analysis by ${result.model}` : "Rule-based analysis (no LLM key set)"} ·
            data: {String((result.signals as any).dataSource)}
          </div>
        </div>
      )}
    </div>
  );
}
