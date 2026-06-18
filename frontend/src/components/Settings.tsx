import { useEffect, useState } from "react";
import { api, type Settings } from "../api";

export function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [chatId, setChatId] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api.settings.get().then((s) => {
      setSettings(s);
      setChatId(s.telegramChatId ?? "");
    });
  }, []);

  const save = async () => {
    setMsg("");
    setErr("");
    try {
      await api.settings.setTelegram(chatId.trim());
      setMsg("Saved.");
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const test = async () => {
    setMsg("");
    setErr("");
    try {
      await api.settings.testAlert();
      setMsg("Test alert sent — check Telegram.");
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <>
      <div className="panel">
        <h2>Telegram notifications</h2>
        <p className="muted small">
          1. Open Telegram, message <b>@BotFather</b>, and create a bot to get a
          token (set it as <span className="mono">TELEGRAM_BOT_TOKEN</span> on the
          backend).
          <br />
          2. Message <b>your</b> bot and send <span className="mono">/start</span> —
          it replies with your chat id and wires up alerts automatically. Or paste
          the chat id here:
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            className="grow mono"
            placeholder="Telegram chat id"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
          <button className="btn" onClick={save} disabled={!chatId.trim()}>
            Save
          </button>
          <button className="ghost" onClick={test}>
            Send test
          </button>
        </div>
        {msg && <div className="ok">{msg}</div>}
        {err && <div className="error">{err}</div>}
      </div>

      <div className="panel">
        <h2>Integrations</h2>
        {settings ? (
          <ul className="list">
            {Object.entries(settings.features).map(([k, v]) => (
              <li key={k}>
                <span style={{ textTransform: "capitalize" }}>{k}</span>
                <span className={`tag ${v ? "green" : "red"}`}>
                  {v ? "connected" : "not configured"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="spinner">Loading…</div>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>
          Configure API keys (Helius, Birdeye, Anthropic) in the backend's
          <span className="mono"> .env</span> file. See the README for where to get each one.
        </p>
      </div>
    </>
  );
}
