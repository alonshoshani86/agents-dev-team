#!/usr/bin/env node
/**
 * Agent Bridge: Runs Claude Code SDK with interactive permission handling.
 *
 * Protocol (JSON lines over stdin/stdout):
 *
 * STDOUT (bridge -> python):
 *   {"type":"chunk","content":"..."} — response text chunk
 *   {"type":"permission_request","id":"...","toolName":"...","toolInput":{...}} — needs approval
 *   {"type":"done"} — agent finished
 *   {"type":"error","message":"..."} — error occurred
 *
 * STDIN (python -> bridge):
 *   {"id":"...","behavior":"allow"} — approve tool use
 *   {"id":"...","behavior":"deny","message":"..."} — deny tool use
 */

// Clean environment — prevent "cannot run inside another Claude Code session" error
for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_AGENT_SDK_VERSION"]) {
  delete process.env[key];
}

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "readline";

// Pending permission requests waiting for stdin response
const pendingPermissions = new Map();

// Write a JSON line to stdout
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Listen for permission responses on stdin
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  try {
    const response = JSON.parse(line);
    const pending = pendingPermissions.get(response.id);
    if (pending) {
      pending.resolve(response);
      pendingPermissions.delete(response.id);
    }
  } catch {
    // ignore malformed input
  }
});

// Parse config from argv
const configJson = process.argv[2];
if (!configJson) {
  emit({ type: "error", message: "No config provided" });
  process.exit(1);
}

let config;
try {
  config = JSON.parse(configJson);
} catch {
  emit({ type: "error", message: "Invalid config JSON" });
  process.exit(1);
}

const { systemPrompt, model, userMessage, cwd, autoApproveRead } = config;

// Tool categories for the UI
function getToolCategory(toolName) {
  const readTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  const writeTools = ["Write", "Edit", "NotebookEdit"];
  const execTools = ["Bash"];

  if (readTools.includes(toolName)) return "read";
  if (writeTools.includes(toolName)) return "write";
  if (execTools.includes(toolName)) return "execute";
  return "other";
}

// Summarize tool input for display
function summarizeToolInput(toolName, input) {
  switch (toolName) {
    case "Bash":
      return input.command || "Unknown command";
    case "Write":
      return `Create/overwrite: ${input.file_path || "unknown"}`;
    case "Edit":
      return `Edit: ${input.file_path || "unknown"}`;
    case "Read":
      return `Read: ${input.file_path || "unknown"}`;
    case "Glob":
      return `Search files: ${input.pattern || "unknown"}`;
    case "Grep":
      return `Search content: ${input.pattern || "unknown"}`;
    default:
      return `${toolName}: ${JSON.stringify(input).substring(0, 100)}`;
  }
}

async function main() {
  try {
    const options = {
      systemPrompt: systemPrompt || undefined,
      model: model || undefined,
      cwd: cwd || undefined,
      permissionMode: "default",
      allowedTools: [],
      includePartialMessages: true,

      canUseTool: async (toolName, input, context) => {
        const category = getToolCategory(toolName);

        // Auto-approve read operations if configured
        if (autoApproveRead && category === "read") {
          return { behavior: "allow" };
        }

        // Send permission request to Python
        const id = context.toolUseID || `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        emit({
          type: "permission_request",
          id,
          toolName,
          toolInput: input,
          category,
          summary: summarizeToolInput(toolName, input),
        });

        // Wait for response from Python (via stdin)
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingPermissions.delete(id);
            resolve({
              behavior: "deny",
              message: "Permission request timed out (120s)",
            });
          }, 120_000);

          pendingPermissions.set(id, {
            resolve: (response) => {
              clearTimeout(timeout);
              if (response.behavior === "allow") {
                resolve({
                  behavior: "allow",
                  updatedInput: response.updatedInput || input,
                });
              } else {
                resolve({
                  behavior: "deny",
                  message: response.message || "Denied by user",
                });
              }
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      },
    };

    let hasStreamedContent = false;

    for await (const message of query({ prompt: userMessage, options })) {
      if (!message || typeof message !== "object") continue;

      switch (message.type) {
        case "stream_event":
          // Streaming partial — forward text deltas for real-time output
          if (message.event?.type === "content_block_delta" && message.event.delta?.type === "text_delta") {
            emit({ type: "chunk", content: message.event.delta.text });
            hasStreamedContent = true;
          }
          break;

        case "result":
          // Final result — only use if we didn't get streaming content (to avoid duplication)
          if (!hasStreamedContent && message.subtype === "success" && message.result) {
            emit({ type: "chunk", content: message.result });
          }
          if (message.subtype === "error") {
            emit({ type: "error", message: message.error || "Agent returned error" });
          }
          break;

        // assistant, system, status, etc. — skip (content already delivered via stream_event)
      }
    }

    emit({ type: "done" });
  } catch (err) {
    emit({ type: "error", message: err.message || String(err) });
  }

  process.exit(0);
}

main();
