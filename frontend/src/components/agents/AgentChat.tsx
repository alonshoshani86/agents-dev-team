import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useAgentChat } from "../../hooks/useAgentChat";
import { ToolApproval } from "./ToolApproval";

interface Props {
  projectId: string;
  agentName: string;
  agentDisplayName: string;
}

export function AgentChat({ projectId, agentName, agentDisplayName }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const {
    messages,
    streaming,
    pendingApproval,
    sendMessage,
    approveAction,
    denyAction,
    connect,
    disconnect,
    clearMessages,
  } = useAgentChat(projectId, agentName);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [projectId, agentName, connect, disconnect]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pendingApproval]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [agentName, pendingApproval]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || streaming) return;
    sendMessage(input.trim());
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="terminal">
      <div className="terminal-header">
        <div className="terminal-dots">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>
        <span className="terminal-title">{agentDisplayName} Agent</span>
        <div className="terminal-header-right">
          {streaming && <span className="terminal-streaming">Streaming...</span>}
          <button className="terminal-btn" onClick={clearMessages}>Clear</button>
        </div>
      </div>

      <div className="terminal-body" ref={scrollRef}>
        {messages.length === 0 && !pendingApproval && (
          <div className="terminal-welcome">
            <div className="terminal-welcome-title">{agentDisplayName} Agent</div>
            <div className="terminal-welcome-sub">
              Type a message to start working with this agent.
              <br />
              The agent will ask for approval before executing any code or file changes.
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`terminal-msg ${msg.role}`}>
            {msg.role === "user" ? (
              <div className="terminal-user-line">
                <span className="terminal-prompt">&gt;</span>
                <span>{msg.content}</span>
              </div>
            ) : (
              <div className="terminal-assistant">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || "");
                      const codeStr = String(children).replace(/\n$/, "");
                      if (match) {
                        return (
                          <div className="terminal-code-block">
                            <div className="terminal-code-header">
                              <span>{match[1]}</span>
                              <button
                                className="terminal-copy-btn"
                                onClick={() => navigator.clipboard.writeText(codeStr)}
                              >
                                Copy
                              </button>
                            </div>
                            <SyntaxHighlighter
                              style={vscDarkPlus}
                              language={match[1]}
                              PreTag="div"
                              customStyle={{
                                margin: 0,
                                borderRadius: "0 0 6px 6px",
                                fontSize: 12,
                              }}
                            >
                              {codeStr}
                            </SyntaxHighlighter>
                          </div>
                        );
                      }
                      return (
                        <code className="terminal-inline-code" {...props}>
                          {children}
                        </code>
                      );
                    },
                  }}
                >
                  {msg.content || (streaming && i === messages.length - 1 ? "..." : "")}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ))}

        {pendingApproval && (
          <ToolApproval
            action={pendingApproval}
            onApprove={approveAction}
            onDeny={denyAction}
          />
        )}
      </div>

      <form className="terminal-input-area" onSubmit={handleSubmit}>
        <span className="terminal-input-prompt">&gt;</span>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={pendingApproval ? "Approve or deny the action above..." : `Message ${agentDisplayName}...`}
          disabled={streaming || !!pendingApproval}
          rows={1}
        />
      </form>
    </div>
  );
}
