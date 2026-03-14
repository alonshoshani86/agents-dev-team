import { useEffect } from "react";
import { useStore } from "../stores/useStore";
import type { AgentTerminalState } from "../stores/useStore";
import { api } from "../api/client";

const AGENT_DISPLAY: Record<string, string> = {
  product: "Product",
  architect: "Architect",
  dev: "Dev",
  test: "Test",
  uxui: "UX/UI",
};

const EMPTY_TERMINAL: AgentTerminalState = {
  messages: [],
  streaming: false,
  status: "idle",
};

let chunkCount = 0;

// Chunk buffer: accumulate text chunks and flush at most every 80ms
const chunkBuffer: Record<string, string> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushFn: (() => void) | null = null;

function bufferChunk(agent: string, content: string) {
  chunkBuffer[agent] = (chunkBuffer[agent] ?? "") + content;
  if (!flushTimer && flushFn) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushFn?.();
    }, 80);
  }
}

export function usePipelineEvents(projectId: string | null) {
  useEffect(() => {
    console.log("[PipelineEvents] Hook called, projectId:", projectId);
    if (!projectId) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      if (ws && ws.readyState <= 1) {
        ws.close();
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/ws/projects/${projectId}/events`;
      console.log("[PipelineEvents] Connecting to", url);
      const newWs = new WebSocket(url);

      newWs.onopen = () => {
        console.log("[PipelineEvents] Connected");
        chunkCount = 0;
      };

    newWs.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("[PipelineEvents] RAW EVENT:", data.type, "agent:", data.agent, "content:", String(data.content || "").substring(0, 50));
      const store = useStore.getState();
      const taskId = data.task_id as string | undefined;

      // Helper: update terminals for the correct task (active or cached)
      function updateTerminals(
        updater: (snap: { agentTerminals: Record<string, AgentTerminalState> }) => Partial<{ agentTerminals: Record<string, AgentTerminalState>; pipelineWaitingInput: boolean; pipelineChoosingAgent: boolean; suggestedNextAgent: string | null; askingAgent: boolean; pipelineAgentTab: string | null }>
      ) {
        if (taskId) {
          store._updateTaskTerminals(taskId, updater);
        }
      }

      // Set up the chunk flush function — batches many chunks into one store update
      flushFn = () => {
        const agents = Object.keys(chunkBuffer);
        if (agents.length === 0) return;
        const tid = taskId;
        if (!tid) return;
        const buffered = { ...chunkBuffer };
        for (const a of agents) delete chunkBuffer[a];

        const s = useStore.getState();
        s._updateTaskTerminals(tid, (snap) => {
          const updated = { ...snap.agentTerminals };
          for (const [agent, content] of Object.entries(buffered)) {
            const terminal = updated[agent] || { ...EMPTY_TERMINAL, messages: [] };
            const msgs = [...terminal.messages];
            if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: msgs[msgs.length - 1].content + content,
              };
            } else {
              msgs.push({ role: "assistant", content });
            }
            updated[agent] = { ...terminal, messages: msgs, streaming: true };
          }
          return { agentTerminals: updated };
        });
      };

      switch (data.type) {
        case "task_started":
          store.clearContextUsage();
          if (store.activeProjectId) {
            store.fetchTasks(store.activeProjectId);
          }
          break;

        case "step_started": {
          const agent = data.agent as string;
          const display = AGENT_DISPLAY[agent] || agent;
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  status: "working",
                  streaming: true,
                  messages: [...terminal.messages, { role: "system", content: `Starting ${display} agent...` }],
                },
              },
              pipelineAgentTab: agent,
            };
          });
          if (store.activeProjectId) {
            store.fetchTasks(store.activeProjectId);
          }
          break;
        }

        case "step_chunk": {
          const agent = data.agent as string;
          const content = data.content as string;
          chunkCount++;
          if (chunkCount <= 5 || chunkCount % 100 === 0) {
            console.log(`[PipelineEvents] CHUNK #${chunkCount} agent=${agent} len=${content.length}`);
          }
          bufferChunk(agent, content);
          break;
        }

        case "thinking_start": {
          const agent = data.agent as string;
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  messages: [...terminal.messages, { role: "thinking", content: "" }],
                },
              },
            };
          });
          break;
        }

        case "thinking_chunk": {
          const agent = data.agent as string;
          const content = data.content as string;
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            const msgs = [...terminal.messages];
            if (msgs.length > 0 && msgs[msgs.length - 1].role === "thinking") {
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: msgs[msgs.length - 1].content + content,
              };
            } else {
              msgs.push({ role: "thinking", content });
            }
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: { ...terminal, messages: msgs },
              },
            };
          });
          break;
        }

        case "tool_start": {
          const agent = data.agent as string;
          const toolName = data.toolName as string;
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  messages: [...terminal.messages, { role: "tool", content: `▶ ${toolName}` }],
                },
              },
            };
          });
          break;
        }

        case "tool_end": {
          const agent = data.agent as string;
          const summary = data.summary as string;
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            const msgs = [...terminal.messages];
            // Update the last tool message with the summary
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "tool" && msgs[i].content.startsWith("▶")) {
                msgs[i] = { ...msgs[i], content: `✓ ${summary}` };
                break;
              }
            }
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: { ...terminal, messages: msgs },
              },
            };
          });
          break;
        }

        case "tool_result": {
          const agent = data.agent as string;
          const toolName = data.toolName as string;
          const preview = data.preview as string;
          if (preview) {
            updateTerminals((snap) => {
              const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
              return {
                agentTerminals: {
                  ...snap.agentTerminals,
                  [agent]: {
                    ...terminal,
                    messages: [...terminal.messages, { role: "tool", content: `⇐ ${toolName}: ${preview}` }],
                  },
                },
              };
            });
          }
          break;
        }

        case "step_completed": {
          // Flush any buffered chunks before marking complete
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          flushFn?.();
          const agent = data.agent as string;
          const display = AGENT_DISPLAY[agent] || agent;
          const nextAgent = data.next_agent as string | undefined;
          const msg = nextAgent
            ? `${display} completed. Routing to ${AGENT_DISPLAY[nextAgent] || nextAgent}...`
            : `${display} agent completed.`;
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  status: "done",
                  streaming: false,
                  messages: [...terminal.messages, { role: "system", content: msg }],
                },
              },
            };
          });
          if (store.activeProjectId) {
            store.fetchTasks(store.activeProjectId);
          }
          break;
        }

        case "choose_next_agent": {
          const agent = data.agent as string;
          const suggested = data.suggested_agent as string | undefined;
          const display = AGENT_DISPLAY[agent] || agent;
          console.log("[PipelineEvents] Choose next agent. Suggested:", suggested);
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              pipelineChoosingAgent: true,
              suggestedNextAgent: suggested || null,
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  messages: [...terminal.messages, { role: "system", content: `${display} finished. Choose which agent to run next.` }],
                },
              },
            };
          });
          if (store.activeProjectId) {
            store.fetchTasks(store.activeProjectId);
          }
          break;
        }

        case "next_agent_chosen": {
          updateTerminals(() => ({
            pipelineChoosingAgent: false,
          }));
          break;
        }

        case "pipeline_needs_input": {
          const agent = data.agent as string;
          console.log("[PipelineEvents] Pipeline paused — needs input from user");
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              pipelineWaitingInput: true,
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  status: "done",
                  streaming: false,
                  messages: [...terminal.messages, { role: "system", content: "Pipeline paused: agent needs your input before continuing. Use the input box below to respond, then the pipeline will resume." }],
                },
              },
            };
          });
          if (store.activeProjectId) {
            store.fetchTasks(store.activeProjectId);
          }
          break;
        }

        case "pipeline_stopped": {
          const agent = data.agent as string;
          console.log("[PipelineEvents] Pipeline stopped — nothing to do");
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  status: "done",
                  streaming: false,
                  messages: [...terminal.messages, { role: "system", content: `Pipeline stopped: ${data.message || "Agent determined there is nothing to do."}` }],
                },
              },
            };
          });
          if (store.activeProjectId) {
            store.fetchTasks(store.activeProjectId);
          }
          break;
        }

        case "ask_agent_started": {
          const agent = data.agent as string;
          console.log("[PipelineEvents] Ask agent started:", agent);
          updateTerminals(() => ({
            askingAgent: true,
          }));
          break;
        }

        case "ask_agent_chunk": {
          const agent = data.agent as string;
          const content = data.content as string;
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            const msgs = [...terminal.messages];
            if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: msgs[msgs.length - 1].content + content,
              };
            } else {
              msgs.push({ role: "assistant", content });
            }
            return {
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: { ...terminal, messages: msgs, streaming: true },
              },
            };
          });
          break;
        }

        case "ask_agent_done": {
          const agent = data.agent as string;
          console.log("[PipelineEvents] Ask agent done:", agent);
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent];
            return {
              askingAgent: false,
              ...(terminal ? {
                agentTerminals: {
                  ...snap.agentTerminals,
                  [agent]: { ...terminal, streaming: false },
                },
              } : {}),
            };
          });
          break;
        }

        case "ask_agent_error": {
          const agent = data.agent as string;
          const errMsg = data.message as string || "Unknown error";
          console.error("[PipelineEvents] Ask agent error:", errMsg);
          updateTerminals((snap) => {
            const terminal = snap.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
            return {
              askingAgent: false,
              agentTerminals: {
                ...snap.agentTerminals,
                [agent]: {
                  ...terminal,
                  streaming: false,
                  messages: [...terminal.messages, { role: "system", content: `Error: ${errMsg}` }],
                },
              },
            };
          });
          break;
        }

        case "permission_request": {
          const agent = data.agent as string;
          const category = data.category as string;
          const permId = data.id as string;
          const permTaskId = data.task_id as string;
          console.log("[PipelineEvents] Permission request:", data.toolName, data.summary);

          // Check if this category is auto-approved for this session
          const autoApprove = store.autoApproveCategories;
          if (autoApprove.has("all") || autoApprove.has(category)) {
            console.log("[PipelineEvents] Auto-approving:", data.toolName, "(category:", category, ")");
            // Fire-and-forget auto-approve
            const projectId = store.activeProjectId;
            if (projectId) {
              api.respondPermission(projectId, permTaskId, permId, "allow").catch(console.error);
            }
            break;
          }

          store.addPermissionRequest({
            id: permId,
            taskId: permTaskId,
            agent,
            toolName: data.toolName as string,
            toolInput: data.toolInput as Record<string, unknown>,
            category,
            summary: data.summary as string,
          });
          break;
        }

        case "permission_resolved": {
          const permId = data.permission_id as string;
          console.log("[PipelineEvents] Permission resolved:", permId, data.behavior);
          store.removePermissionRequest(permId);
          break;
        }

        case "usage_update": {
          const agent = data.agent as string || "";
          if (agent) {
            store.setContextUsage(agent, {
              inputTokens: data.inputTokens as number || 0,
              outputTokens: data.outputTokens as number || 0,
              cacheRead: data.cacheRead as number || 0,
              cacheCreation: data.cacheCreation as number || 0,
              contextWindow: data.contextWindow as number || 200000,
              costUSD: data.costUSD as number || 0,
              numTurns: data.numTurns as number || 0,
              agent,
            });
          }
          // When final, persist the accumulated total + per-agent cost to the task
          if (data.final && taskId && data.costUSD !== undefined && agent) {
            const agentCost = data.costUSD as number || 0;
            const totalCost = (data.totalCostUSD as number) || agentCost;
            console.log(`[PipelineEvents] Final usage for ${agent}: costUSD=${agentCost}, totalCostUSD=${totalCost}`);
            store.updateTaskCosts(
              taskId as string,
              agent,
              agentCost,
              totalCost
            );
          } else if (data.final && taskId && data.totalCostUSD !== undefined) {
            store.updateTaskTotalCost(taskId as string, data.totalCostUSD as number || 0);
          }
          break;
        }

        case "task_completed":
        case "task_error":
        case "task_cancelled":
          console.log("[PipelineEvents]", data.type);
          // Clear live usage so "live" badges are removed
          store.clearContextUsage();
          // Clear any pending permissions for this task
          useStore.setState((s) => ({
            pendingPermissions: s.pendingPermissions.filter((p) => p.taskId !== taskId),
          }));
          updateTerminals((snap) => {
            const updated = { ...snap.agentTerminals };
            for (const [name, term] of Object.entries(updated)) {
              if (term.status === "working" || term.status === "pending") {
                updated[name] = { ...term, status: "done", streaming: false };
              }
            }
            return {
              agentTerminals: updated,
              pipelineWaitingInput: false,
              pipelineChoosingAgent: false,
              askingAgent: false,
            };
          });
          if (store.activeProjectId) {
            store.fetchTasks(store.activeProjectId);
          }
          break;

        default:
          console.log("[PipelineEvents] UNKNOWN event type:", data.type);
          break;
      }
    };

    newWs.onerror = (e) => {
      console.error("[PipelineEvents] WebSocket error", e);
    };

    newWs.onclose = () => {
      console.log("[PipelineEvents] Disconnected, cancelled:", cancelled);
      if (!cancelled) {
        console.log("[PipelineEvents] Reconnecting in 2s...");
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    ws = newWs;
    } // end connect()

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushFn = null;
      // Clear leftover buffer
      for (const k of Object.keys(chunkBuffer)) delete chunkBuffer[k];
      if (ws) ws.close();
    };
  }, [projectId]);
}
