import { useState, useRef, useCallback } from "react";
import type { PendingAction } from "../components/agents/ToolApproval";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export function useAgentChat(projectId: string | null, agentName: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingAction | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentResponseRef = useRef("");

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
        currentResponseRef.current = "";
        setStreaming(true);
        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      } else if (data.type === "chunk") {
        currentResponseRef.current += data.content;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: currentResponseRef.current,
          };
          return updated;
        });
      } else if (data.type === "done") {
        setStreaming(false);
      } else if (data.type === "error") {
        setStreaming(false);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.content}` },
        ]);
      } else if (data.type === "tool_request") {
        // Agent wants to execute a tool — needs approval
        setStreaming(false);
        setPendingApproval({
          id: data.id,
          type: data.action_type,
          description: data.description,
          details: data.details || {},
        });
      } else if (data.type === "tool_result") {
        // Tool execution result after approval
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `**${data.action_type}** ${data.success ? "completed" : "failed"}${data.output ? `\n\n\`\`\`\n${data.output}\n\`\`\`` : ""}`,
          },
        ]);
      }
    };

    ws.onerror = () => {
      setStreaming(false);
    };

    wsRef.current = ws;
  }, [projectId, agentName]);

  const sendMessage = useCallback(
    (message: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect();
        setTimeout(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            setMessages((prev) => [...prev, { role: "user", content: message }]);
            wsRef.current.send(JSON.stringify({ type: "message", message }));
          }
        }, 500);
        return;
      }

      setMessages((prev) => [...prev, { role: "user", content: message }]);
      wsRef.current.send(JSON.stringify({ type: "message", message }));
    },
    [connect]
  );

  const approveAction = useCallback(() => {
    if (!wsRef.current || !pendingApproval) return;
    wsRef.current.send(
      JSON.stringify({ type: "tool_approve", id: pendingApproval.id })
    );
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `Approved: ${pendingApproval.description}` },
    ]);
    setPendingApproval(null);
    setStreaming(true);
  }, [pendingApproval]);

  const denyAction = useCallback(() => {
    if (!wsRef.current || !pendingApproval) return;
    wsRef.current.send(
      JSON.stringify({ type: "tool_deny", id: pendingApproval.id })
    );
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `Denied: ${pendingApproval.description}` },
    ]);
    setPendingApproval(null);
  }, [pendingApproval]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setPendingApproval(null);
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  return {
    messages,
    streaming,
    pendingApproval,
    sendMessage,
    approveAction,
    denyAction,
    connect,
    disconnect,
    clearMessages,
  };
}
