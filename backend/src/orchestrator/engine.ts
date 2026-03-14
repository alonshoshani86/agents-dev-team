/**
 * Orchestrator engine: executes tasks through dynamic agent routing.
 * Replaces orchestrator/engine.py. Uses Promise-based latches instead of asyncio.
 */

import fs from "fs";
import path from "path";
import * as storage from "../storage.js";
import { createRunner } from "../agents/registry.js";
import * as worktree from "../worktree.js";
import {
  appendHistory,
  createArtifact,
  listArtifacts,
  appendTerminalMessage,
  updateLastTerminalMessage,
  clearAgentTerminal,
} from "./models.js";
import { getPipeline } from "./pipelines.js";
import type { Pipeline } from "./pipelines.js";
import type { AgentRunner, PermissionRequest, PermissionResponse } from "../agents/runner.js";

const MAX_ITERATIONS = 10;

// In-memory state for running tasks
const runningTasks = new Map<string, TaskExecution>();

// Export Map for testing (read-only via getter)
export function getRunningTasks(): ReadonlyMap<string, TaskExecution> {
  return runningTasks;
}

export type EventCallback = (event: Record<string, unknown>) => Promise<void>;

// --- Pause latch (replaces asyncio.Event) ---

export class PauseLatch {
  private _paused = false;
  private _resolve: (() => void) | null = null;
  private _promise: Promise<void> = Promise.resolve();

  get paused(): boolean {
    return this._paused;
  }

  pause(): void {
    if (!this._paused) {
      this._paused = true;
      this._promise = new Promise<void>((resolve) => {
        this._resolve = resolve;
      });
    }
  }

  resume(): void {
    if (this._paused) {
      this._paused = false;
      this._resolve?.();
      this._resolve = null;
    }
  }

  async wait(): Promise<void> {
    if (this._paused) {
      const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
      await Promise.race([
        this._promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Task paused timeout — auto-cancelling")),
            TIMEOUT_MS,
          ),
        ),
      ]);
    }
  }
}

// --- TaskExecution ---

export class TaskExecution {
  readonly projectId: string;
  readonly taskId: string;
  readonly pipeline: Pipeline;
  readonly startAgent: string;

  iteration = 0;
  currentAgent: string | null = null;
  cancelled = false;
  extraContext: string | null = null;
  nextAgentChoice: string | null | undefined = undefined; // undefined = not yet chosen
  worktreePath: string | null = null;

  private _pauseLatch = new PauseLatch();
  private _currentRunner: AgentRunner | null = null;

  // Permission handling: id -> { resolve, reject }
  private _pendingPermissions = new Map<
    string,
    { resolve: (r: PermissionResponse) => void; reject: (e: Error) => void }
  >();

  constructor(projectId: string, taskId: string, pipeline: Pipeline) {
    this.projectId = projectId;
    this.taskId = taskId;
    this.pipeline = pipeline;
    this.startAgent = pipeline.start_agent;
  }

  get paused(): boolean {
    return this._pauseLatch.paused;
  }

  /** True only when the task is paused at the choose-next-agent checkpoint. */
  get choosingAgent(): boolean {
    return this._pauseLatch.paused && this.nextAgentChoice === undefined;
  }

  get currentRunner(): AgentRunner | null {
    return this._currentRunner;
  }

  setRunner(runner: AgentRunner | null): void {
    this._currentRunner = runner;
  }

  pause(): void {
    this._pauseLatch.pause();
  }

  resume(): void {
    this._pauseLatch.resume();
  }

  async waitIfPaused(): Promise<void> {
    await this._pauseLatch.wait();
  }

  resolvePermission(permissionId: string, response: PermissionResponse): boolean {
    const pending = this._pendingPermissions.get(permissionId);
    if (pending) {
      this._pendingPermissions.delete(permissionId);
      pending.resolve(response);
      return true;
    }
    return false;
  }

  createPermissionPromise(
    permissionId: string,
    timeoutMs = 130_000,
  ): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingPermissions.delete(permissionId);
        resolve({ id: permissionId, behavior: "deny", message: "Timed out waiting for user" });
      }, timeoutMs);

      this._pendingPermissions.set(permissionId, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}

