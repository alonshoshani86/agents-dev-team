import { useState, useRef, useEffect } from "react";
import { useStore } from "../../stores/useStore";
import { NewProjectModal } from "./NewProjectModal";

export function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <>
      <div className="project-switcher" ref={ref}>
        <button className="project-switcher-btn" onClick={() => setOpen(!open)}>
          {activeProject ? activeProject.name : "Select Project"}
          <span style={{ fontSize: 10 }}>{open ? "\u25B2" : "\u25BC"}</span>
        </button>

        {open && (
          <div className="project-switcher-dropdown">
            {projects.map((p) => (
              <button
                key={p.id}
                className={`project-switcher-item ${p.id === activeProjectId ? "active" : ""}`}
                onClick={() => {
                  setActiveProject(p.id);
                  setOpen(false);
                }}
              >
                {p.name}
              </button>
            ))}
            {projects.length === 0 && (
              <div style={{ padding: "8px 12px", fontSize: 13, color: "var(--text-muted)" }}>
                No projects yet
              </div>
            )}
            <button
              className="project-switcher-new"
              onClick={() => {
                setOpen(false);
                setShowNewModal(true);
              }}
            >
              + New Project
            </button>
          </div>
        )}
      </div>

      {showNewModal && <NewProjectModal onClose={() => setShowNewModal(false)} />}
    </>
  );
}
