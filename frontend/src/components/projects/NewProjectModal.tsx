import { useState } from "react";
import { useStore } from "../../stores/useStore";
import { FolderPicker } from "./FolderPicker";

interface Props {
  onClose: () => void;
}

interface PathEntry {
  label: string;
  path: string;
}

export function NewProjectModal({ onClose }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [paths, setPaths] = useState<PathEntry[]>([{ label: "", path: "" }]);
  const [loading, setLoading] = useState(false);
  const [browsingIndex, setBrowsingIndex] = useState<number | null>(null);

  const createProject = useStore((s) => s.createProject);

  function updatePath(index: number, field: keyof PathEntry, value: string) {
    const updated = [...paths];
    updated[index] = { ...updated[index], [field]: value };
    setPaths(updated);
  }

  function addPath() {
    setPaths([...paths, { label: "", path: "" }]);
  }

  function removePath(index: number) {
    if (paths.length <= 1) return;
    setPaths(paths.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    try {
      const validPaths = paths.filter((p) => p.path.trim());
      await createProject({
        name: name.trim(),
        description: description.trim(),
        paths: validPaths,
      });
      onClose();
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New Project</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Project Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Project"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
            />
          </div>
          <div className="form-group">
            <label>Project Paths</label>
            <span className="form-hint">Point to local folders (e.g. backend, frontend repos)</span>
            {paths.map((p, i) => (
              <div key={i} className="path-row">
                <input
                  className="path-label"
                  value={p.label}
                  onChange={(e) => updatePath(i, "label", e.target.value)}
                  placeholder="Label (e.g. backend)"
                />
                <input
                  className="path-value"
                  value={p.path}
                  onChange={(e) => updatePath(i, "path", e.target.value)}
                  placeholder="/Users/you/git/my-repo"
                />
                <button
                  type="button"
                  className="btn-browse"
                  onClick={() => setBrowsingIndex(i)}
                  title="Browse folders"
                >
                  &#128193;
                </button>
                {paths.length > 1 && (
                  <button type="button" className="path-remove" onClick={() => removePath(i)}>
                    &times;
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn-link" onClick={addPath}>
              + Add path
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading || !name.trim()}>
              {loading ? "Creating..." : "Create Project"}
            </button>
          </div>
        </form>
      </div>

      {browsingIndex !== null && (
        <FolderPicker
          initialPath={paths[browsingIndex]?.path || undefined}
          onSelect={(selected) => updatePath(browsingIndex, "path", selected)}
          onClose={() => setBrowsingIndex(null)}
        />
      )}
    </div>
  );
}