// --- Helpers ---

function hasActiveAgent(projectId: string, excludeTaskId?: string): string | null {
  for (const [tid, ex] of runningTasks) {
    if (tid === excludeTaskId) continue;
    if (ex.projectId === projectId && ex.currentRunner !== null) return tid;
  }
  return null;
}

async function setupWorktree(projectId: string, taskId: string): Promise<[string | null, string | null]> {
  const repoPath = storage.getRepoPath(projectId);
  if (!repoPath || !worktree.isGitRepo(repoPath)) return [null, null];
  const taskData = await storage.readJson<Record<string, unknown>>(
    path.join(storage.projectTasksDir(projectId), taskId, "task.json"),
  );
  const taskName = (taskData?.title as string | undefined) ?? "";
  const [success, result, branch] = await worktree.createWorktree(repoPath, taskId, taskName);
  if (success) {
    console.log(`[engine] Task ${taskId} worktree ready: ${result} (branch: ${branch})`);
    return [result, branch];
  }
  console.warn(`[engine] Worktree creation failed for task ${taskId}: ${result}`);
  return [null, null];
}

function updateTask(projectId: string, taskId: string, updates: Record<string, unknown>): Promise<void> {
  const taskPath = path.join(storage.projectTasksDir(projectId), taskId, "task.json");
  return storage.readJson<Record<string, unknown>>(taskPath).then((task) => {
    if (task) {
      Object.assign(task, updates);
      // Clear error message when task resumes
      if (updates.status === "running") {
        delete task.error_message;
      }
      task.updated_at = storage.nowIso();
      return storage.writeJson(taskPath, task);
    }
  }).catch((err) => console.error("[engine] Failed to update task:", err));
}

const AGENT_DISPLAY: Record<string, string> = {
  product: "Product",
  architect: "Architect",
  dev: "Dev",
  test: "Test",
  uxui: "UX/UI",
};

function detectSignal(response: string): string | null {
  if (response.toUpperCase().includes("[PIPELINE:NEEDS_INPUT]")) return "needs_input";
  return null;
}

function detectNextAgent(response: string): string | null {
  const match = response.match(/\[NEXT:(\w+)\]/i);
  if (match) {
    const agent = match[1].toLowerCase();
    if (["product", "architect", "dev", "test", "uxui"].includes(agent)) return agent;
  }
  return null;
}

function agentArtifactType(agentName: string): string {
  const map: Record<string, string> = {
    product: "spec",
    architect: "architecture",
    dev: "implementation",
    test: "test-plan",
    uxui: "ui-review",
  };
  return map[agentName] ?? agentName;
}

// --- Agent execution ---

