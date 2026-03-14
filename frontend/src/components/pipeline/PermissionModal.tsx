import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useStore } from "../../stores/useStore";
import { api } from "../../api/client";

const CATEGORY_ICONS: Record<string, string> = {
  read: "👁",
  write: "✏️",
  execute: "⚡",
  other: "🔧",
};

const CATEGORY_LABELS: Record<string, string> = {
  read: "Read",
  write: "Write",
  execute: "Execute",
  other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  read: "#58a6ff",
  write: "#f0883e",
  execute: "#f85149",
  other: "#8b949e",
};

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", json: "json", md: "markdown", css: "css",
    html: "html", yaml: "yaml", yml: "yaml", sh: "bash",
  };
  return map[ext] || "text";
}

interface Props {
  projectId: string;
}

export function PermissionModal({ projectId }: Props) {
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const removePermissionRequest = useStore((s) => s.removePermissionRequest);
  const setAutoApprove = useStore((s) => s.setAutoApprove);
  const [responding, setResponding] = useState<string | null>(null);

  if (pendingPermissions.length === 0) return null;

  const current = pendingPermissions[0];
  const toolInput = current.toolInput || {};

  async function handleRespond(behavior: "allow" | "deny") {
    setResponding(behavior);
    try {
      await api.respondPermission(projectId, current.taskId, current.id, behavior);
      removePermissionRequest(current.id);
    } catch (err) {
      console.error("Failed to respond to permission:", err);
    } finally {
      setResponding(null);
    }
  }

  // Auto-approve all queued permissions matching a category (or "all")
  async function handleAutoApprove(category: string) {
    setAutoApprove(category);
    // Approve all currently pending permissions that match
    const store = useStore.getState();
    for (const perm of store.pendingPermissions) {
      if (category === "all" || perm.category === category) {
        api.respondPermission(projectId, perm.taskId, perm.id, "allow").catch(console.error);
        removePermissionRequest(perm.id);
      }
    }
  }

  const filePath = (toolInput.file_path as string) || "";
  const command = (toolInput.command as string) || "";
  const content = (toolInput.content as string) || "";
  const pattern = (toolInput.pattern as string) || "";
  const oldString = (toolInput.old_string as string) || "";
  const newString = (toolInput.new_string as string) || "";

  return (
    <div className="permission-overlay">
      <div className="permission-modal">
        <div className="permission-header">
          <span
            className="permission-category-badge"
            style={{ backgroundColor: CATEGORY_COLORS[current.category] || "#8b949e" }}
          >
            {CATEGORY_ICONS[current.category] || "?"}{" "}
            {CATEGORY_LABELS[current.category] || current.category}
          </span>
          <span className="permission-agent-badge">{current.agent}</span>
          <span className="permission-tool-name">{current.toolName}</span>
          {pendingPermissions.length > 1 && (
            <span className="permission-queue-badge">
              +{pendingPermissions.length - 1} more
            </span>
          )}
        </div>

        <div className="permission-summary">{current.summary}</div>

        <div className="permission-details">
          {/* File path */}
          {filePath && (
            <div className="permission-detail-row">
              <span className="permission-detail-label">File:</span>
              <code className="permission-detail-path">{filePath}</code>
            </div>
          )}

          {/* Bash command */}
          {command && (
            <div className="permission-command-block">
              <div className="permission-command-header">Command</div>
              <pre className="permission-command">{command}</pre>
            </div>
          )}

          {/* Search pattern */}
          {pattern && (
            <div className="permission-detail-row">
              <span className="permission-detail-label">Pattern:</span>
              <code className="permission-detail-value">{pattern}</code>
            </div>
          )}

          {/* File content (for Write) */}
          {content && current.toolName === "Write" && (
            <div className="permission-code-block">
              <div className="permission-code-header">Content to write</div>
              <SyntaxHighlighter
                style={vscDarkPlus}
                language={guessLanguage(filePath)}
                PreTag="div"
                customStyle={{ margin: 0, borderRadius: "0 0 6px 6px", fontSize: 12, maxHeight: 250 }}
              >
                {content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content}
              </SyntaxHighlighter>
            </div>
          )}

          {/* Edit diff */}
          {oldString && current.toolName === "Edit" && (
            <div className="permission-code-block">
              <div className="permission-code-header">Edit</div>
              <div className="permission-diff">
                <div className="permission-diff-old">
                  <span className="diff-label">- Remove:</span>
                  <pre>{oldString.length > 500 ? oldString.slice(0, 500) + "..." : oldString}</pre>
                </div>
                <div className="permission-diff-new">
                  <span className="diff-label">+ Add:</span>
                  <pre>{newString.length > 500 ? newString.slice(0, 500) + "..." : newString}</pre>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="permission-actions">
          <button
            className="permission-btn allow"
            onClick={() => handleRespond("allow")}
            disabled={responding !== null}
          >
            {responding === "allow" ? "Allowing..." : "Allow"}
          </button>
          <button
            className="permission-btn deny"
            onClick={() => handleRespond("deny")}
            disabled={responding !== null}
          >
            {responding === "deny" ? "Denying..." : "Deny"}
          </button>
        </div>
        <div className="permission-session-actions">
          <span className="permission-session-label">Auto-approve for this session:</span>
          <button
            className="permission-session-btn"
            onClick={() => handleAutoApprove(current.category)}
            disabled={responding !== null}
          >
            All {CATEGORY_LABELS[current.category] || current.category}
          </button>
          <button
            className="permission-session-btn allow-all"
            onClick={() => handleAutoApprove("all")}
            disabled={responding !== null}
          >
            Allow Everything
          </button>
        </div>
      </div>
    </div>
  );
}
