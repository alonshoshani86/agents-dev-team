const AGENT_DISPLAY_NAMES: Record<string, string> = {
  product: "Product",
  architect: "Architect",
  dev: "Dev",
  test: "Test",
  uxui: "UX/UI",
};

interface AgentCostBarProps {
  agentName: string;
  costUSD: number;
  totalCostUSD: number;
  color: string;
  isLive?: boolean;
}

export function AgentCostBar({ agentName, costUSD, totalCostUSD, color, isLive }: AgentCostBarProps) {
  const displayName = AGENT_DISPLAY_NAMES[agentName] || agentName;
  const pct = totalCostUSD > 0 ? Math.round((costUSD / totalCostUSD) * 100) : 0;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{displayName}</span>
          {isLive && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", animation: "pulse 1.5s ease-in-out infinite" }}>
              live
            </span>
          )}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 6 }}>
          <span>${costUSD.toFixed(4)}</span>
          <span style={{ opacity: 0.5 }}>{pct}%</span>
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: "var(--bg-tertiary)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            borderRadius: 3,
            width: `${pct}%`,
            background: color,
            transition: "width 0.5s ease",
          }}
        />
      </div>
    </div>
  );
}