async function executeAgent(
  execution: TaskExecution,
  agentName: string,
  onEvent: EventCallback | null,
): Promise<[string | null, string | null]> {
  await updateTask(execution.projectId, execution.taskId, {
    current_agent: agentName,
    iteration: execution.iteration,
  });

  if (onEvent) {
    await onEvent({
      type: "step_started",
      task_id: execution.taskId,
      agent: agentName,
      step_name: agentName,
      iteration: execution.iteration,
    });
  }

  // Clear previous terminal messages for this agent before starting fresh
  await clearAgentTerminal(execution.projectId, execution.taskId, agentName);

  const agentDisplay = AGENT_DISPLAY[agentName] ?? agentName;
  await appendTerminalMessage(
    execution.projectId,
    execution.taskId,
    agentName,
    "system",
    `Starting ${agentDisplay} agent...`,
  );

  // Show which artifacts are being passed as context
  const prevArtifacts = await listArtifacts(execution.projectId, execution.taskId);
  if (prevArtifacts.length > 0) {
    const artifactList = prevArtifacts
      .map(
        (a) =>
          `${a.type ?? "?"} (by ${a.agent ?? "?"}, ${String(a.content ?? "").length} chars)`,
      )
      .join(", ");
    await appendTerminalMessage(
      execution.projectId,
      execution.taskId,
      agentName,
      "system",
      `Context from previous steps: ${artifactList}`,
    );
    if (onEvent) {
      await onEvent({ type: "step_chunk", task_id: execution.taskId, agent: agentName, content: "" });
    }
  }

  // Build context from task + previous artifacts
  const taskData = await storage.readJson<Record<string, unknown>>(
    path.join(storage.projectTasksDir(execution.projectId), execution.taskId, "task.json"),
  );
  const context = buildContext(execution, prevArtifacts);

  let userMessage = `Task: ${taskData?.title ?? ""}\n\n${taskData?.description ?? ""}`;
  if (execution.extraContext) {
    userMessage += `\n\nAdditional instructions:\n${execution.extraContext}`;
    execution.extraContext = null;
  }

  const runner = await createRunner(execution.projectId, agentName, execution.worktreePath);
  execution.setRunner(runner);
  let fullResponse = "";

  // Permission handler: creates a promise, broadcasts the request, waits
  const onPermission = async (request: PermissionRequest): Promise<PermissionResponse> => {
    if (onEvent) {
      await onEvent({
        type: "permission_request",
        task_id: execution.taskId,
        agent: agentName,
        id: request.id,
        toolName: request.toolName,
        toolInput: request.toolInput,
        category: request.category,
        summary: request.summary,
      });
    }
    return execution.createPermissionPromise(request.id);
  };

  const onUsage = async (usage: Record<string, unknown>) => {
    const isFinal = !!usage.final;
    const costUSD = usage.costUSD as number | undefined;

    // When an agent finishes, persist cost to task.json
    let totalCostUSD: number | undefined;
    if (isFinal && costUSD != null && costUSD > 0) {
      try {
        const taskPath = path.join(
          storage.projectTasksDir(execution.projectId),
          execution.taskId,
          "task.json",
        );
        const taskData = await storage.readJson<Record<string, unknown>>(taskPath);
        if (taskData) {
          const existingTotal = Number(taskData.total_cost_usd ?? 0);
          totalCostUSD = existingTotal + costUSD;
          const agentCosts = (taskData.agent_costs as Record<string, number>) ?? {};
          agentCosts[agentName] = (agentCosts[agentName] ?? 0) + costUSD;
          taskData.agent_costs = agentCosts;
          taskData.total_cost_usd = totalCostUSD;
          await storage.writeJson(taskPath, taskData);
          console.log(`[engine] Persisted cost for ${agentName}: $${costUSD.toFixed(4)} (total: $${totalCostUSD.toFixed(4)})`);
        }
      } catch (err) {
        console.error("[engine] Failed to persist cost:", err);
      }
    }

    if (onEvent) {
      const event: Record<string, unknown> = {
        type: "usage_update",
        task_id: execution.taskId,
        agent: agentName,
        ...usage,
      };
      if (totalCostUSD != null) {
        event.totalCostUSD = totalCostUSD;
      }
      await onEvent(event);
    }
  };

  const onActivity = async (activity: Record<string, unknown>) => {
    if (onEvent) {
      await onEvent({ ...activity, task_id: execution.taskId, agent: agentName });
    }
  };

  for await (const chunk of runner.streamWithPermissions(userMessage, {
    onPermission,
    context,
    onUsage: onUsage as never,
    onActivity: onActivity as never,
  })) {
    if (execution.cancelled) break;
    fullResponse += chunk;
    if (onEvent) {
      await onEvent({
        type: "step_chunk",
        task_id: execution.taskId,
        agent: agentName,
        content: chunk,
      });
    }
  }

  execution.setRunner(null);

  if (execution.cancelled) return [null, null];

  // Save full response to terminal log
  await updateLastTerminalMessage(execution.projectId, execution.taskId, agentName, fullResponse);

  // Detect signals
  const signal = detectSignal(fullResponse);
  const nextAgent = detectNextAgent(fullResponse);

  // Save artifact
  const artifactType = agentArtifactType(agentName);
  await createArtifact(execution.projectId, execution.taskId, artifactType, fullResponse, agentName);

  // Log to history
  await appendHistory(execution.projectId, execution.taskId, {
    agent: agentName,
    iteration: execution.iteration,
    input_summary: userMessage.slice(0, 200),
    output_summary: fullResponse.slice(0, 500),
    artifact_type: artifactType,
    signal,
    next_agent: nextAgent,
  });

  if (signal === "needs_input") {
    execution.pause();
    await updateTask(execution.projectId, execution.taskId, { status: "waiting_input", paused: true });
    await appendTerminalMessage(
      execution.projectId,
      execution.taskId,
      agentName,
      "system",
      "Pipeline paused: agent needs your input before continuing. Use the input box below to respond, then the pipeline will resume.",
    );
    if (onEvent) {
      await onEvent({
        type: "pipeline_needs_input",
        task_id: execution.taskId,
        agent: agentName,
        message: "Agent has questions or needs clarification before the pipeline can continue.",
      });
    }
  }

  const nextDisplay = AGENT_DISPLAY[nextAgent ?? ""] ?? nextAgent ?? "";
  const completionMsg = nextAgent
    ? `${agentDisplay} completed. Routing to ${nextDisplay}...`
    : `${agentDisplay} agent completed.`;
  await appendTerminalMessage(execution.projectId, execution.taskId, agentName, "system", completionMsg);

  if (onEvent) {
    await onEvent({
      type: "step_completed",
      task_id: execution.taskId,
      agent: agentName,
      step_name: agentName,
      signal,
      next_agent: nextAgent,
    });
  }

  return [signal, nextAgent];
}

