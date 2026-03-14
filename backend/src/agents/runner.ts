/**
 * Agent runner: calls @anthropic-ai/claude-agent-sdk directly.
 * Replaces both agent-bridge.mjs and agents/base.py.
 *
 * Two modes:
 *   stream()                  — CLI-style, bypassPermissions, yields text chunks
 *   streamWithPermissions()   — full permissionHandler with canUseTool callback
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../routes/config.js";

// ---- Clean SDK environment ----
for (const key of [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_AGENT_SDK_VERSION",
]) {
  delete process.env[key];
}

export type PermissionCallback = (request: PermissionRequest) => Promise<PermissionResponse>;

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolInput: unknown;
  category: "read" | "write" | "execute" | "other";
  summary: string;
}

export interface PermissionResponse {
  id: string;
  behavior: "allow" | "deny";
  message?: string;
}

export type AgentEvent =
  | { type: "chunk"; content: string }
  | { type: "thinking_start" }
  | { type: "thinking_chunk"; content: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; summary?: string }
  | { type: "tool_result"; toolName: string; preview: string }
  | { type: "permission_request"; id: string; toolName: string; toolInput: unknown; category: string; summary: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number; contextWindow?: number; costUSD?: number; numTurns?: number; final?: boolean }
  | { type: "done" }
  | { type: "error"; message: string };

function getToolCategory(toolName: string): "read" | "write" | "execute" | "other" {
  const readTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  const writeTools = ["Write", "Edit", "NotebookEdit"];
  const execTools = ["Bash"];
  if (readTools.includes(toolName)) return "read";
  if (writeTools.includes(toolName)) return "write";
  if (execTools.includes(toolName)) return "execute";
  return "other";
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return String(input.command ?? "Unknown command");
    case "Write":
      return `Create/overwrite: ${input.file_path ?? "unknown"}`;
    case "Edit":
      return `Edit: ${input.file_path ?? "unknown"}`;
    case "Read":
      return `Read: ${input.file_path ?? "unknown"}`;
    case "Glob":
      return `Search files: ${input.pattern ?? "unknown"}`;
    case "Grep":
      return `Search content: ${input.pattern ?? "unknown"}`;
    default:
      return `${toolName}: ${JSON.stringify(input).substring(0, 100)}`;
  }
}

function getModel(override?: string | null): string {
  if (override) return override;
  const config = getConfig();
  return (config.default_model as string) ?? "claude-sonnet-4-6";
}

export class AgentRunner {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model: string | null;
  readonly cwd: string | null;
  private _abortController: AbortController | null = null;
  private _cancelled = false;

  constructor(opts: {
    name: string;
    systemPrompt: string;
    model?: string | null;
    cwd?: string | null;
  }) {
    this.name = opts.name;
    this.systemPrompt = opts.systemPrompt;
    this.model = opts.model ?? null;
    this.cwd = opts.cwd ?? null;
  }

  cancel(): void {
    this._cancelled = true;
    this._abortController?.abort();
  }

  /**
   * CLI-style: bypassPermissions, yields text chunks only.
   */
  async *stream(
    userMessage: string,
    context?: string,
  ): AsyncGenerator<string> {
    this._cancelled = false;
    this._abortController = new AbortController();

    const prompt = context
      ? `<context>\n${context}\n</context>\n\n${userMessage}`
      : userMessage;

    try {
      for await (const message of query(
        {
          prompt,
          options: {
            systemPrompt: this.systemPrompt,
            model: getModel(this.model),
            cwd: this.cwd ?? undefined,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            abortController: this._abortController,
          },
        },
      )) {
        if (this._cancelled) return;

        // ResultMessage has a `result` property
        if ("result" in message && typeof message.result === "string") {
          yield message.result;
        }
        // AssistantMessage-like: look for text content blocks
        else if ("type" in message && message.type === "assistant") {
          const content = (message as { message?: { content?: unknown[] } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string };
              if (b.type === "text" && b.text) {
                yield b.text;
              }
            }
          }
        }
      }
    } catch (err) {
      if (!this._cancelled) {
        yield `\n\nError: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      this._abortController = null;
    }
  }

  /**
   * Full SDK mode: canUseTool permission handler, yields all AgentEvents.
   */
  async *streamWithPermissions(
    userMessage: string,
    opts: {
      onPermission: PermissionCallback;
      context?: string;
      autoApproveRead?: boolean;
      onUsage?: (usage: AgentEvent & { type: "usage" }) => Promise<void>;
      onActivity?: (event: AgentEvent) => Promise<void>;
    },
  ): AsyncGenerator<string> {
    this._cancelled = false;
    this._abortController = new AbortController();

    const prompt = opts.context
      ? `<context>\n${opts.context}\n</context>\n\n${userMessage}`
      : userMessage;

    const autoApproveRead = opts.autoApproveRead ?? true;

    let hasStreamedContent = false;
    let hasStreamedThinking = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let currentToolName: string | null = null;
    let currentToolInput = "";

    try {
      for await (const message of query({
        prompt,
        options: {
          systemPrompt: this.systemPrompt,
          model: getModel(this.model),
          cwd: this.cwd ?? undefined,
          permissionMode: "default",
          allowedTools: [],
          abortController: this._abortController,

          canUseTool: async (toolName: string, input: unknown, context: { toolUseID?: string }) => {
            const category = getToolCategory(toolName);

            if (autoApproveRead && category === "read") {
              return { behavior: "allow" as const };
            }

            const id =
              context.toolUseID ?? `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const summary = summarizeToolInput(toolName, (input as Record<string, unknown>) ?? {});

            const response = await opts.onPermission({
              id,
              toolName,
              toolInput: input,
              category,
              summary,
            });

            if (response.behavior === "allow") {
              return { behavior: "allow" as const };
            }
            return { behavior: "deny" as const, message: response.message ?? "Denied by user" };
          },
        },
      })) {
        if (this._cancelled) return;

        const msg = message as Record<string, unknown>;

        if (msg.type === "stream_event") {
          const event = msg.event as Record<string, unknown> | undefined;
          if (!event) continue;

          if (event.type === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (block?.type === "tool_use") {
              currentToolName = String(block.name ?? "unknown");
              currentToolInput = "";
              await opts.onActivity?.({ type: "tool_start", toolName: currentToolName });
            } else if (block?.type === "thinking") {
              await opts.onActivity?.({ type: "thinking_start" });
            }
          }

          if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              yield delta.text;
              hasStreamedContent = true;
            } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              await opts.onActivity?.({ type: "thinking_chunk", content: delta.thinking });
              hasStreamedThinking = true;
            } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              currentToolInput += delta.partial_json;
            }
          }

          if (event.type === "content_block_stop" && currentToolName) {
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(currentToolInput); } catch { /* empty */ }
            await opts.onActivity?.({
              type: "tool_end",
              toolName: currentToolName,
              summary: summarizeToolInput(currentToolName, parsedInput),
            });
            currentToolName = null;
            currentToolInput = "";
          }
        }

        if (msg.type === "tool") {
          const toolName = String(msg.tool_name ?? "unknown");
          const resultStr =
            typeof msg.result === "string"
              ? msg.result
              : JSON.stringify(msg.result ?? "");
          const preview = resultStr.length > 200 ? resultStr.substring(0, 200) + "..." : resultStr;
          await opts.onActivity?.({ type: "tool_result", toolName, preview });
        }

        if (msg.type === "assistant") {
          if (!hasStreamedThinking) {
            const content = (msg.message as Record<string, unknown> | undefined)?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as Record<string, unknown>;
                if (b.type === "thinking" && b.thinking) {
                  await opts.onActivity?.({ type: "thinking_start" });
                  await opts.onActivity?.({ type: "thinking_chunk", content: String(b.thinking) });
                } else if (b.type === "tool_use") {
                  const tn = String(b.name ?? "unknown");
                  await opts.onActivity?.({ type: "tool_start", toolName: tn });
                  await opts.onActivity?.({
                    type: "tool_end",
                    toolName: tn,
                    summary: summarizeToolInput(tn, (b.input as Record<string, unknown>) ?? {}),
                  });
                }
              }
            }
          }
          const msgUsage = (msg.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
          if (msgUsage) {
            totalInputTokens += Number(msgUsage.input_tokens ?? 0);
            totalOutputTokens += Number(msgUsage.output_tokens ?? 0);
            await opts.onUsage?.({
              type: "usage",
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cacheRead: Number(msgUsage.cache_read_input_tokens ?? 0),
              cacheCreation: Number(msgUsage.cache_creation_input_tokens ?? 0),
            });
          }
        }

        if (msg.type === "result") {
          if (!hasStreamedContent && msg.subtype === "success" && msg.result) {
            yield String(msg.result);
          }
          if (msg.subtype === "error") {
            yield `\n\nError: ${msg.error ?? "Agent returned error"}`;
          }
          const modelUsage = msg.modelUsage as Record<string, Record<string, unknown>> | undefined;
          const firstModel = modelUsage ? Object.values(modelUsage)[0] : undefined;
          const resultUsage = msg.usage as Record<string, unknown> | undefined;
          await opts.onUsage?.({
            type: "usage",
            inputTokens: Number(resultUsage?.input_tokens ?? totalInputTokens),
            outputTokens: Number(resultUsage?.output_tokens ?? totalOutputTokens),
            cacheRead: Number(resultUsage?.cache_read_input_tokens ?? 0),
            cacheCreation: Number(resultUsage?.cache_creation_input_tokens ?? 0),
            contextWindow: Number(firstModel?.contextWindow ?? 200000),
            costUSD: Number(msg.total_cost_usd ?? firstModel?.costUSD ?? 0),
            numTurns: Number(msg.num_turns ?? 0),
            final: true,
          });
        }
      }
    } catch (err) {
      if (!this._cancelled) {
        yield `\n\nError: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      this._abortController = null;
    }
  }

  async run(userMessage: string, context?: string): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.stream(userMessage, context)) {
      chunks.push(chunk);
    }
    return chunks.join("");
  }
}
