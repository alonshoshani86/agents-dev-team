import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

export interface PendingAction {
  id: string;
  type: "write_file" | "edit_file" | "run_command" | "delete_file";
  description: string;
  details: {
    path?: string;
    content?: string;
    command?: string;
    diff?: string;
  };
}

interface Props {
  action: PendingAction;
  onApprove: () => void;
  onDeny: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  write_file: "Write File",
  edit_file: "Edit File",
  run_command: "Run Command",
  delete_file: "Delete File",
};

const ACTION_ICONS: Record<string, string> = {
  write_file: "+",
  edit_file: "~",
  run_command: "$",
  delete_file: "-",
};

export function ToolApproval({ action, onApprove, onDeny }: Props) {
  const label = ACTION_LABELS[action.type] || action.type;
  const icon = ACTION_ICONS[action.type] || "?";

  return (
    <div className="tool-approval">
      <div className="tool-approval-header">
        <span className={`tool-approval-icon ${action.type}`}>{icon}</span>
        <span className="tool-approval-label">{label}</span>
        <span className="tool-approval-desc">{action.description}</span>
      </div>

      <div className="tool-approval-details">
        {action.details.path && (
          <div className="tool-approval-path">{action.details.path}</div>
        )}

        {action.details.command && (
          <div className="tool-approval-command">
            <span className="tool-approval-command-prompt">$</span>
            {action.details.command}
          </div>
        )}

        {action.details.content && (
          <div className="tool-approval-content">
            <SyntaxHighlighter
              style={vscDarkPlus}
              language={guessLanguage(action.details.path || "")}
              PreTag="div"
              customStyle={{ margin: 0, borderRadius: 4, fontSize: 12, maxHeight: 300 }}
            >
              {action.details.content}
            </SyntaxHighlighter>
          </div>
        )}

        {action.details.diff && (
          <div className="tool-approval-diff">
            <pre>{action.details.diff}</pre>
          </div>
        )}
      </div>

      <div className="tool-approval-actions">
        <button className="tool-approval-btn approve" onClick={onApprove}>
          Allow
        </button>
        <button className="tool-approval-btn deny" onClick={onDeny}>
          Deny
        </button>
        <span className="tool-approval-hint">
          Review the action before approving
        </span>
      </div>
    </div>
  );
}

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", json: "json", md: "markdown", css: "css",
    html: "html", yaml: "yaml", yml: "yaml", sh: "bash",
    sql: "sql", rs: "rust", go: "go", java: "java",
  };
  return map[ext] || "text";
}