function buildContext(
  execution: TaskExecution,
  artifacts: Record<string, unknown>[],
): string {
  if (artifacts.length === 0) return "";
  const parts = ["Previous artifacts from this task:"];
  for (const art of artifacts) {
    parts.push(`\n--- ${art.type ?? "unknown"} (by ${art.agent ?? "unknown"}) ---`);
    let content = String(art.content ?? "");
    if (content.length > 10000) content = content.slice(0, 10000) + "\n... (truncated)";
    parts.push(content);
  }
  return parts.join("\n");
}

// --- Pipeline loop ---

async function executePipelineLoop(
  execution: TaskExecution,
  startAgent: string,
  onEvent: EventCallback | null,
): Promise<void> {
  let nextAgent: string | null = startAgent;

  while (nextAgent && !execution.cancelled) {
    if (execution.iteration >= MAX_ITERATIONS) {
      if (onEvent) {
        await onEvent({
          type: "pipeline_stopped",
          task_id: execution.taskId,
          agent: execution.currentAgent ?? nextAgent,
          message: `Pipeline reached maximum iterations (${MAX_ITERATIONS}). Stopping.`,
        });
      }
      break;
    }

    await execution.waitIfPaused();
    if (execution.cancelled) break;

    execution.currentAgent = nextAgent;
    execution.iteration++;

    const [signal, suggestedAgent] = await executeAgent(execution, nextAgent, onEvent);

    if (signal === "needs_input") {
      await execution.waitIfPaused();
      if (execution.cancelled) break;
      continue;
    }

    // After agent completes, pause and ask user which agent to run next
    execution.nextAgentChoice = undefined;
    execution.pause();
    await updateTask(execution.projectId, execution.taskId, {
      status: "choosing_agent",
      paused: true,
    });

    if (onEvent) {
      await onEvent({
        type: "choose_next_agent",
        task_id: execution.taskId,
        agent: nextAgent,
        suggested_agent: suggestedAgent,
      });
    }

    // Wait for user choice
    await execution.waitIfPaused();
    if (execution.cancelled) break;

    nextAgent = execution.nextAgentChoice ?? null;
  }

  if (execution.cancelled) {
    await updateTask(execution.projectId, execution.taskId, { status: "cancelled" });
    if (onEvent) await onEvent({ type: "task_cancelled", task_id: execution.taskId });
  } else {
    await updateTask(execution.projectId, execution.taskId, { status: "completed" });
    if (onEvent) await onEvent({ type: "task_completed", task_id: execution.taskId });
  }
}

// --- Public API ---

