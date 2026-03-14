import { useState, useEffect } from "react";
import { useStore } from "../../stores/useStore";
import { api } from "../../api/client";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

interface Pipeline {
  id: string;
  name: string;
  description?: string;
  start_agent?: string;
}

interface Props {
  onClose: () => void;
}

export function NewTaskModal({ onClose }: Props) {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const fetchTasks = useStore((s) => s.fetchTasks);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const setActiveView = useStore((s) => s.setActiveView);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (activeProjectId) {
      api.listPipelines(activeProjectId).then((p) => {
        setPipelines(p);
        if (p.length > 0) setSelectedPipeline(p[0].id);
      });
    }
  }, [activeProjectId]);

  async function handleCreate() {
    if (!activeProjectId || !title.trim() || !selectedPipeline) return;
    setCreating(true);

    try {
      // Create task
      const task = await api.createTask(activeProjectId, {
        name: title.trim(),
        description: description.trim(),
        pipeline_id: selectedPipeline,
      });

      // Switch to pipeline view (setActiveTask caches current terminals and inits new ones)
      setActiveTask(task.id);

      // Start pipeline
      await api.runTaskPipeline(activeProjectId, task.id, selectedPipeline);
      setActiveView("pipeline");
      await fetchTasks(activeProjectId);

      onClose();
    } catch (err) {
      console.error("Failed to create task:", err);
    } finally {
      setCreating(false);
    }
  }

  const selectedPipelineData = pipelines.find((p) => p.id === selectedPipeline);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: 460 }}>
        <h2>New Task</h2>

        <div className="form-group">
          <label>Task Name</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Fix Login Bug"
            autoFocus
          />
          {title.trim() && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
              Branch: <code style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>task/{slugify(title.trim())}</code>
            </div>
          )}
        </div>

        <div className="form-group">
          <label>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe what you want built..."
            rows={4}
          />
        </div>

        <div className="form-group">
          <label>Pipeline</label>
          <select
            value={selectedPipeline}
            onChange={(e) => setSelectedPipeline(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-primary)",
              fontSize: 13,
            }}
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {selectedPipelineData && (
            <div className="pipeline-preview">
              <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                {selectedPipelineData.description}
              </span>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={creating || !title.trim() || !selectedPipeline}
          >
            {creating ? "Creating..." : "Create & Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
