/**
 * WebSocket routes: project event stream and agent streaming with tool approval.
 */

import { createRequire } from "module";
import * as storage from "../storage.js";
import { createRunner, AGENT_NAMES } from "../agents/registry.js";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";

// Track active WebSocket connections per project
const connections = new Map<string, Set<WebSocket>>();

/** Broadcast an event to all connections for a project. */
export async function broadcast(projectId: string, event: Record<string, unknown>): Promise<void> {
  const sockets = connections.get(projectId);
  if (!sockets) return;

  const dead = new Set<WebSocket>();
  for (const ws of sockets) {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      dead.add(ws);
    }
  }
  for (const ws of dead) sockets.delete(ws);
}

// --- Tool call extraction (from agent text responses) ---

interface ToolCall {
  id: string;
  action_type: string;
  description: string;
  details: Record<string, unknown>;
  raw: string;
}

function extractToolCalls(text: string): ToolCall[] {
  const tools: ToolCall[] = [];
  const pattern = /<tool\s+type="([^"]+)"(?:\s+path="([^"]*)")?(?:\s*\/>|>([\s\S]*?)<\/tool>)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const actionType = match[1];
    const filePath = match[2] ?? "";
    const content = (match[3] ?? "").trim();
    const toolId = storage.generateId();

    let details: Record<string, unknown> = {};
    let description = "";

    if (actionType === "write_file") {
      details = { path: filePath, content };
      description = `Create file: ${filePath}`;
    } else if (actionType === "edit_file") {
      details = { path: filePath, diff: content };
      description = `Edit file: ${filePath}`;
    } else if (actionType === "run_command") {
      details = { command: content };
      description = `Run: ${content}`;
    } else if (actionType === "delete_file") {
      details = { path: filePath };
      description = `Delete: ${filePath}`;
    }

    tools.push({ id: toolId, action_type: actionType, description, details, raw: match[0] });
  }

  return tools;
}

/**
 * Tokenize a command string into [binary, ...args] without invoking a shell.
 * Handles basic single/double-quoted strings; special shell operators (|, &&, ;)
 * are treated as literal tokens so they cannot be injected.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

async function executeTool(
  projectId: string,
  tool: ToolCall,
): Promise<{ success: boolean; output: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const { action_type, details } = tool;

  try {
    if (action_type === "write_file") {
      const filesDir = await storage.projectFilesDir(projectId);
      const targetPath = `${filesDir}/${details.path}`;
      await storage.writeTextFile(targetPath, String(details.content ?? ""));
      return { success: true, output: `Created ${details.path}` };
    }

    if (action_type === "edit_file") {
      const filesDir = await storage.projectFilesDir(projectId);
      const targetPath = `${filesDir}/${details.path}`;
      const existing = await storage.readTextFile(targetPath);
      if (existing === null) return { success: false, output: `File not found: ${details.path}` };
      await storage.writeTextFile(targetPath, String(details.diff ?? ""));
      return { success: true, output: `Updated ${details.path}` };
    }

    if (action_type === "run_command") {
      const filesDir = await storage.projectFilesDir(projectId);
      const commandStr = String(details.command ?? "");
      const [binary, ...args] = tokenizeCommand(commandStr);
      if (!binary) return { success: false, output: "Empty command" };

      const { stdout, stderr } = await Promise.race([
        execFileAsync(binary, args, { cwd: filesDir }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 30_000)),
      ]);
      const output = `${stdout}${stderr}`.slice(0, 2000);
      return { success: true, output: output || "Done" };
    }

    if (action_type === "delete_file") {
      const filesDir = await storage.projectFilesDir(projectId);
      const targetPath = `${filesDir}/${details.path}`;
      const deleted = await storage.deletePath(targetPath);
      if (deleted) return { success: true, output: `Deleted ${details.path}` };
      return { success: false, output: `File not found: ${details.path}` };
    }

    return { success: false, output: `Unknown action: ${action_type}` };
  } catch (err) {
    return { success: false, output: err instanceof Error ? err.message : String(err) };
  }
}

export async function registerWebSocketRoutes(app: FastifyInstance): Promise<void> {
  // WS /projects/:projectId/events — global event stream
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/events",
    { websocket: true },
    (socket, req) => {
      const { projectId } = req.params;

      if (!connections.has(projectId)) connections.set(projectId, new Set());
      connections.get(projectId)!.add(socket);

      socket.on("close", () => {
        connections.get(projectId)?.delete(socket);
      });

      socket.on("error", () => {
        connections.get(projectId)?.delete(socket);
      });

      // Keep connection alive — no messages expected from client on this endpoint
      socket.on("message", () => { /* ignore */ });
    },
  );

  // WS /projects/:projectId/agents/:agentName/stream — agent chat with tool approval
  app.get<{ Params: { projectId: string; agentName: string } }>(
    "/projects/:projectId/agents/:agentName/stream",
    { websocket: true },
    async (socket, req) => {
      const { projectId, agentName } = req.params;

      if (!(AGENT_NAMES as readonly string[]).includes(agentName)) {
        socket.send(JSON.stringify({ type: "error", content: `Unknown agent: ${agentName}` }));
        socket.close();
        return;
      }

      const project = await storage.readJson(storage.projectJsonPath(projectId));
      if (!project) {
        socket.send(JSON.stringify({ type: "error", content: "Project not found" }));
        socket.close();
        return;
      }

      const pendingTools = new Map<string, ToolCall>();

      socket.on("message", async (raw: Buffer | string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const msgType = (msg.type as string) ?? "message";

        // Tool approval
        if (msgType === "tool_approve") {
          const toolId = msg.id as string;
          const tool = pendingTools.get(toolId);
          if (tool) {
            pendingTools.delete(toolId);
            const result = await executeTool(projectId, tool);
            socket.send(
              JSON.stringify({ type: "tool_result", action_type: tool.action_type, ...result }),
            );
          }
          return;
        }

        if (msgType === "tool_deny") {
          const toolId = msg.id as string;
          pendingTools.delete(toolId);
          socket.send(
            JSON.stringify({ type: "tool_result", action_type: "denied", success: false, output: "Action denied by user." }),
          );
          return;
        }

        // Chat message
        const userMessage = String(msg.message ?? "");
        if (!userMessage) {
          socket.send(JSON.stringify({ type: "error", content: "No message provided" }));
          return;
        }

        socket.send(JSON.stringify({ type: "start", agent: agentName }));
        await broadcast(projectId, { type: "agent_status", agent: agentName, status: "working" });

        try {
          const runner = await createRunner(projectId, agentName);
          let fullResponse = "";

          for await (const chunk of runner.stream(userMessage)) {
            fullResponse += chunk;
            socket.send(JSON.stringify({ type: "chunk", content: chunk }));
          }

          // Extract tool calls from response
          const tools = extractToolCalls(fullResponse);
          for (const tool of tools) {
            pendingTools.set(tool.id, tool);
            socket.send(
              JSON.stringify({
                type: "tool_request",
                id: tool.id,
                action_type: tool.action_type,
                description: tool.description,
                details: tool.details,
              }),
            );
          }

          socket.send(JSON.stringify({ type: "done", agent: agentName, content: fullResponse }));
        } catch (err) {
          socket.send(
            JSON.stringify({ type: "error", content: err instanceof Error ? err.message : String(err) }),
          );
        }

        await broadcast(projectId, { type: "agent_status", agent: agentName, status: "idle" });
      });

      socket.on("close", () => { /* cleanup */ });
      socket.on("error", () => { /* cleanup */ });
    },
  );
}
