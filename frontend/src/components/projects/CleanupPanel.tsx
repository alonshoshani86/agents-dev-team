import { useState } from "react";
import { api } from "../../api/client";
import type { CleanupScanResult, UnusedFile, FileCategory } from "../../types";

interface CleanupPanelProps {
  projectId: string;
}

const CATEGORY_LABELS: Record<FileCategory, string> = {
  tasks: "Task Directories",
  pipelines: "Pipeline Configs",
  files: "Working Files",
};

const CATEGORY_DESCRIPTIONS: Record<FileCategory, string> = {
  tasks: "Task folders for completed, cancelled, or failed tasks",
  pipelines: "Pipeline configs not referenced by any task",
  files: "Files in the project's files/ directory with no detected references (uncertain — review before deleting)",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

interface ConfirmModalProps {
  paths: string[];
  totalBytes: number;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ paths, totalBytes, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>Confirm Permanent Deletion</h3>
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
          This action is <strong>permanent and cannot be undone</strong>. The following{" "}
          {paths.length} item{paths.length !== 1 ? "s" : ""} ({formatBytes(totalBytes)}) will be
          deleted:
        </p>
        <div
          style={{
            maxHeight: 200,
            overflowY: "auto",
            background: "var(--bg-secondary)",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 12,
            fontFamily: "monospace",
            marginBottom: 16,
          }}
        >
          {paths.map((p) => (
            <div key={p} style={{ padding: "2px 0", color: "var(--text-secondary)" }}>
              {p}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn"
            style={{ background: "var(--danger, #e53e3e)", color: "#fff", border: "none" }}
            onClick={onConfirm}
          >
            Delete Permanently
          </button>
        </div>
      </div>
    </div>
  );
}

export function CleanupPanel({ projectId }: CleanupPanelProps) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<CleanupScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmPaths, setConfirmPaths] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function handleScan() {
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setSelected(new Set());
    try {
      const result = await api.scanUnusedFiles(projectId);
      setScanResult(result);
    } catch (err) {
      setScanError(String(err));
    } finally {
      setScanning(false);
    }
  }

  function toggleFile(filePath: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }

  function toggleCategory(files: UnusedFile[]) {
    const allSelected = files.every((f) => selected.has(f.path));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of files) {
        if (allSelected) {
          next.delete(f.path);
        } else {
          next.add(f.path);
        }
      }
      return next;
    });
  }

  function selectAll() {
    if (!scanResult) return;
    const all = allUnused(scanResult);
    setSelected(new Set(all.map((f) => f.path)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  function allUnused(result: CleanupScanResult): UnusedFile[] {
    return [
      ...result.categories.tasks,
      ...result.categories.pipelines,
      ...result.categories.files,
    ];
  }

  function selectedBytes(): number {
    if (!scanResult) return 0;
    return allUnused(scanResult)
      .filter((f) => selected.has(f.path))
      .reduce((sum, f) => sum + f.size_bytes, 0);
  }

  function requestDelete(paths: string[]) {
    if (paths.length === 0) return;
    setConfirmPaths(paths);
  }

  async function executeDelete(paths: string[]) {
    if (!scanResult) return;
    setConfirmPaths(null);
    setDeleting(true);
    try {
      const result = await api.deleteUnusedFiles(projectId, scanResult.scan_id, paths);
      const deletedSet = new Set(result.deleted);

      // Update scan result to remove deleted entries
      setScanResult((prev) => {
        if (!prev) return null;
        function filterOut(files: UnusedFile[]): UnusedFile[] {
          return files.filter((f) => !deletedSet.has(f.path));
        }
        const updated = {
          ...prev,
          categories: {
            tasks: filterOut(prev.categories.tasks),
            pipelines: filterOut(prev.categories.pipelines),
            files: filterOut(prev.categories.files),
          },
        };
        const remaining = allUnused(updated);
        updated.summary = {
          total_files: remaining.length,
          total_size_bytes: remaining.reduce((s, f) => s + f.size_bytes, 0),
        };
        return updated;
      });

      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of result.deleted) next.delete(p);
        return next;
      });

      const failCount = result.failed.length;
      const msg =
        `Deleted ${result.deleted.length} item${result.deleted.length !== 1 ? "s" : ""}, ` +
        `freed ${formatBytes(result.bytes_freed)}` +
        (failCount > 0 ? ` (${failCount} failed)` : "");
      showToast(msg);
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("scan_expired") || errMsg.includes("Scan is older")) {
        showToast("Scan expired — please re-scan before deleting.");
        setScanResult(null);
      } else {
        showToast(`Delete failed: ${errMsg}`);
      }
    } finally {
      setDeleting(false);
    }
  }

  const categories: FileCategory[] = ["tasks", "pipelines", "files"];
  const totalSelected = selected.size;
  const hasResults =
    scanResult &&
    (scanResult.categories.tasks.length > 0 ||
      scanResult.categories.pipelines.length > 0 ||
      scanResult.categories.files.length > 0);

  return (
    <div className="cleanup-panel" style={{ marginTop: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Workspace Cleanup</h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            Scan for unused files and free up disk space.
          </p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={handleScan}
          disabled={scanning || deleting}
          style={{ minWidth: 120 }}
        >
          {scanning ? "Scanning…" : "Scan for Unused Files"}
        </button>
      </div>

      {scanError && (
        <div style={{ color: "var(--danger, #e53e3e)", fontSize: 13, marginBottom: 12 }}>
          Scan failed: {scanError}
        </div>
      )}

      {scanResult && !hasResults && (
        <div style={{ color: "var(--text-secondary)", fontSize: 13, padding: "12px 0" }}>
          ✓ No unused files found — workspace is clean.
        </div>
      )}

      {hasResults && scanResult && (
        <>
          {/* Summary bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "10px 14px",
              background: "var(--bg-secondary)",
              borderRadius: 8,
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            <span>
              <strong>{scanResult.summary.total_files}</strong> unused item
              {scanResult.summary.total_files !== 1 ? "s" : ""} ·{" "}
              <strong>{formatBytes(scanResult.summary.total_size_bytes)}</strong> total
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn-link" style={{ fontSize: 12 }} onClick={selectAll}>
              Select all
            </button>
            <button className="btn-link" style={{ fontSize: 12 }} onClick={deselectAll}>
              Deselect all
            </button>
            {totalSelected > 0 && (
              <>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={() => requestDelete(Array.from(selected))}
                  disabled={deleting}
                >
                  Delete Selected ({totalSelected} · {formatBytes(selectedBytes())})
                </button>
                <button
                  className="btn"
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    background: "var(--danger, #e53e3e)",
                    color: "#fff",
                    border: "none",
                  }}
                  onClick={() =>
                    requestDelete(allUnused(scanResult).map((f) => f.path))
                  }
                  disabled={deleting}
                >
                  Delete All
                </button>
              </>
            )}
            {totalSelected === 0 && (
              <button
                className="btn"
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  background: "var(--danger, #e53e3e)",
                  color: "#fff",
                  border: "none",
                }}
                onClick={() =>
                  requestDelete(allUnused(scanResult).map((f) => f.path))
                }
                disabled={deleting}
              >
                Delete All
              </button>
            )}
          </div>

          {/* Category groups */}
          {categories.map((cat) => {
            const files = scanResult.categories[cat];
            if (files.length === 0) return null;
            const allCatSelected = files.every((f) => selected.has(f.path));
            const someCatSelected = files.some((f) => selected.has(f.path));

            return (
              <div key={cat} style={{ marginBottom: 20 }}>
                {/* Category header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 8,
                    cursor: "pointer",
                  }}
                  onClick={() => toggleCategory(files)}
                >
                  <input
                    type="checkbox"
                    checked={allCatSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someCatSelected && !allCatSelected;
                    }}
                    onChange={() => toggleCategory(files)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ cursor: "pointer" }}
                  />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {CATEGORY_LABELS[cat]}
                    <span style={{ fontWeight: 400, color: "var(--text-secondary)", marginLeft: 6 }}>
                      ({files.length})
                    </span>
                  </span>
                  {cat === "files" && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--warning, #d69e2e)",
                        background: "var(--warning-bg, #fffff0)",
                        padding: "1px 6px",
                        borderRadius: 4,
                        border: "1px solid currentColor",
                      }}
                    >
                      uncertain
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px 26px" }}>
                  {CATEGORY_DESCRIPTIONS[cat]}
                </p>

                {/* File rows */}
                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    overflow: "hidden",
                  }}
                >
                  {files.map((file, i) => (
                    <div
                      key={file.path}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        padding: "10px 14px",
                        borderTop: i > 0 ? "1px solid var(--border)" : "none",
                        background: selected.has(file.path)
                          ? "var(--bg-selected, rgba(66, 153, 225, 0.08))"
                          : "var(--bg-primary)",
                        cursor: "pointer",
                      }}
                      onClick={() => toggleFile(file.path)}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(file.path)}
                        onChange={() => toggleFile(file.path)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ marginTop: 2, cursor: "pointer", flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: "monospace",
                            fontSize: 12,
                            color: "var(--text-primary)",
                            wordBreak: "break-all",
                          }}
                        >
                          {file.path}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            marginTop: 3,
                          }}
                        >
                          {file.reason}
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                          textAlign: "right",
                        }}
                      >
                        <div>{formatBytes(file.size_bytes)}</div>
                        <div style={{ marginTop: 2 }}>{formatDate(file.last_modified)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Confirmation modal */}
      {confirmPaths !== null && (
        <ConfirmModal
          paths={confirmPaths}
          totalBytes={
            scanResult
              ? allUnused(scanResult)
                  .filter((f) => confirmPaths.includes(f.path))
                  .reduce((s, f) => s + f.size_bytes, 0)
              : 0
          }
          onConfirm={() => executeDelete(confirmPaths)}
          onCancel={() => setConfirmPaths(null)}
        />
      )}

      {/* Toast notification */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "10px 16px",
            fontSize: 13,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 1000,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
