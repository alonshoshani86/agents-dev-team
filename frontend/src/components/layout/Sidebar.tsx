import { useState, useEffect } from "react";
import { useStore } from "../../stores/useStore";
import { NewTaskModal } from "../pipeline/NewTaskModal";

const AGENTS = [
  { name: "product", display: "Product" },
  { name: "architect", display: "Architect" },
  { name: "dev", display: "Dev" },
  { name: "test", display: "Test" },
  { name: "uxui", display: "UX/UI" },
];

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  choosing_agent: "Ready",
  waiting_input: "Needs Input",
  paused: "Paused",
  completed: "Done",
  cancelled: "Cancelled",
  error: "Error",
};

export function Sidebar() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeAgentName = useStore((s) => s.activeAgentName);
  const setActiveAgent = useStore((s) => s.setActiveAgent);
  const tasks = useStore((s) => s.tasks);
  const activeTaskId = useStore((s) => s.activeTaskId);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const fetchTasks = useStore((s) => s.fetchTasks);
  const deleteTask = useStore((s) => s.deleteTask);
  const initAgentTerminals = useStore((s) => s.initAgentTerminals);
  const agentTerminals = useStore((s) => s.agentTerminals);

  const [showNewTask, setShowNewTask] = useState(false);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (activeProjectId) {
      fetchTasks(activeProjectId);
    }
  }, [activeProjectId, fetchTasks]);

  if (!activeProjectId) {
    return (
      <div className="sidebar">
        <div className="sidebar-section">
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Select or create a project to get started
          </p>
        </div>
      </div>
    );
  }

  function handleTaskClick(taskId: string) {
    if (Object.keys(agentTerminals).length === 0) {
      initAgentTerminals(AGENTS.map((a) => a.name));
    }
    setActiveTask(taskId);
  }

  async function handleDeleteTask(e: React.MouseEvent, taskId: string) {
    e.stopPropagation();
    if (!activeProjectId) return;
    if (!confirm("Delete this task?")) return;
    setDeletingTaskId(taskId);
    try {
      await deleteTask(activeProjectId, taskId);
    } catch (err) {
      console.error("Failed to delete task:", err);
    } finally {
      setDeletingTaskId(null);
    }
  }

  function statusDotClass(status: string): string {
    switch (status) {
      case "running": return "working";
      case "choosing_agent": return "ready";
      case "waiting_input": return "input";
      case "cancelled": return "cancelled";
      case "completed": return "done";
      case "error": return "error";
      case "paused": return "working";
      default: return "pending";
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-title">Agents</div>
        <div className="agent-list">
          {AGENTS.map((agent) => (
            <button
              key={agent.name}
              className={`sidebar-item ${activeAgentName === agent.name ? "active" : ""}`}
              onClick={() => setActiveAgent(agent.name)}
            >
              <span className="status-dot idle" />
              {agent.display}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-section">
        <div className="sidebar-section-title">Tasks</div>
        {tasks.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 8px" }}>
            No tasks yet
          </p>
        ) : (
          <div className="task-list">
            {tasks.map((task) => (
              <div
                key={task.id}
                className={`sidebar-item task-sidebar-item ${activeTaskId === task.id ? "active" : ""}`}
                onClick={() => handleTaskClick(task.id)}
              >
                <span className={`status-dot ${statusDotClass(task.status)}`} />
                <span className="task-item-text">
                  <span className="task-item-title">{task.title}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{task.name || task.title}</span>
                    <span className="task-item-status">{STATUS_LABELS[task.status] || task.status}</span>
                    {task.total_cost_usd != null && task.total_cost_usd > 0 && (
                      <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 4 }}>
                        ${task.total_cost_usd.toFixed(4)}
                      </span>
                    )}
                  </span>
                </span>
                <button
                  className="btn-delete-task"
                  onClick={(e) => handleDeleteTask(e, task.id)}
                  disabled={deletingTaskId === task.id}
                  title="Delete task"
                >
                  {deletingTaskId === task.id ? "..." : "×"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <div className="sidebar-section">
        <button
          className="btn btn-primary"
          style={{ width: "100%" }}
          onClick={() => setShowNewTask(true)}
        >
          + New Task
        </button>
      </div>

      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} />}
    </div>
  );
}
