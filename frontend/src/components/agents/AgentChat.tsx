import { useState, useEffect, useRef, memo } from "react";
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

interface Message {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// MessageItem — memoized so it never re-renders during streaming
// ---------------------------------------------------------------------------
const MessageItem = memo(function MessageItem({ msg }: { msg: Message }) {
  if (msg.role === "user") {
    return (
      <div className="terminal-msg user">
        <div className="terminal-user-line">
          <span className="terminal-prompt">&gt;</span>
          <span>{msg.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-msg assistant">
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
                      customStyle={{ margin: 0, borderRadius: "0 0 6px 6px", fontSize: 12 }}
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
          {msg.content}
        </ReactMarkdown>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// MessageList — memoized so it only re-renders when completedMessages changes
// (once per full exchange, not on every chunk)
// ---------------------------------------------------------------------------
const MessageList = memo(function MessageList({ messages }: { messages: Message[] }) {
  return (
    <>
      {messages.map((msg, i) => (
        <MessageItem key={i} msg={msg} />
      ))}
    </>
  );
});

// ---------------------------------------------------------------------------
// StreamingMessage — plain <pre> so no ReactMarkdown overhead during streaming
// Only this component re-renders on each RAF tick (~60fps)
// ---------------------------------------------------------------------------
function StreamingMessage({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="terminal-msg assistant">
      <pre className="terminal-assistant terminal-streaming-pre">{content}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatInput — memoized; only re-renders when isStreaming or pendingApproval changes
// ---------------------------------------------------------------------------
const ChatInput = memo(function ChatInput({
  inputRef,
  input,
  setInput,
  isStreaming,
  pendingApproval,
  agentDisplayName,
  onSubmit,
  onKeyDown,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  input: string;
  setInput: (v: string) => void;
  isStreaming: boolean;
  pendingApproval: boolean;
  agentDisplayName: string;
  onSubmit: (e: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <form className="terminal-input-area" onSubmit={onSubmit}>
      <span className="terminal-input-prompt">&gt;</span>
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          pendingApproval
            ? "Approve or deny the action above..."
            : `Message ${agentDisplayName}...`
        }
        rows={1}
      />
      {/* Send button is always active — never disabled */}
      <button type="submit" className="terminal-send-btn">
        Send
      </button>
    </form>
  );
});

// ---------------------------------------------------------------------------
// AgentChat — main component
// ---------------------------------------------------------------------------
export function AgentChat({ projectId, agentName, agentDisplayName }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    completedMessages,
    streamingContent,
    isStreaming,
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

  // Auto-scroll on new completed messages, streaming updates, or tool approvals
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [completedMessages, streamingContent, pendingApproval]);

  // Auto-focus after agent changes or state transitions
  useEffect(() => {
    inputRef.current?.focus();
  }, [agentName]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage(input.trim());
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  const isEmpty = completedMessages.length === 0 && !streamingContent && !pendingApproval;

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
          {isStreaming && <span className="terminal-streaming">Streaming...</span>}
          <button className="terminal-btn" onClick={clearMessages}>
            Clear
          </button>
        </div>
      </div>

      <div className="terminal-body" ref={scrollRef}>
        {isEmpty && (
          <div className="terminal-welcome">
            <div className="terminal-welcome-title">{agentDisplayName} Agent</div>
            <div className="terminal-welcome-sub">
              Type a message to start working with this agent.
              <br />
              The agent will ask for approval before executing any code or file changes.
            </div>
          </div>
        )}

        {/* Completed messages — only re-render when a new one is added */}
        <MessageList messages={completedMessages} />

        {/* Live streaming output — plain <pre>, no ReactMarkdown overhead */}
        <StreamingMessage content={streamingContent} />

        {pendingApproval && (
          <ToolApproval
            action={pendingApproval}
            onApprove={approveAction}
            onDeny={denyAction}
          />
        )}
      </div>

      <ChatInput
        inputRef={inputRef}
        input={input}
        setInput={setInput}
        isStreaming={isStreaming}
        pendingApproval={!!pendingApproval}
        agentDisplayName={agentDisplayName}
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
