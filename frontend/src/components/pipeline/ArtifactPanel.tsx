import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { api } from "../../api/client";
import type { Artifact } from "../../types";

interface ArtifactPanelProps {
  projectId: string;
  taskId: string;
}

interface RunMeta {
  run: number;
  agent: string;
  timestamp: string;
}

const ARTIFACT_LABELS: Record<string, string> = {
  spec: "Product Spec",
  architecture: "Architecture",
  implementation: "Implementation",
  "test-plan": "Test Plan",
  "ui-review": "UI Review",
};

export function ArtifactPanel({ projectId, taskId }: ArtifactPanelProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // Run selector state — selectedRun is either an integer run number or "all"
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [runCount, setRunCount] = useState<number>(1);
  const [selectedRun, setSelectedRun] = useState<number | "all">(1);
  const [displayContent, setDisplayContent] = useState<string>("");
  const [contentLoading, setContentLoading] = useState(false);

  // Track whether we're in the middle of the initial tab-load to avoid a
  // redundant second fetch triggered by the selectedRun effect.
  const initialLoadRef = useRef(false);

  // Load artifact list on mount / task change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.taskArtifacts(projectId, taskId).then((arts) => {
      if (!cancelled) {
        setArtifacts(arts);
        setSelectedIdx(0);
        setEditing(false);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, taskId]);

  const selected = artifacts[selectedIdx] || null;

  // When the selected artifact tab changes, fetch run metadata + latest content
  useEffect(() => {
    if (!selected) {
      setRuns([]);
      setRunCount(1);
      setSelectedRun(1);
      setDisplayContent("");
      return;
    }

    let cancelled = false;
    initialLoadRef.current = true; // suppress the selectedRun effect this cycle

    async function loadRunsAndContent() {
      setContentLoading(true);
      try {
        // Fetch run metadata
        const runsData = await api.artifactRuns(projectId, taskId, selected!.type);
        if (cancelled) return;
        setRuns(runsData.runs);
        setRunCount(runsData.run_count);

        // Default to latest run (actual integer, not "latest" string, so tab highlight works)
        const latestRunNum = runsData.run_count;
        setSelectedRun(latestRunNum);

        // Fetch latest run content
        const contentData = await api.artifactContent(projectId, taskId, selected!.type, "latest");
        if (cancelled) return;
        setDisplayContent(contentData.content);
      } catch {
        if (!cancelled) {
          // Fall back to full content from artifact list
          setDisplayContent(selected?.content ?? "");
          setRuns([]);
          setRunCount(1);
          setSelectedRun(1);
        }
      } finally {
        if (!cancelled) {
          setContentLoading(false);
          initialLoadRef.current = false;
        }
      }
    }

    loadRunsAndContent();
    return () => { cancelled = true; };
  }, [projectId, taskId, selectedIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // When selectedRun changes due to user clicking a run tab, fetch that run's content.
  // Skip if we're in the middle of the initial tab-load (which already fetches content).
  useEffect(() => {
    if (!selected) return;
    if (initialLoadRef.current) return; // tab-switch already handled above

    let cancelled = false;

    async function loadContent() {
      setContentLoading(true);
      try {
        const runParam = selectedRun === "all" ? undefined : selectedRun;
        const contentData = await api.artifactContent(projectId, taskId, selected!.type, runParam);
        if (!cancelled) setDisplayContent(contentData.content);
      } catch {
        if (!cancelled) setDisplayContent(selected?.content ?? "");
      } finally {
        if (!cancelled) setContentLoading(false);
      }
    }

    loadContent();
    return () => { cancelled = true; };
  }, [selectedRun]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSelectTab(idx: number) {
    setSelectedIdx(idx);
    setEditing(false);
  }

  function handleSelectRun(run: number | "all") {
    setSelectedRun(run);
    setEditing(false);
  }

  function handleStartEdit() {
    if (!selected) return;
    setEditContent(displayContent);
    setEditing(true);
  }

  function handleCancelEdit() {
    setEditing(false);
    setEditContent("");
  }

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await api.updateArtifact(
        projectId, taskId, selected.type, editContent
      );
      // Refresh run list after human edit (adds a new "human" run)
      const runsData = await api.artifactRuns(projectId, taskId, selected.type);
      setRuns(runsData.runs);
      setRunCount(runsData.run_count);
      setSelectedRun(runsData.run_count); // select new latest run

      // Update artifacts list with new full content for backward-compat
      setArtifacts((prev) =>
        prev.map((a, i) => (i === selectedIdx ? { ...a, content: updated.content } : a))
      );
      setDisplayContent(editContent);
      setEditing(false);
    } catch (err) {
      console.error("Failed to save artifact:", err);
    } finally {
      setSaving(false);
    }
  }

  // Edit is only enabled when viewing the latest run or all content
  const canEdit = selectedRun === runCount || selectedRun === "all";

  if (loading) {
    return <div className="artifact-panel-empty">Loading artifacts...</div>;
  }

  if (artifacts.length === 0) {
    return <div className="artifact-panel-empty">No artifacts yet. Run the pipeline to generate specs, architecture docs, and code.</div>;
  }

  return (
    <div className="artifact-panel">
      {/* Artifact type tabs */}
      <div className="artifact-tabs">
        {artifacts.map((art, i) => (
          <button
            key={art.type}
            className={`artifact-tab ${i === selectedIdx ? "active" : ""}`}
            onClick={() => handleSelectTab(i)}
          >
            <span className="artifact-tab-label">
              {ARTIFACT_LABELS[art.type] || art.type}
            </span>
            <span className="artifact-tab-meta">
              {art.agent}
            </span>
          </button>
        ))}
      </div>

      {/* Run selector — only shown when there are multiple runs */}
      {runCount > 1 && (
        <div className="artifact-run-tabs">
          {runs.map((r) => (
            <button
              key={r.run}
              className={`artifact-tab artifact-run-tab ${selectedRun === r.run ? "active" : ""}`}
              onClick={() => handleSelectRun(r.run)}
              title={r.timestamp ? `${r.agent} · ${new Date(r.timestamp).toLocaleString()}` : r.agent}
            >
              {selectedRun === r.run && <span className="run-tab-check">✓ </span>}
              Run {r.run}
            </button>
          ))}
          <button
            className={`artifact-tab artifact-run-tab ${selectedRun === "all" ? "active" : ""}`}
            onClick={() => handleSelectRun("all")}
          >
            {selectedRun === "all" && <span className="run-tab-check">✓ </span>}
            All Runs
          </button>
        </div>
      )}

      {/* Artifact content */}
      {selected && (
        <div className="artifact-content">
          <div className="artifact-content-header">
            <span className="artifact-title">
              {ARTIFACT_LABELS[selected.type] || selected.type}
            </span>
            <span className="artifact-meta">
              by {selected.agent} &middot; {new Date(selected.created_at).toLocaleString()}
            </span>
            <div className="artifact-actions">
              {editing ? (
                <>
                  <button className="btn-artifact-save" onClick={handleSave} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button className="btn-artifact-cancel" onClick={handleCancelEdit} disabled={saving}>
                    Cancel
                  </button>
                </>
              ) : (
                canEdit && (
                  <button className="btn-artifact-edit" onClick={handleStartEdit}>
                    Edit
                  </button>
                )
              )}
            </div>
          </div>

          {contentLoading ? (
            <div className="artifact-panel-empty">Loading...</div>
          ) : editing ? (
            <textarea
              className="artifact-editor"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              disabled={saving}
            />
          ) : (
            <div className="artifact-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    const codeStr = String(children).replace(/\n$/, "");
                    if (match) {
                      return (
                        <SyntaxHighlighter
                          style={vscDarkPlus}
                          language={match[1]}
                          PreTag="div"
                          customStyle={{ borderRadius: 6, fontSize: 12 }}
                        >
                          {codeStr}
                        </SyntaxHighlighter>
                      );
                    }
                    return <code className="terminal-inline-code" {...props}>{children}</code>;
                  },
                }}
              >
                {displayContent}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
