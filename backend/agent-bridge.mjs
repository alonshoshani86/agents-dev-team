#!/usr/bin/env node
/**
 * Agent Bridge: Runs Claude Code SDK with interactive permission handling.
 *
 * Protocol (JSON lines over stdin/stdout):
 *
 * STDOUT (bridge -> python):
 *   {"type":"chunk","content":"..."} — response text chunk
 *   {"type":"permission_request","id":"...","toolName":"...","toolInput":{...}} — needs approval
 *   {"type":"usage","inputTokens":N,"outputTokens":N,"cacheRead":N,"cacheCreation":N,"contextWindow":N,"costUSD":N} — token usage update
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
    let hasStreamedThinking = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let currentToolName = null;
    let currentToolInput = "";

    for await (const message of query({ prompt: userMessage, options })) {
      if (!message || typeof message !== "object") continue;

      // Debug: log every message type to stderr (visible in Python backend logs)
      const debugInfo = { type: message.type };
      if (message.type === "stream_event" && message.event) {
        debugInfo.eventType = message.event.type;
        if (message.event.content_block) debugInfo.blockType = message.event.content_block.type;
        if (message.event.delta) debugInfo.deltaType = message.event.delta.type;
      }
      if (message.type === "assistant" && message.message) {
        const content = message.message.content;
        debugInfo.contentTypes = Array.isArray(content) ? content.map(b => b.type) : typeof content;
        debugInfo.hasUsage = !!message.message.usage;
      }
      process.stderr.write(`[bridge] ${JSON.stringify(debugInfo)}\n`);

      switch (message.type) {
        case "stream_event": {
          const event = message.event;
          if (!event) break;

          // Content block start — detect tool use blocks
          if (event.type === "content_block_start") {
            if (event.content_block?.type === "tool_use") {
              currentToolName = event.content_block.name || "unknown";
              currentToolInput = "";
              emit({ type: "tool_start", toolName: currentToolName });
            } else if (event.content_block?.type === "thinking") {
              emit({ type: "thinking_start" });
            }
          }

          // Content block delta — forward text, thinking, and tool input
          if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta") {
              emit({ type: "chunk", content: event.delta.text });
              hasStreamedContent = true;
            } else if (event.delta?.type === "thinking_delta") {
              emit({ type: "thinking_chunk", content: event.delta.thinking });
              hasStreamedThinking = true;
            } else if (event.delta?.type === "input_json_delta") {
              currentToolInput += event.delta.partial_json || "";
            }
          }

          // Content block stop — finalize tool use
          if (event.type === "content_block_stop") {
            if (currentToolName) {
              let parsedInput = {};
              try { parsedInput = JSON.parse(currentToolInput); } catch {}
              emit({
                type: "tool_end",
                toolName: currentToolName,
                summary: summarizeToolInput(currentToolName, parsedInput),
              });
              currentToolName = null;
              currentToolInput = "";
            }
          }

          break;
        }

        case "tool": {
          // Tool result — emit a summary of the result
          const toolName = message.tool_name || "unknown";
          const resultStr = typeof message.result === "string"
            ? message.result
            : JSON.stringify(message.result || "");
          const preview = resultStr.length > 200 ? resultStr.substring(0, 200) + "..." : resultStr;
          emit({ type: "tool_result", toolName, preview });
          break;
        }

        case "tool_use_summary": {
          // SDK-level tool use summary
          if (message.summary) {
            emit({ type: "tool_end", toolName: "summary", summary: message.summary });
          }
          break;
        }

        case "tool_progress": {
          // Tool is running — show progress
          const tpName = message.tool_name || "unknown";
          emit({ type: "tool_start", toolName: tpName });
          break;
        }

        case "assistant": {
          // Extract thinking and tool_use from completed assistant message content blocks
          // Only if we didn't already get them via stream_event (to avoid duplicates)
          if (!hasStreamedThinking) {
            const content = message.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "thinking" && block.thinking) {
                  emit({ type: "thinking_start" });
                  emit({ type: "thinking_chunk", content: block.thinking });
                } else if (block.type === "tool_use") {
                  const tn = block.name || "unknown";
                  emit({ type: "tool_start", toolName: tn });
                  emit({
                    type: "tool_end",
                    toolName: tn,
                    summary: summarizeToolInput(tn, block.input || {}),
                  });
                }
              }
            }
          }
          // Extract per-turn usage from the assistant message
          if (message.message?.usage) {
            const u = message.message.usage;
            totalInputTokens += u.input_tokens || 0;
            totalOutputTokens += u.output_tokens || 0;
            emit({
              type: "usage",
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cacheRead: u.cache_read_input_tokens || 0,
              cacheCreation: u.cache_creation_input_tokens || 0,
            });
          }
          break;
        }

        case "result": {
          // Final result — only use if we didn't get streaming content (to avoid duplication)
          if (!hasStreamedContent && message.subtype === "success" && message.result) {
            emit({ type: "chunk", content: message.result });
          }
          if (message.subtype === "error") {
            emit({ type: "error", message: message.error || "Agent returned error" });
          }
          // Emit final usage with model context window info
          const modelUsage = message.modelUsage || {};
          const firstModel = Object.values(modelUsage)[0];
          emit({
            type: "usage",
            inputTokens: message.usage?.input_tokens || totalInputTokens,
            outputTokens: message.usage?.output_tokens || totalOutputTokens,
            cacheRead: message.usage?.cache_read_input_tokens || 0,
            cacheCreation: message.usage?.cache_creation_input_tokens || 0,
            contextWindow: firstModel?.contextWindow || 200000,
            costUSD: message.total_cost_usd || firstModel?.costUSD || 0,
            numTurns: message.num_turns || 0,
            final: true,
          });
          break;
        }

        // system, status, etc. — skip (content already delivered via stream_event)
      }
    }

    emit({ type: "done" });
  } catch (err) {
    emit({ type: "error", message: err.message || String(err) });
  }

  process.exit(0);
}

main();
