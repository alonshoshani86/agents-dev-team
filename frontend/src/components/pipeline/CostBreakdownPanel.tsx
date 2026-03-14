import type { ContextUsage } from "../../stores/useStore";
import { AgentCostBar } from "./AgentCostBar";

// Shared agent color map — keep in sync with PipelineView's AGENT_COLORS
export const AGENT_COLORS: Record<string, string> = {
  product: "#6366f1",
  architect: "#8b5cf6",
  dev: "#3b82f6",
  test: "#22c55e",
  uxui: "#f59e0b",
};

const DEFAULT_COLOR = "#6b7280";

interface CostBreakdownPanelProps {
  /** Live in-memory usage per agent (from store.contextUsage) */
  liveUsage: Record<string, ContextUsage>;
  /** Persisted per-agent costs loaded from task.json (fallback for reload) */
  persistedAgentCosts?: Record<string, number>;
  totalCostUSD: number;
  className?: string;
}

export function CostBreakdownPanel({
  liveUsage,
  persistedAgentCosts,
  totalCostUSD,
  className,
}: CostBreakdownPanelProps) {
  // Merge: live data takes priority over persisted (more up-to-date during streaming)
  const merged: Record<string, number> = {
    ...(persistedAgentCosts ?? {}),
    ...Object.fromEntries(
      Object.entries(liveUsage)
        .filter(([, u]) => u.costUSD > 0)
        .map(([name, u]) => [name, u.costUSD])
    ),
  };

  const agentsWithCost = Object.entries(merged).filter(([, c]) => c > 0);

  if (agentsWithCost.length === 0 && totalCostUSD <= 0) return null;

  return (
    <div
      className={className}
      style={{
        borderRadius: 8,
        border: "1px solid var(--border-color)",
        background: "var(--bg-secondary)",
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 10 }}>
        Cost Breakdown
      </div>

      {agentsWithCost.length === 0 ? (
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>No cost data yet</p>
      ) : (
        <>
          {agentsWithCost.map(([agent, cost]) => (
            <AgentCostBar
              key={agent}
              agentName={agent}
              costUSD={cost}
              totalCostUSD={totalCostUSD}
              color={AGENT_COLORS[agent] ?? DEFAULT_COLOR}
              isLive={!!liveUsage[agent]}
            />
          ))}
          <div style={{ borderTop: "1px solid var(--border-color)", marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600 }}>
            <span style={{ color: "var(--text-secondary)" }}>Total</span>
            <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>${totalCostUSD.toFixed(4)}</span>
          </div>
        </>
      )}
    </div>
  );
}
