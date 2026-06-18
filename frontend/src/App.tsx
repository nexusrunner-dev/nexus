import { useEffect, useState } from "react";
import { api, type Settings } from "./api";
import { Wallets } from "./components/Wallets";
import { Watchlist } from "./components/Watchlist";
import { Alerts } from "./components/Alerts";
import { Analyze } from "./components/Analyze";
import { SettingsTab } from "./components/Settings";

type Tab = "wallets" | "watchlist" | "alerts" | "analyze" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "wallets", label: "👛 Wallets" },
  { id: "watchlist", label: "⭐ Watchlist" },
  { id: "alerts", label: "🔔 Alerts" },
  { id: "analyze", label: "🔍 Analysis" },
  { id: "settings", label: "⚙️ Settings" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("wallets");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    api.settings
      .get()
      .then((s) => {
        setSettings(s);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }, []);

  const f = settings?.features;

  return (
    <div className="app">
      <header className="top">
        <h1>
          <span className="logo">◆</span> Nexus
        </h1>
        <div className="badges">
          {offline && <span className="badge off">backend offline</span>}
          {f && (
            <>
              <span className={`badge ${f.helius ? "on" : "off"}`}>Helius</span>
              <span className={`badge ${f.birdeye ? "on" : "off"}`}>Birdeye</span>
              <span className={`badge ${f.telegram ? "on" : "off"}`}>Telegram</span>
              <span className={`badge ${f.anthropic ? "on" : "off"}`}>Analysis</span>
            </>
          )}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "wallets" && <Wallets />}
      {tab === "watchlist" && <Watchlist />}
      {tab === "alerts" && <Alerts />}
      {tab === "analyze" && <Analyze />}
      {tab === "settings" && <SettingsTab onSaved={() => api.settings.get().then(setSettings)} />}
    </div>
  );
}
