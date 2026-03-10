import { useState, useEffect } from "react";
import { api } from "../../api/client";

interface Props {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ initialPath, onSelect, onClose }: Props) {
  const [currentPath, setCurrentPath] = useState(initialPath || "");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDir(currentPath || undefined);
  }, []);

  async function loadDir(path?: string) {
    setLoading(true);
    try {
      const result = await api.browseDirs(path);
      setCurrentPath(result.path);
      setParentPath(result.parent);
      setDirs(result.dirs);
    } catch (err) {
      console.error("Failed to browse:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <h2>Choose Folder</h2>

        <div className="folder-picker-path">
          <span className="folder-picker-current">{currentPath}</span>
        </div>

        <div className="folder-picker-actions-top">
          {parentPath && (
            <button className="btn-link" onClick={() => loadDir(parentPath)}>
              &larr; Up
            </button>
          )}
        </div>

        <div className="folder-picker-list">
          {loading ? (
            <div className="folder-picker-loading">Loading...</div>
          ) : dirs.length === 0 ? (
            <div className="folder-picker-empty">No subfolders</div>
          ) : (
            dirs.map((dir) => (
              <button
                key={dir.path}
                className="folder-picker-item"
                onClick={() => loadDir(dir.path)}
              >
                <span className="folder-icon">&#128193;</span>
                {dir.name}
              </button>
            ))
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onSelect(currentPath);
              onClose();
            }}
          >
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  );
}
