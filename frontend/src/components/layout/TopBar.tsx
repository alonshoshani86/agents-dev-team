import { useStore } from "../../stores/useStore";
import { ProjectSwitcher } from "../projects/ProjectSwitcher";

export function TopBar() {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);

  return (
    <div className="topbar">
      <span className="topbar-title">DevTeam Agents</span>
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
