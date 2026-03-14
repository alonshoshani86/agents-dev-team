import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useStore } from "../../stores/useStore";
import type { AgentTerminalMessage, AgentTerminalState } from "../../stores/useStore";
import { api } from "../../api/client";
import { ArtifactPanel } from "./ArtifactPanel";
import { PermissionModal } from "./PermissionModal";

const PIPELINE_AGENTS = [
  { name: "product", display: "Product" },
  { name: "architect", display: "Architect" },
  { name: "dev", display: "Dev" },
  { name: "test", display: "Test" },
  { name: "uxui", display: "UX/UI" },
];

export function PipelineView() {
  const activeTaskId = useStore((s) => s.activeTaskId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const tasks = useStore((s) => s.tasks);
  const pipelineAgentTab = useStore((s) => s.pipelineAgentTab);
  const setPipelineAgentTab = useStore((s) => s.setPipelineAgentTab);
  const pipelineWaitingInput = useStore((s) => s.pipelineWaitingInput);
  const pipelineChoosingAgent = useStore((s) => s.pipelineChoosingAgent);
  const suggestedNextAgent = useStore((s) => s.suggestedNextAgent);
  const askingAgent = useStore((s) => s.askingAgent);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userInput, setUserInput] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startingAgent, setStartingAgent] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [viewMode, setViewMode] = useState<"terminal" | "artifacts">("terminal");

  // Force re-render on store changes using subscribe
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const unsub = useStore.subscribe(() => {
      forceUpdate((n) => n + 1);
    });
    return unsub;
  }, []);

  // Read terminals directly from store (after force update)
  const agentTerminals = useStore.getState().agentTerminals;

  const task = tasks.find((t) => t.id === activeTaskId);
  const activeTerminal: AgentTerminalState | null = pipelineAgentTab
    ? agentTerminals[pipelineAgentTab] || null
    : null;

  async function handleStop() {
    if (!activeProjectId || !activeTaskId) return;
    setStopping(true);
    try {
      await api.cancelTask(activeProjectId, activeTaskId);
    } catch (err) {
      console.error("Failed to stop task:", err);
    } finally {
      setStopping(false);
    }
  }

  async function handleRestart() {
    if (!activeProjectId || !activeTaskId || !task) return;
    setRestarting(true);
    try {
      // If task is still running, cancel it first
      if (task.status === "running" || task.status === "waiting_input" || task.status === "choosing_agent") {
        await api.cancelTask(activeProjectId, activeTaskId);
        // Brief wait for cancellation to process
        await new Promise((r) => setTimeout(r, 500));
      }
      const pipelineId = task.pipeline_id || "full-feature";
      const store = useStore.getState();
      store.clearAgentTerminals();
      store.initAgentTerminals(PIPELINE_AGENTS.map((a) => a.name));
      store.clearContextUsage();
      store.setPipelineWaitingInput(false);
      store.setPipelineChoosingAgent(false);
      store.setAskingAgent(false);
      await api.runTaskPipeline(activeProjectId, activeTaskId, pipelineId);
    } catch (err) {
      console.error("Failed to restart task:", err);
    } finally {
      setRestarting(false);
    }
  }

  async function handleChooseAgent(agentName: string | null) {
    if (!activeProjectId || !activeTaskId) return;
    try {
      // If user typed context, inject it before starting the next agent
      if (userInput.trim() && agentName) {
        await api.injectContext(activeProjectId, activeTaskId, userInput.trim());
        useStore.getState().addAgentUserMessage(
          pipelineAgentTab || "product",
          userInput.trim()
        );
        setUserInput("");
      }
      await api.setNextAgent(activeProjectId, activeTaskId, agentName);
      useStore.getState().setPipelineChoosingAgent(false);
      if (agentName) {
        const display = PIPELINE_AGENTS.find((a) => a.name === agentName)?.display || agentName;
        useStore.getState().addAgentSystemMessage(
          pipelineAgentTab || "product",
          `User chose: run ${display} next.`
        );
      }
    } catch (err) {
      console.error("Failed to set next agent:", err);
    }
  }

  async function handleSendInput() {
    if (!userInput.trim() || !activeProjectId || !activeTaskId) return;
    setSending(true);
    try {
      await api.injectContext(activeProjectId, activeTaskId, userInput.trim());
      await api.resumeTask(activeProjectId, activeTaskId);
      useStore.getState().setPipelineWaitingInput(false);
      useStore.getState().addAgentUserMessage(
        pipelineAgentTab || "product",
        userInput.trim()
      );
      setUserInput("");
    } catch (err) {
      console.error("Failed to send input:", err);
    } finally {
      setSending(false);
    }
  }

  async function handleRunAgent(agentName: string) {
    if (!activeProjectId || !activeTaskId) return;
    setStartingAgent(agentName);
    try {
      const context = userInput.trim() || undefined;
      if (context) {
        useStore.getState().addAgentUserMessage(agentName, context);
        setUserInput("");
      }
      setPipelineAgentTab(agentName);
      await api.runAgent(activeProjectId, activeTaskId, agentName, context);
    } catch (err) {
      console.error("Failed to run agent:", err);
    } finally {
      setStartingAgent(null);
    }
  }

  // Always show run bar — user can always trigger an agent
  const showRunBar = task?.status !== "pending";

  function detectAgentFromInput(text: string): string | null {
    const lower = text.toLowerCase().trim();
    for (const agent of PIPELINE_AGENTS) {
      // Only match explicit commands like "run dev", "start product", "dev agent"
      // Avoid loose patterns like "to test" which match normal sentences
      const name = agent.name;
      const display = agent.display.toLowerCase();
      if (
        lower.match(new RegExp(`^(run|start)\\s+(?:the\\s+)?${name}$`)) ||
        lower.match(new RegExp(`^(run|start)\\s+(?:the\\s+)?${display}$`)) ||
        lower.match(new RegExp(`\\b${name}\\s+agent\\b`)) ||
        lower.match(new RegExp(`\\b${display}\\s+agent\\b`))
      ) {
        return name;
      }
    }
    return null;
  }

  function handleSubmitInput() {
    if (!userInput.trim()) return;
    // When pipeline is waiting for input, Send resumes the pipeline
    if (pipelineWaitingInput || task?.status === "waiting_input") {
      handleSendInput();
      return;
    }
    // When run bar is visible, try to detect agent routing intent
    if (showRunBar) {
      const detectedAgent = detectAgentFromInput(userInput);
      if (detectedAgent) {
        handleRunAgent(detectedAgent);
        return;
      }
    }
    handleAskAgent();
  }

  async function handleAskAgent() {
    const agent = pipelineAgentTab || task?.current_agent || "product";
    if (!userInput.trim() || !activeProjectId || !activeTaskId) return;
    setSending(true);
    try {
      // Ensure we have a tab selected
      if (!pipelineAgentTab) {
        setPipelineAgentTab(agent);
      }
      useStore.getState().addAgentUserMessage(agent, userInput.trim());
      useStore.getState().setAskingAgent(true);
      await api.askAgent(activeProjectId, activeTaskId, agent, userInput.trim());
      setUserInput("");
    } catch (err) {
      console.error("Failed to ask agent:", err);
      useStore.getState().setAskingAgent(false);
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  if (!task) {
    return (
      <div className="pipeline-view">
        <div className="empty-state">
          <p>Task not found</p>
        </div>
      </div>
    );
  }

  // Show all pipeline agents (not just ones with terminals)
  const visibleAgents = PIPELINE_AGENTS;

  return (
    <div className="pipeline-view">
      {/* Task header */}
      <div className="pipeline-header">
        <div className="pipeline-task-info">
          <span className={`pipeline-status-badge ${task.status}`}>{task.status}</span>
          <h3>{task.title}</h3>
          {task.branch_name && (
            <span className="pipeline-branch-badge">&#9741; {task.branch_name}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="view-mode-toggle">
            <button
              className={`view-mode-btn ${viewMode === "terminal" ? "active" : ""}`}
              onClick={() => setViewMode("terminal")}
            >
              Terminal
            </button>
            <button
              className={`view-mode-btn ${viewMode === "artifacts" ? "active" : ""}`}
              onClick={() => setViewMode("artifacts")}
            >
              Artifacts
            </button>
          </div>
          {task.current_agent && (
            <span className="pipeline-active-agent">
              Active: {PIPELINE_AGENTS.find((a) => a.name === task.current_agent)?.display || task.current_agent}
            </span>
          )}
          {(task.status === "running" || task.status === "waiting_input" || task.status === "choosing_agent") && (
            <button
              className="btn-stop-task"
              onClick={handleStop}
              disabled={stopping}
            >
              {stopping ? "Stopping..." : "Stop"}
            </button>
          )}
          {task.status !== "pending" && (
            <button
              className="btn-restart-task"
              onClick={handleRestart}
              disabled={restarting}
            >
              {restarting ? "Restarting..." : "Restart"}
            </button>
          )}
        </div>
      </div>

      {/* Context usage bar */}
      <ContextBar />

      {/* Artifacts view */}
      {viewMode === "artifacts" && activeProjectId && (
        <ArtifactPanel projectId={activeProjectId} taskId={task.id} />
      )}

      {/* Agent tabs + terminal — only in terminal mode */}
      {viewMode === "terminal" && (<>
      <div className="pipeline-tabs">
        {visibleAgents.map((agent) => {
          const terminal = agentTerminals[agent.name];
          const statusClass = terminal?.status || "idle";
          const isActive = pipelineAgentTab === agent.name;
          const hasContent = terminal && terminal.messages.length > 0;
          const msgCount = terminal?.messages.length || 0;

          return (
            <button
              key={agent.name}
              className={`pipeline-tab ${isActive ? "active" : ""} ${hasContent ? "has-content" : ""}`}
              onClick={() => setPipelineAgentTab(agent.name)}
            >
              <span className={`status-dot ${statusClass}`} />
              <span>{agent.display}</span>
              {msgCount > 0 && <span style={{ fontSize: 10, color: "#58a6ff" }}>({msgCount})</span>}
              {terminal?.streaming && <span className="tab-streaming-dot" />}
            </button>
          );
        })}
      </div>

      {/* Terminal body for active agent */}
      <div className="pipeline-terminal">
        <div className="pipeline-terminal-header">
          <div className="terminal-dots">
            <span className="dot red" />
            <span className="dot yellow" />
            <span className="dot green" />
          </div>
          <span className="terminal-title">
            {PIPELINE_AGENTS.find((a) => a.name === pipelineAgentTab)?.display || pipelineAgentTab} Agent
          </span>
          {activeTerminal?.streaming && (
            <span className="terminal-streaming" style={{ marginLeft: "auto" }}>
              Streaming...
            </span>
          )}
        </div>

        <div className="terminal-body" ref={scrollRef}>
          {(!activeTerminal || activeTerminal.messages.length === 0) && (
            <div className="terminal-welcome">
              <div className="terminal-welcome-sub">
                {activeTerminal?.status === "pending"
                  ? "Waiting to start..."
                  : "No output yet. Run the pipeline to see agent output here."}
              </div>
            </div>
          )}

          {activeTerminal?.messages.map((msg: AgentTerminalMessage, i: number) => (
            <div key={i} className={`terminal-msg ${msg.role}`}>
              {msg.role === "system" ? (
                <div className="pipeline-system-msg">{msg.content}</div>
              ) : msg.role === "user" ? (
                <div className="terminal-user-msg">
                  <span className="terminal-user-label">You:</span> {msg.content}
                </div>
              ) : msg.role === "thinking" ? (
                <ThinkingBlock content={msg.content} />
              ) : msg.role === "tool" ? (
                <div className="terminal-tool-msg">
                  <span className="tool-icon">{msg.content.startsWith("▶") ? "⚙" : msg.content.startsWith("✓") ? "✓" : "⇐"}</span>
                  <span className="tool-text">{msg.content.replace(/^[▶✓⇐]\s*/, "")}</span>
                </div>
              ) : (
                <div className="terminal-assistant">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code({ className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || "");
                        const codeStr = String(children).replace(/\n$/, "");
                        if (match) {
                          return (
                            <div className="terminal-code-block">
                              <div className="terminal-code-header">
                                <span>{match[1]}</span>
                                <button
                                  className="terminal-copy-btn"
                                  onClick={() => navigator.clipboard.writeText(codeStr)}
                                >
                                  Copy
                                </button>
                              </div>
                              <SyntaxHighlighter
                                style={vscDarkPlus}
                                language={match[1]}
                                PreTag="div"
                                customStyle={{
                                  margin: 0,
                                  borderRadius: "0 0 6px 6px",
                                  fontSize: 12,
                                }}
                              >
                                {codeStr}
                              </SyntaxHighlighter>
                            </div>
                          );
                        }
                        return (
                          <code className="terminal-inline-code" {...props}>
                            {children}
                          </code>
                        );
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          ))}

          {/* Thinking indicator when asking agent */}
          {askingAgent && !activeTerminal?.streaming && (
            <div className="terminal-thinking">
              <span className="thinking-dots">
                <span className="dot-1" />
                <span className="dot-2" />
                <span className="dot-3" />
              </span>
              <span className="thinking-text">Agent is thinking...</span>
            </div>
          )}
        </div>

        {/* Run Agent / Choose Next Agent bar */}
        {showRunBar && (
          <div className="agent-run-bar">
            <span className="agent-run-label">
              {pipelineChoosingAgent || task.status === "choosing_agent" ? "Next agent:" : "Run agent:"}
            </span>
            {PIPELINE_AGENTS.map((agent) => (
              <button
                key={agent.name}
                className={`btn-run-agent ${agent.name === suggestedNextAgent ? "suggested" : ""}`}
                onClick={() => {
                  if (pipelineChoosingAgent || task.status === "choosing_agent") {
                    handleChooseAgent(agent.name);
                  } else {
                    handleRunAgent(agent.name);
                  }
                }}
                disabled={!!startingAgent}
              >
                {startingAgent === agent.name ? "Starting..." : agent.display}
                {agent.name === suggestedNextAgent && <span className="suggested-badge">suggested</span>}
              </button>
            ))}
            {(pipelineChoosingAgent || task.status === "choosing_agent") && (
              <button
                className="btn-run-agent done"
                onClick={() => handleChooseAgent(null)}
              >
                Finish Task
              </button>
            )}
          </div>
        )}

        {/* Input area — always visible when a task exists */}
        {task && (
          <div className="terminal-input-area">
            <span className="terminal-input-prompt">&gt;</span>
            <textarea
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !pipelineChoosingAgent) {
                  e.preventDefault();
                  handleSubmitInput();
                }
              }}
              placeholder={pipelineChoosingAgent
                ? "Optional: add instructions for the next agent, then click an agent above..."
                : pipelineWaitingInput
                  ? "Ask a question or provide your answer..."
                  : "Add instructions (optional) then click an agent above, or ask a question..."}
              disabled={sending || askingAgent}
              rows={1}
              autoFocus={pipelineWaitingInput}
            />
            <div className="terminal-input-buttons">
              {!pipelineChoosingAgent && (
                <button
                  className="btn-ask-agent"
                  onClick={handleSubmitInput}
                  disabled={!userInput.trim() || sending || askingAgent}
                >
                  {askingAgent ? "Thinking..." : "Send"}
                </button>
              )}
              {(pipelineWaitingInput || task.status === "waiting_input") && (
                <button
                  className="btn-resume-pipeline"
                  onClick={handleSendInput}
                  disabled={!userInput.trim() || sending || askingAgent}
                >
                  Resume Pipeline
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      </>)}

      {/* Permission approval modal — floats over everything */}
      {activeProjectId && <PermissionModal projectId={activeProjectId} />}
    </div>
  );
}


function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!content) return null;
  const preview = content.length > 120 ? content.substring(0, 120) + "..." : content;
  return (
    <div className="terminal-thinking-block" onClick={() => setExpanded(!expanded)}>
      <div className="thinking-header">
        <span className="thinking-icon">💭</span>
        <span className="thinking-label">Thinking</span>
        <span className="thinking-toggle">{expanded ? "▾" : "▸"}</span>
      </div>
      <div className={`thinking-content ${expanded ? "expanded" : ""}`}>
        {expanded ? content : preview}
      </div>
    </div>
  );
}


const AGENT_COLORS: Record<string, string> = {
  product: "#6366f1",
  architect: "#8b5cf6",
  dev: "#3b82f6",
  test: "#22c55e",
  uxui: "#f59e0b",
};

function formatTokens(n: number) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ContextBar() {
  const usageMap = useStore((s) => s.contextUsage);
  const entries = Object.entries(usageMap);
  if (entries.length === 0) return null;

  return (
    <div className="context-bar">
      {entries.map(([agent, usage]) => {
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const contextWindow = usage.contextWindow || 200000;
        const pct = Math.min((totalTokens / contextWindow) * 100, 100);
        const barColor = pct > 80 ? "var(--error)" : pct > 50 ? "var(--warning)" : (AGENT_COLORS[agent] || "var(--accent)");
        const display = PIPELINE_AGENTS.find((a) => a.name === agent)?.display || agent;

        return (
          <div key={agent} className="context-bar-row">
            <div className="context-bar-labels">
              <span className="context-bar-agent" style={{ color: AGENT_COLORS[agent] || "var(--accent)" }}>
                {display}
              </span>
              <span className="context-bar-tokens">
                {formatTokens(totalTokens)} / {formatTokens(contextWindow)}
              </span>
              <span className="context-bar-detail">
                in: {formatTokens(usage.inputTokens)} &middot; out: {formatTokens(usage.outputTokens)}
                {usage.cacheRead > 0 && <> &middot; cache: {formatTokens(usage.cacheRead)}</>}
              </span>
              {usage.costUSD > 0 && (
                <span className="context-bar-cost">${usage.costUSD.toFixed(4)}</span>
              )}
              {usage.numTurns > 0 && (
                <span className="context-bar-turns">{usage.numTurns} turns</span>
              )}
            </div>
            <div className="context-bar-track">
              <div
                className="context-bar-fill"
                style={{ width: `${pct}%`, backgroundColor: barColor }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
