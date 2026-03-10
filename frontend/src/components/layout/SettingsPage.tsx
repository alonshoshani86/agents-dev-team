import { useState, useEffect } from "react";
import { api } from "../../api/client";

export function SettingsPage() {
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("claude-sonnet-4-6");
  const [complexModel, setComplexModel] = useState("claude-opus-4-6");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [maskedKey, setMaskedKey] = useState("");

  useEffect(() => {
    api.getConfig().then((config) => {
      setMaskedKey(config.anthropic_api_key || "");
      setDefaultModel(config.default_model || "claude-sonnet-4-6");
      setComplexModel(config.complex_model || "claude-opus-4-6");
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const update: Record<string, string> = {
        default_model: defaultModel,
        complex_model: complexModel,
      };
      if (apiKey) {
        update.anthropic_api_key = apiKey;
      }
      const config = await api.updateConfig(update);
      setMaskedKey(config.anthropic_api_key || "");
      setApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error("Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page">
      <h1 className="settings-title">Settings</h1>

      <div className="settings-section">
        <h2 className="settings-section-title">API Configuration</h2>

        <div className="settings-field">
          <label>Anthropic API Key</label>
          {maskedKey && (
            <div className="settings-current-key">
              Current: <code>{maskedKey}</code>
            </div>
          )}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={maskedKey ? "Enter new key to update..." : "sk-ant-..."}
          />
        </div>

        <div className="settings-field">
          <label>Default Model</label>
          <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (fast)</option>
            <option value="claude-opus-4-6">Claude Opus 4.6 (powerful)</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (cheapest)</option>
          </select>
          <span className="settings-hint">Used for most agent tasks</span>
        </div>

        <div className="settings-field">
          <label>Complex Model</label>
          <select value={complexModel} onChange={(e) => setComplexModel(e.target.value)}>
            <option value="claude-opus-4-6">Claude Opus 4.6 (powerful)</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (fast)</option>
          </select>
          <span className="settings-hint">Used for architecture and complex reasoning</span>
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {saved && <span className="settings-saved">Settings saved</span>}
      </div>
    </div>
  );
}
