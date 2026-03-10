import { useState, useEffect } from "react";
import { useStore } from "../../stores/useStore";
import { api } from "../../api/client";
import { FolderPicker } from "./FolderPicker";

interface PathEntry {
  label: string;
  path: string;
}

export function ProjectSettings() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const fetchProjects = useStore((s) => s.fetchProjects);
  const project = projects.find((p) => p.id === activeProjectId);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [paths, setPaths] = useState<PathEntry[]>([{ label: "", path: "" }]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [browsingIndex, setBrowsingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (project) {
      setName(project.name || "");
      setDescription(project.description || "");
      const p = project.paths || [];
      setPaths(p.length > 0 ? p : [{ label: "", path: "" }]);
    }
  }, [project]);

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

  async function handleSave() {
    if (!activeProjectId) return;
    setSaving(true);
    try {
      const validPaths = paths.filter((p) => p.path.trim());
      await api.updateProject(activeProjectId, {
        name: name.trim(),
        description: description.trim(),
        paths: validPaths,
      });
      await fetchProjects();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save:", err);
    } finally {
      setSaving(false);
    }
  }

  if (!project) return null;

  return (
    <div className="project-settings">
      <h2>Project Settings</h2>

      <div className="form-group">
        <label>Project Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
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
        <span className="form-hint">
          Local folders for this project (e.g. backend, frontend repos)
        </span>
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
              <button
                type="button"
                className="path-remove"
                onClick={() => removePath(i)}
              >
                &times;
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn-link" onClick={addPath}>
          + Add path
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || !name.trim()}
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save"}
        </button>
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
