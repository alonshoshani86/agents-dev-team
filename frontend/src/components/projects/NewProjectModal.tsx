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

  // Validation error state
  const [nameError, setNameError] = useState("");
  const [pathsError, setPathsError] = useState("");
  const [submitError, setSubmitError] = useState("");
  // Track which path rows have an empty path after validation fires
  const [highlightedRows, setHighlightedRows] = useState<Set<number>>(new Set());

  const createProject = useStore((s) => s.createProject);

  const hasValidPath = paths.some((p) => p.path.trim() !== "");

  function updatePath(index: number, field: keyof PathEntry, value: string) {
    const updated = [...paths];
    updated[index] = { ...updated[index], [field]: value };
    setPaths(updated);

    // Clear paths error as soon as any row gets a non-empty path
    if (field === "path" && value.trim() !== "") {
      setPathsError("");
      setHighlightedRows((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }

  function addPath() {
    setPaths([...paths, { label: "", path: "" }]);
  }

  function removePath(index: number) {
    if (paths.length <= 1) return;
    setPaths(paths.filter((_, i) => i !== index));
    setHighlightedRows((prev) => {
      const next = new Set<number>();
      prev.forEach((r) => {
        if (r < index) next.add(r);
        else if (r > index) next.add(r - 1);
      });
      return next;
    });
  }

  function validate(): boolean {
    let valid = true;

    if (!name.trim()) {
      setNameError("Project name is required");
      valid = false;
    }

    if (!hasValidPath) {
      setPathsError("At least one repo path is required");
      // Highlight all rows that have an empty path
      const emptyRows = new Set(
        paths.map((p, i) => (p.path.trim() === "" ? i : -1)).filter((i) => i !== -1),
      );
      setHighlightedRows(emptyRows);
      valid = false;
    }

    return valid;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");

    if (!validate()) return;

    setLoading(true);
    try {
      const validPaths = paths.filter((p) => p.path.trim());
      await createProject({
        name: name.trim(),
        description: description.trim(),
        paths: validPaths,
      });
      onClose();
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? err.message : "Failed to create project. Please try again.";
      setSubmitError(detail);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>New Project</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Project Name</label>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (e.target.value.trim()) setNameError("");
                }}
                placeholder="My Awesome Project"
                className={nameError ? "input-error" : undefined}
                autoFocus
              />
              {nameError && <span className="field-error">{nameError}</span>}
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
                    className={`path-value${highlightedRows.has(i) ? " input-error" : ""}`}
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
              {pathsError && <span className="field-error">{pathsError}</span>}
              <button type="button" className="btn-link" onClick={addPath}>
                + Add path
              </button>
            </div>
            {submitError && <div className="field-error submit-error">{submitError}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || !name.trim() || !hasValidPath}
              >
                {loading ? "Creating..." : "Create Project"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Rendered as a sibling — not inside modal-overlay — so backdrop clicks don't bubble up and close NewProjectModal */}
      {browsingIndex !== null && (
        <FolderPicker
          initialPath={paths[browsingIndex]?.path || undefined}
          onSelect={(selected) => updatePath(browsingIndex, "path", selected)}
          onClose={() => setBrowsingIndex(null)}
        />
      )}
    </>
  );
}
