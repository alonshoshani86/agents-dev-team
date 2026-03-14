import { useEffect, useState } from "react";
import { useStore } from "../../stores/useStore";
import { api } from "../../api/client";
import { ProjectSwitcher } from "../projects/ProjectSwitcher";

export function TopBar() {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeTaskId = useStore((s) => s.activeTaskId);
  const tasks = useStore((s) => s.tasks);
  const [repoBranch, setRepoBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) {
      setRepoBranch(null);
      return;
    }
    api.getGitBranch(activeProjectId).then((res) => setRepoBranch(res.branch)).catch(() => setRepoBranch(null));
    const interval = setInterval(() => {
      api.getGitBranch(activeProjectId).then((res) => setRepoBranch(res.branch)).catch(() => setRepoBranch(null));
    }, 10_000);
    return () => clearInterval(interval);
  }, [activeProjectId]);

  // Show task branch if active task has a worktree, otherwise show repo branch
  const activeTask = tasks.find((t) => t.id === activeTaskId);
  const branch = activeTask?.branch_name || repoBranch;

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
      <button
        className="topbar-settings-btn"
        onClick={async () => {
          await api.logout();
          window.location.reload();
        }}
        title="Sign out"
        style={{ fontSize: 13 }}
      >
        &#x23FB;
      </button>
    </div>
  );
}
