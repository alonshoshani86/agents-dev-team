import { useState, useEffect } from "react";
import { api } from "../../api/client";

interface Props {
  onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [step, setStep] = useState<"welcome" | "enter-key" | "validating" | "error">("welcome");
  const [error, setError] = useState("");
  const [cliAvailable, setCliAvailable] = useState(false);
  const [validatingMsg, setValidatingMsg] = useState("Validating...");

  useEffect(() => {
    api.getConfig().then((config) => {
      setCliAvailable(config.cli_available);
    }).catch(() => {});
  }, []);

  async function handleCliAuth() {
    setStep("validating");
    setValidatingMsg("Connecting via Claude Code...");
    setError("");

    try {
      const result = await api.authCli();
      if (result.valid) {
        onAuthenticated();
      } else {
        setError(result.error || "Claude Code authentication failed");
        setStep("error");
      }
    } catch {
      setError("Failed to connect. Is the backend running?");
      setStep("error");
    }
  }

  async function handleKeyValidate() {
    if (!apiKey.trim()) return;
    setStep("validating");
    setValidatingMsg("Validating API key...");
    setError("");

    try {
      const result = await api.validateKey(apiKey.trim());
      if (result.valid) {
        onAuthenticated();
      } else {
        setError(result.error || "Invalid API key");
        setStep("error");
      }
    } catch {
      setError("Failed to validate key. Is the backend running?");
      setStep("error");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleKeyValidate();
  }

  return (
    <div className="auth-screen">
      <div className="auth-container">
        <div className="auth-logo">
          <div className="auth-logo-icon">&#9670;</div>
          <h1>DevTeam Agents</h1>
        </div>

        {step === "welcome" && (
          <div className="auth-step">
            <p className="auth-description">
              AI-powered dev team with Product, Architect, Dev, Test, and UX/UI agents
              that work together on your projects.
            </p>
            <div className="auth-methods">
              {cliAvailable && (
                <button className="auth-method-btn recommended" onClick={handleCliAuth}>
                  <span className="auth-method-icon">&#9654;</span>
                  <div>
                    <div className="auth-method-title">
                      Use Claude Code Login
                      <span className="auth-recommended-badge">Recommended</span>
                    </div>
                    <div className="auth-method-desc">Uses your existing Claude Code subscription — no extra cost</div>
                  </div>
                  <span className="auth-method-arrow">&rarr;</span>
                </button>
              )}
              <button className="auth-method-btn" onClick={() => setStep("enter-key")}>
                <span className="auth-method-icon">&#128273;</span>
                <div>
                  <div className="auth-method-title">Enter API Key</div>
                  <div className="auth-method-desc">Use your Anthropic API key (separate billing)</div>
                </div>
                <span className="auth-method-arrow">&rarr;</span>
              </button>
            </div>
            {!cliAvailable && (
              <p className="auth-hint">
                Get your API key from{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                  console.anthropic.com
                </a>
              </p>
            )}
          </div>
        )}

        {(step === "enter-key" || (step === "error" && apiKey !== undefined)) && (
          <div className="auth-step">
            {error && <div className="auth-error">{error}</div>}
            <div className="auth-key-input">
              <label>Anthropic API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="sk-ant-api03-..."
                autoFocus
              />
            </div>
            <div className="auth-key-actions">
              <button className="auth-back-btn" onClick={() => { setStep("welcome"); setError(""); }}>
                &larr; Back
              </button>
              <button
                className="auth-submit-btn"
                onClick={handleKeyValidate}
                disabled={!apiKey.trim()}
              >
                Connect
              </button>
            </div>
            <p className="auth-hint">
              Your key is stored locally and never sent anywhere except Anthropic's API.
            </p>
          </div>
        )}

        {step === "validating" && (
          <div className="auth-step">
            <div className="auth-validating">
              <div className="auth-spinner" />
              <span>{validatingMsg}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
