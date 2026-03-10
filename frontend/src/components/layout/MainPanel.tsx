import { useStore } from "../../stores/useStore";
import { AgentChat } from "../agents/AgentChat";
import { SettingsPage } from "./SettingsPage";
import { ProjectSettings } from "../projects/ProjectSettings";
import { PipelineView } from "../pipeline/PipelineView";
import { usePipelineEvents } from "../../hooks/usePipelineEvents";

const AGENT_DISPLAY: Record<string, string> = {
  product: "Product",
  architect: "Architect",
  dev: "Dev",
  test: "Test",
  uxui: "UX/UI",
};

export function MainPanel() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeAgentName = useStore((s) => s.activeAgentName);
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const projects = useStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  // Connect to pipeline events WebSocket
  usePipelineEvents(activeProjectId);

  if (activeView === "settings") {
    return (
      <div className="main-panel">
        <div className="main-content">
          <SettingsPage />
        </div>
      </div>
    );
  }

  if (activeView === "project-settings") {
    return (
      <div className="main-panel">
        <div className="main-content">
          <ProjectSettings />
        </div>
      </div>
    );
  }

  if (!activeProject) {
    return (
      <div className="main-panel">
        <div className="main-content">
          <div className="empty-state">
            <h2>Welcome to DevTeam Agent Platform</h2>
            <p>Select or create a project to get started</p>
          </div>
        </div>
      </div>
    );
  }

  if (activeView === "pipeline") {
    return (
      <div className="main-panel">
        <PipelineView />
      </div>
    );
  }

  if (activeView === "agent-chat" && activeAgentName && activeProjectId) {
    return (
      <div className="main-panel">
        <AgentChat
          projectId={activeProjectId}
          agentName={activeAgentName}
          agentDisplayName={AGENT_DISPLAY[activeAgentName] || activeAgentName}
        />
      </div>
    );
  }

  return (
    <div className="main-panel">
      <div className="main-content">
        <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>{activeProject.name}</h1>
            {activeProject.description && (
              <p style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 4 }}>
                {activeProject.description}
              </p>
            )}
          </div>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: "6px 12px" }}
            onClick={() => setActiveView("project-settings")}
          >
            Project Settings
          </button>
        </div>

        <div className="empty-state" style={{ height: "auto", paddingTop: 60 }}>
          <p>Click an agent in the sidebar to chat, or create a new task to run a pipeline</p>
        </div>
      </div>
    </div>
  );
}
