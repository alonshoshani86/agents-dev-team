import { useEffect, useState } from "react";
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

  function handleStartEdit() {
    if (!selected) return;
    setEditContent(selected.content);
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
        projectId, taskId, selected.type, selected.version, editContent
      );
      // Update local state
      setArtifacts((prev) =>
        prev.map((a, i) => (i === selectedIdx ? { ...a, content: updated.content } : a))
      );
      setEditing(false);
    } catch (err) {
      console.error("Failed to save artifact:", err);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="artifact-panel-empty">Loading artifacts...</div>;
  }

  if (artifacts.length === 0) {
    return <div className="artifact-panel-empty">No artifacts yet. Run the pipeline to generate specs, architecture docs, and code.</div>;
  }

  return (
    <div className="artifact-panel">
      {/* Artifact tabs */}
      <div className="artifact-tabs">
        {artifacts.map((art, i) => (
          <button
            key={`${art.type}-v${art.version}`}
            className={`artifact-tab ${i === selectedIdx ? "active" : ""}`}
            onClick={() => { setSelectedIdx(i); setEditing(false); }}
          >
            <span className="artifact-tab-label">
              {ARTIFACT_LABELS[art.type] || art.type}
            </span>
            <span className="artifact-tab-meta">
              v{art.version} &middot; {art.agent}
            </span>
          </button>
        ))}
      </div>

      {/* Artifact content */}
      {selected && (
        <div className="artifact-content">
          <div className="artifact-content-header">
            <span className="artifact-title">
              {ARTIFACT_LABELS[selected.type] || selected.type} v{selected.version}
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
                <button className="btn-artifact-edit" onClick={handleStartEdit}>
                  Edit
                </button>
              )}
            </div>
          </div>

          {editing ? (
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
                {selected.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