export async function startPipeline(
  projectId: string,
  taskId: string,
  pipelineId: string,
  onEvent: EventCallback | null = null,
): Promise<void> {
  const pipeline = await getPipeline(projectId, pipelineId);
  if (!pipeline) {
    if (onEvent) await onEvent({ type: "error", task_id: taskId, message: `Pipeline not found: ${pipelineId}` });
    return;
  }

  const execution = new TaskExecution(projectId, taskId, pipeline);

  // Create git worktree for task isolation
  const [wtPath, branchName] = await setupWorktree(projectId, taskId);
  execution.worktreePath = wtPath;

  runningTasks.set(taskId, execution);

  const taskUpdates: Record<string, unknown> = { status: "running", pipeline_id: pipelineId };
  if (wtPath) {
    taskUpdates.worktree_path = wtPath;
    taskUpdates.branch_name = branchName;
  }
  await updateTask(projectId, taskId, taskUpdates);

  if (onEvent) {
    await onEvent({
      type: "task_started",
      task_id: taskId,
      pipeline: pipeline.name,
    });
  }

  try {
    await executePipelineLoop(execution, execution.startAgent, onEvent);
  } catch (err) {
    await updateTask(projectId, taskId, { status: "error" });
    if (onEvent)
      await onEvent({ type: "task_error", task_id: taskId, message: String(err) });
  } finally {
    runningTasks.delete(taskId);
  }
}

export function pauseTask(taskId: string): boolean {
  const ex = runningTasks.get(taskId);
  if (!ex) return false;
  ex.pause();
  updateTask(ex.projectId, taskId, { status: "paused", paused: true });
  return true;
}

export function resumeTask(taskId: string): boolean {
  const ex = runningTasks.get(taskId);
  if (!ex) return false;
  // Only resume if the task is actually paused; otherwise the caller gets a misleading 200
  if (!ex.paused) return false;
  ex.resume();
  updateTask(ex.projectId, taskId, { status: "running", paused: false });
  return true;
}

export function cancelTask(taskId: string): boolean {
  const ex = runningTasks.get(taskId);
  if (!ex) return false;
  ex.cancelled = true;
  ex.currentRunner?.cancel();
  ex.resume(); // unblock if paused
  return true;
}

export function setNextAgent(taskId: string, agentName: string | null): boolean {
  const ex = runningTasks.get(taskId);
  if (!ex) return false;
  // Only valid when the task is paused and actively waiting for an agent selection.
  // Prevents silently bypassing the human-in-the-loop checkpoint on running tasks.
  if (!ex.choosingAgent) return false;
  ex.nextAgentChoice = agentName;
  ex.resume();
  updateTask(ex.projectId, taskId, { status: "running", paused: false });
  return true;
}

export function resolvePermission(
  taskId: string,
  permissionId: string,
  behavior: "allow" | "deny",
  message?: string,
): boolean {
  const ex = runningTasks.get(taskId);
  if (!ex) return false;
  const response: PermissionResponse = { id: permissionId, behavior };
  if (message) response.message = message;
  return ex.resolvePermission(permissionId, response);
}

export function injectContext(taskId: string, context: string): boolean {
  const ex = runningTasks.get(taskId);
  if (!ex) return false;
  ex.extraContext = context;
  return true;
}

export async function askAgent(
  projectId: string,
  taskId: string,
  agentName: string,
  message: string,
  onEvent: EventCallback | null = null,
): Promise<void> {
  try {
    const taskData = await storage.readJson<Record<string, unknown>>(
      path.join(storage.projectTasksDir(projectId), taskId, "task.json"),
    );
    if (!taskData) {
      if (onEvent)
        await onEvent({ type: "ask_agent_error", task_id: taskId, agent: agentName, message: "Task not found" });
      return;
    }

    // Build context from existing artifacts
    const artifacts = await listArtifacts(projectId, taskId);
    let context = "";
    if (artifacts.length > 0) {
      const parts = ["Previous artifacts from this task:"];
      for (const art of artifacts) {
        parts.push(`\n--- ${art.type ?? "unknown"} (by ${art.agent ?? "unknown"}) ---`);
        let content = String(art.content ?? "");
        if (content.length > 3000) content = content.slice(0, 3000) + "\n... (truncated)";
        parts.push(content);
      }
      context = parts.join("\n");
    }

    const userMessage = `Task: ${taskData.title ?? ""}\n${taskData.description ?? ""}\n\nThe user has a question for you:\n${message}`;

    await appendTerminalMessage(projectId, taskId, agentName, "user", message);

    if (onEvent) {
      await onEvent({ type: "ask_agent_started", task_id: taskId, agent: agentName });
    }

    // Use worktree path if available
    const cwdOverride = taskData?.worktree_path as string | undefined;
    const runner = await createRunner(projectId, agentName,
      cwdOverride && fs.existsSync(cwdOverride) ? cwdOverride : undefined);
    let fullResponse = "";

    for await (const chunk of runner.stream(userMessage, context)) {
      fullResponse += chunk;
      if (onEvent) {
        await onEvent({ type: "ask_agent_chunk", task_id: taskId, agent: agentName, content: chunk });
      }
    }

    await updateLastTerminalMessage(projectId, taskId, agentName, fullResponse);

    if (onEvent) {
      await onEvent({ type: "ask_agent_done", task_id: taskId, agent: agentName });
    }
  } catch (err) {
    if (onEvent) {
      try {
        await onEvent({
          type: "ask_agent_error",
          task_id: taskId,
          agent: agentName,
          message: String(err),
        });
      } catch { /* ignore */ }
    }
  }
}

