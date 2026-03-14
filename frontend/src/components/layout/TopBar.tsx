import { useEffect, useState } from "react";
import { useStore } from "../../stores/useStore";
import { api } from "../../api/client";
import { ProjectSwitcher } from "../projects/ProjectSwitcher";

export function TopBar() {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) {
      setBranch(null);
      return;
    }
    api.getGitBranch(activeProjectId).then((res) => setBranch(res.branch)).catch(() => setBranch(null));
    // Poll every 10s to keep branch up to date
    const interval = setInterval(() => {
      api.getGitBranch(activeProjectId).then((res) => setBranch(res.branch)).catch(() => setBranch(null));
    }, 10_000);
    return () => clearInterval(interval);
  }, [activeProjectId]);

  return (
    <div className="topbar">
      <span className="topbar-title">DevTeam Agents</span>
      {branch && (
        <span className="topbar-branch">
          <span className="topbar-branch-icon">&#9741;</span>
          {branch}
        </span>
      )}
      <div className="topbar-spacer" />
      <ProjectSwitcher />
      <button
        className={`topbar-settings-btn ${activeView === "settings" ? "active" : ""}`}
        onClick={() => setActiveView(activeView === "settings" ? "welcome" : "settings")}
        title="Settings"
      >
        &#9881;
      </button>
    </div>
  );
}
