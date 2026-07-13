import { useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  LoaderCircle,
  MessageSquare,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { testLlm } from "./api";
import ChatPage from "./ChatPage";
import KnowledgeBasePage from "./KnowledgeBasePage";
import type { Settings } from "./types";

const defaultSettings: Settings = {
  llmApiUrl: "https://localhost:1443/v1",
  llmApiKey: "",
  llmModel: "gemini-3-flash",
};

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem("fieldnote-settings") ?? "{}");

    if (!saved.llmModel || saved.llmModel === "gpt-4.1-mini") {
      saved.llmModel = defaultSettings.llmModel;
    }
    const { elasticsearchUrl: _a, elasticsearchIndex: _b, elasticsearchApiKey: _c, ...rest } = saved;
    return { ...defaultSettings, ...rest };
  } catch {
    return defaultSettings;
  }
}

function SettingsDialog({ value, onSave, onClose }: { value: Settings; onSave: (value: Settings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function runTest() {
    setTesting(true);
    setTestResult({ ok: false, message: "Checking…" });
    try {
      setTestResult(await testLlm(draft));
    } catch (cause) {
      setTestResult({ ok: false, message: String(cause) });
    } finally {
      setTesting(false);
    }
  }

  const field = (key: keyof Settings, label: string, type = "text", placeholder = "") => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={draft[key]}
        placeholder={placeholder}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </label>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <div className="modal-title">
          <div><span className="eyebrow">Settings</span><h2>Model</h2></div>
          <button className="icon-button" onClick={onClose} title="Close"><X size={18} /></button>
        </div>
        <div className="settings-section">
          <div className="section-label"><MessageSquare size={16} /><span>AI model</span></div>
          {field("llmApiUrl", "Endpoint URL", "url")}
          <div className="field-grid">
            {field("llmModel", "Model")}
            {field("llmApiKey", "API key", "password")}
          </div>
          <div className="connection-test-row">
            <button className="button secondary" onClick={runTest} disabled={testing}>
              {testing ? <LoaderCircle className="spin" size={15} /> : <MessageSquare size={15} />}
              Test
            </button>
            {testResult && (
              <span className={testResult.ok ? "test-ok" : "test-error"}>
                {testResult.ok && <Check size={14} />}
                {testResult.message}
              </span>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>Cancel</button>
          <button className="button primary" onClick={() => onSave(draft)}><Check size={16} />Save</button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<"chat" | "knowledge">("knowledge");
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const connectionReady = useMemo(
    () => Boolean(settings.llmApiUrl && settings.llmApiKey && settings.llmModel),
    [settings],
  );

  function save(value: Settings) {
    setSettings(value);
    localStorage.setItem("fieldnote-settings", JSON.stringify(value));
    setShowSettings(false);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <b>Fieldnote</b>
            <span>Your agent crop & weed sources, on your own device</span>
          </div>
        </div>
        <nav>
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
            <MessageSquare size={18} />Ask
          </button>
          <button className={view === "knowledge" ? "active" : ""} onClick={() => setView("knowledge")}>
            <BookOpen size={18} />Sources
          </button>
        </nav>
        <div className="sidebar-footer">
          <button className="connection" onClick={() => setShowSettings(true)}>
            <span className={connectionReady ? "online" : ""}><SettingsIcon size={16} /></span>
            <div>
              <b>Settings</b>
              <small>{connectionReady ? "Ready" : "Connect a model"}</small>
            </div>
            <SettingsIcon size={16} />
          </button>
        </div>
      </aside>
      {view === "chat" ? (
        <ChatPage settings={settings} openSettings={() => setShowSettings(true)} />
      ) : (
        <KnowledgeBasePage settings={settings} openSettings={() => setShowSettings(true)} />
      )}
      {showSettings && <SettingsDialog value={settings} onSave={save} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