export async function runSingleAgent(
  projectId: string,
  taskId: string,
  agentName: string,
  extraContext: string | null = null,
  onEvent: EventCallback | null = null,
): Promise<void> {
  const pipeline = { id: "manual", name: "manual", start_agent: agentName };
  const execution = new TaskExecution(projectId, taskId, pipeline);
  execution.extraContext = extraContext;

  // Reuse existing worktree or create one
  const taskData = await storage.readJson<Record<string, unknown>>(
    path.join(storage.projectTasksDir(projectId), taskId, "task.json"),
  );
  const existingWt = taskData?.worktree_path as string | undefined;
  if (existingWt && fs.existsSync(existingWt)) {
    execution.worktreePath = existingWt;
  } else {
    const [wtPath, branchName] = await setupWorktree(projectId, taskId);
    execution.worktreePath = wtPath;
    if (wtPath) {
      updateTask(projectId, taskId, { worktree_path: wtPath, branch_name: branchName });
    }
  }

  runningTasks.set(taskId, execution);

  await updateTask(projectId, taskId, { status: "running", current_agent: agentName });

  if (onEvent) await onEvent({ type: "task_started", task_id: taskId, pipeline: "manual" });

  try {
    const [signal, suggestedAgent] = await executeAgent(execution, agentName, onEvent);

    if (execution.cancelled) {
      await updateTask(projectId, taskId, { status: "cancelled" });
      if (onEvent) await onEvent({ type: "task_cancelled", task_id: taskId });
      return;
    }

    if (signal === "needs_input") return; // already paused by executeAgent

    // Pause for user to choose next agent
    execution.nextAgentChoice = undefined;
    execution.pause();
    await updateTask(projectId, taskId, { status: "choosing_agent", paused: true });

    if (onEvent) {
      await onEvent({
        type: "choose_next_agent",
        task_id: taskId,
        agent: agentName,
        suggested_agent: suggestedAgent,
      });
    }

    await execution.waitIfPaused();
    if (execution.cancelled) {
      await updateTask(projectId, taskId, { status: "cancelled" });
      if (onEvent) await onEvent({ type: "task_cancelled", task_id: taskId });
      return;
    }

    const nextAgent = execution.nextAgentChoice ?? null;
    if (nextAgent) {
      await executePipelineLoop(execution, nextAgent, onEvent);
    } else {
      await updateTask(projectId, taskId, { status: "completed" });
      if (onEvent) await onEvent({ type: "task_completed", task_id: taskId });
    }
  } catch (err) {
    await updateTask(projectId, taskId, { status: "error" });
    if (onEvent) await onEvent({ type: "task_error", task_id: taskId, message: String(err) });
  } finally {
    runningTasks.delete(taskId);
  }
}

export function getExecutionStatus(taskId: string): Record<string, unknown> | null {
  const ex = runningTasks.get(taskId);
  if (!ex) return null;
  return {
    task_id: taskId,
    pipeline: ex.pipeline.name,
    current_agent: ex.currentAgent,
    iteration: ex.iteration,
    max_iterations: MAX_ITERATIONS,
    paused: ex.paused,
    cancelled: ex.cancelled,
  };
}
