import { useState, useRef, useCallback } from "react";
import type { PendingAction } from "../components/agents/ToolApproval";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export function useAgentChat(projectId: string | null, agentName: string | null) {
  // completedMessages only changes on "done" / "error" / "tool_result" — not on every chunk
  const [completedMessages, setCompletedMessages] = useState<Message[]>([]);
  // streamingContent is updated via RAF at ~60fps during streaming
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingAction | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Raw accumulator — mutated on every chunk, never triggers re-render directly
  const streamingRef = useRef<string>("");
  // RAF handle so we don't schedule more than one frame at a time
  const rafHandleRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    if (!projectId || !agentName) return;

    if (wsRef.current) {
      wsRef.current.close();
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/projects/${projectId}/agents/${agentName}/stream`
    );

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "start") {
        streamingRef.current = "";
        setIsStreaming(true);
        setStreamingContent("");
      } else if (data.type === "chunk") {
        streamingRef.current += data.content;
        // Batch DOM updates via RAF — at most one state update per frame (~60fps)
        if (!rafHandleRef.current) {
          rafHandleRef.current = requestAnimationFrame(() => {
            setStreamingContent(streamingRef.current);
            rafHandleRef.current = null;
          });
        }
      } else if (data.type === "done") {
        // Cancel any pending RAF flush before we finalize
        if (rafHandleRef.current) {
          cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        const finalContent = streamingRef.current;
        streamingRef.current = "";
        setStreamingContent("");
        setIsStreaming(false);
        if (finalContent) {
          setCompletedMessages((prev) => [
            ...prev,
            { role: "assistant", content: finalContent },
          ]);
        }
      } else if (data.type === "error") {
        if (rafHandleRef.current) {
          cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        streamingRef.current = "";
        setIsStreaming(false);
        setStreamingContent("");
        setCompletedMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.content}` },
        ]);
      } else if (data.type === "tool_request") {
        // Agent wants to execute a tool — needs approval
        if (rafHandleRef.current) {
          cancelAnimationFrame(rafHandleRef.current);
          rafHandleRef.current = null;
        }
        setIsStreaming(false);
        setPendingApproval({
          id: data.id,
          type: data.action_type,
          description: data.description,
          details: data.details || {},
        });
      } else if (data.type === "tool_result") {
        // Tool execution result after approval
        setCompletedMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `**${data.action_type}** ${data.success ? "completed" : "failed"}${data.output ? `\n\n\`\`\`\n${data.output}\n\`\`\`` : ""}`,
          },
        ]);
      }
    };

    ws.onerror = () => {
      setIsStreaming(false);
    };

    wsRef.current = ws;
  }, [projectId, agentName]);

  const sendMessage = useCallback(
    (message: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect();
        setTimeout(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            setCompletedMessages((prev) => [...prev, { role: "user", content: message }]);
            wsRef.current.send(JSON.stringify({ type: "message", message }));
          }
        }, 500);
        return;
      }

      setCompletedMessages((prev) => [...prev, { role: "user", content: message }]);
      wsRef.current.send(JSON.stringify({ type: "message", message }));
    },
    [connect]
  );

  const approveAction = useCallback(() => {
    if (!wsRef.current || !pendingApproval) return;
    wsRef.current.send(
      JSON.stringify({ type: "tool_approve", id: pendingApproval.id })
    );
    setCompletedMessages((prev) => [
      ...prev,
      { role: "user", content: `Approved: ${pendingApproval.description}` },
    ]);
    setPendingApproval(null);
    setIsStreaming(true);
  }, [pendingApproval]);

  const denyAction = useCallback(() => {
    if (!wsRef.current || !pendingApproval) return;
    wsRef.current.send(
      JSON.stringify({ type: "tool_deny", id: pendingApproval.id })
    );
    setCompletedMessages((prev) => [
      ...prev,
      { role: "user", content: `Denied: ${pendingApproval.description}` },
    ]);
    setPendingApproval(null);
  }, [pendingApproval]);

  const clearMessages = useCallback(() => {
    setCompletedMessages([]);
    setStreamingContent("");
    streamingRef.current = "";
    setPendingApproval(null);
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  return {
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
  };
}
