import { useState, useEffect } from "react";
import { api } from "../../api/client";

interface DirEntry {
  name: string;
  path: string;
}

interface NodeState {
  /** null = not yet fetched; [] = fetched, empty */
  children: DirEntry[] | null;
  expanded: boolean;
  loading: boolean;
  error?: string;
}

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ initialPath, onSelect, onClose }: Props) {
  const [selectedPath, setSelectedPath] = useState(initialPath || "");
  const [rootPath, setRootPath] = useState("");
  const [rootDirs, setRootDirs] = useState<DirEntry[]>([]);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRoot();
  }, []);

  async function loadRoot() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browseDirs(initialPath || undefined);
      setRootPath(result.path);
      setRootDirs(result.dirs);
      if (!selectedPath) {
        setSelectedPath(result.path);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(`Failed to load folders: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  async function toggleExpand(dir: DirEntry) {
    const state = nodeStates[dir.path];

    if (state?.expanded) {
      // Collapse
      setNodeStates((prev) => ({
        ...prev,
        [dir.path]: { ...prev[dir.path], expanded: false },
      }));
      return;
    }

    if (!state?.error && state?.children !== null && state?.children !== undefined) {
      // Already loaded — just re-expand
      setNodeStates((prev) => ({
        ...prev,
        [dir.path]: { ...prev[dir.path], expanded: true },
      }));
      return;
    }

    // Fetch children
    setNodeStates((prev) => ({
      ...prev,
      [dir.path]: { children: null, expanded: false, loading: true },
    }));
    try {
      const result = await api.browseDirs(dir.path);
      setNodeStates((prev) => ({
        ...prev,
        [dir.path]: { children: result.dirs, expanded: true, loading: false },
      }));
    } catch {
      setNodeStates((prev) => ({
        ...prev,
        [dir.path]: {
          children: [],
          expanded: false,
          loading: false,
          error: "Cannot read folder",
        },
      }));
    }
  }

  function renderTree(dirs: DirEntry[], depth = 0): React.ReactNode {
    return dirs.map((dir) => {
      const state = nodeStates[dir.path];
      const expanded = state?.expanded ?? false;
      const children = state?.children ?? null;
      const nodeLoading = state?.loading ?? false;
      const nodeError = state?.error;
      const isSelected = selectedPath === dir.path;
      // A node has no children only if we've fetched and got an empty list
      const hasNoChildren = children !== null && children.length === 0 && !nodeError;

      return (
        <div key={dir.path} className="folder-tree-node">
          <div
            className={`folder-tree-row${isSelected ? " selected" : ""}`}
            style={{ paddingLeft: `${depth * 18 + 8}px` }}
          >
            {/* Chevron / expand control */}
            <button
              className="folder-tree-chevron"
              onClick={() => toggleExpand(dir)}
              title={expanded ? "Collapse" : "Expand"}
              disabled={nodeLoading}
            >
              {nodeLoading ? (
                <span className="folder-chevron-spinner">⋯</span>
              ) : hasNoChildren ? (
                <span className="folder-chevron-empty">—</span>
              ) : expanded ? (
                "▾"
              ) : (
                "›"
              )}
            </button>

            {/* Folder name — click to SELECT */}
            <button
              className="folder-tree-name"
              onClick={() => setSelectedPath(dir.path)}
              title={dir.path}
            >
              <span className="folder-icon">📁</span>
              {dir.name}
            </button>

            {nodeError && (
              <span className="folder-node-error" title={nodeError}>
                ⚠
              </span>
            )}
          </div>

          {/* Render children indented */}
          {expanded && children && children.length > 0 && (
            <div className="folder-tree-children">
              {renderTree(children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <h2>Choose Folder</h2>

        {/* Currently selected path */}
        <div className="folder-picker-selected">
          <span className="folder-picker-selected-label">📁</span>
          <span className="folder-picker-selected-path">
            {selectedPath || rootPath || "—"}
          </span>
        </div>

        {/* Tree */}
        <div className="folder-picker-tree">
          {loading ? (
            <div className="folder-picker-loading">Loading…</div>
          ) : error ? (
            <div className="folder-picker-error">
              <span>{error}</span>
              <button className="btn-link" onClick={loadRoot}>
                Retry
              </button>
            </div>
          ) : rootDirs.length === 0 ? (
            <div className="folder-picker-empty">No subfolders found</div>
          ) : (
            renderTree(rootDirs)
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!selectedPath}
            onClick={() => {
              if (selectedPath) {
                onSelect(selectedPath);
                onClose();
              }
            }}
          >
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  );
}
