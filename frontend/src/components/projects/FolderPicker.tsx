import { useState, useEffect, type ReactNode } from "react";
import { api } from "../../api/client";

interface DirEntry {
  name: string;
  path: string;
}

interface NodeState {
  expanded: boolean;
  loading: boolean;
  children: DirEntry[] | null; // null = not yet fetched
  error: boolean;
}

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ initialPath, onSelect, onClose }: Props) {
  const [rootDirs, setRootDirs] = useState<DirEntry[] | null>(null);
  const [rootError, setRootError] = useState(false);
  const [rootLoading, setRootLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState(initialPath ?? "");
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});

  useEffect(() => {
    loadRoot();
  }, []);

  async function loadRoot() {
    setRootLoading(true);
    setRootError(false);
    try {
      const result = await api.browseDirs(undefined);
      setRootDirs(result.dirs);
      // Pre-select the root path if nothing chosen yet
      if (!selectedPath) setSelectedPath(result.path);
    } catch {
      setRootError(true);
    } finally {
      setRootLoading(false);
    }
  }

  async function toggleExpand(dir: DirEntry) {
    const state = nodeStates[dir.path];

    // If already expanded (and not errored), collapse
    if (state?.expanded && !state?.error) {
      setNodeStates((prev) => ({
        ...prev,
        [dir.path]: { ...prev[dir.path], expanded: false },
      }));
      return;
    }

    // If children already loaded (and no error), just re-expand
    if (!state?.error && state?.children !== null && state?.children !== undefined) {
      setNodeStates((prev) => ({
        ...prev,
        [dir.path]: { ...prev[dir.path], expanded: true },
      }));
      return;
    }

    // Fetch children (initial load or retry after error)
    setNodeStates((prev) => ({
      ...prev,
      [dir.path]: {
        expanded: false,
        loading: true,
        children: null,
        error: false,
        ...prev[dir.path],
        loading: true,
        error: false,
      },
    }));

    try {
      const result = await api.browseDirs(dir.path);
      // Backend may return HTTP 200 with an error field (e.g. "Permission denied")
      if (result.error) {
        setNodeStates((prev) => ({
          ...prev,
          [dir.path]: { expanded: false, loading: false, children: null, error: true },
        }));
      } else {
        setNodeStates((prev) => ({
          ...prev,
          [dir.path]: { expanded: true, loading: false, children: result.dirs, error: false },
        }));
      }
    } catch {
      setNodeStates((prev) => ({
        ...prev,
        [dir.path]: { expanded: false, loading: false, children: null, error: true },
      }));
    }
  }

  function renderDirNode(dir: DirEntry, depth: number) {
    const state = nodeStates[dir.path];
    const isExpanded = state?.expanded ?? false;
    const isLoading = state?.loading ?? false;
    const hasError = state?.error ?? false;
    const children = state?.children ?? null;
    const isSelected = selectedPath === dir.path;

    let chevron: ReactNode;
    if (isLoading) {
      chevron = <span className="fp-chevron fp-loading">⋯</span>;
    } else if (hasError) {
      chevron = <span className="fp-chevron fp-error">⚠</span>;
    } else if (isExpanded && children !== null && children.length === 0) {
      chevron = <span className="fp-chevron fp-empty">—</span>;
    } else {
      chevron = (
        <span className="fp-chevron">{isExpanded ? "▾" : "›"}</span>
      );
    }

    return (
      <div key={dir.path} className="fp-node" style={{ paddingLeft: `${depth * 16}px` }}>
        <div className={`fp-row${isSelected ? " fp-row--selected" : ""}`}>
          {/* Chevron toggles expansion */}
          <button
            className="fp-chevron-btn"
            onClick={() => toggleExpand(dir)}
            disabled={isLoading}
            title={hasError ? "Retry" : isExpanded ? "Collapse" : "Expand"}
          >
            {chevron}
          </button>

          {/* Folder name — clicking selects the path */}
          <button
            className="fp-name-btn"
            onClick={() => setSelectedPath(dir.path)}
            title={dir.path}
          >
            <span className="fp-folder-icon">📁</span>
            {dir.name}
          </button>
        </div>

        {/* Children rendered recursively */}
        {isExpanded && children && children.length > 0 && (
          <div className="fp-children">
            {children.map((child) => renderDirNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <h2>Choose Folder</h2>

        {/* Selected path bar */}
        <div className="fp-selected-bar">
          <span className="fp-selected-label">Selected:</span>
          <code className="fp-selected-path">{selectedPath || "—"}</code>
        </div>

        {/* Tree */}
        <div className="fp-tree">
          {rootLoading ? (
            <div className="fp-status">Loading…</div>
          ) : rootError ? (
            <div className="fp-status fp-status--error">
              <span>Failed to load folders.</span>
              <button className="btn-link" onClick={loadRoot}>
                Retry
              </button>
            </div>
          ) : !rootDirs || rootDirs.length === 0 ? (
            <div className="fp-status">No subfolders found.</div>
          ) : (
            rootDirs.map((dir) => renderDirNode(dir, 0))
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
