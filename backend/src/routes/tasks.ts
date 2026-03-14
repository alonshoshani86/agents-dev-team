/**
 * Task CRUD routes with pipeline execution controls.
 */

import path from "path";
import * as storage from "../storage.js";
import * as engine from "../orchestrator/engine.js";
import * as wt from "../worktree.js";
import { listPipelines, getPipeline } from "../orchestrator/pipelines.js";
import { listArtifacts, updateArtifactContent, getHistory, loadTerminals } from "../orchestrator/models.js";
import { AGENT_NAMES } from "../agents/registry.js";
import type { FastifyInstance } from "fastify";

const VALID_AGENT_NAMES = AGENT_NAMES as readonly string[];

type Broadcast = (projectId: string, event: Record<string, unknown>) => Promise<void>;

function taskPath(projectId: string, taskId: string): string {
  return path.join(storage.projectTasksDir(projectId), taskId, "task.json");
}

async function getTask(
  projectId: string,
  taskId: string,
): Promise<Record<string, unknown> | null> {
  return storage.readJson<Record<string, unknown>>(taskPath(projectId, taskId));
}

export async function registerTaskRoutes(
  app: FastifyInstance,
  broadcast: Broadcast,
): Promise<void> {
  // POST /projects/:projectId/tasks
  app.post<{
    Params: { projectId: string };
    Body: { name: string; description?: string; priority?: string; pipeline_id?: string };
  }>("/projects/:projectId/tasks", async (req, reply) => {
    const project = await storage.readJson(storage.projectJsonPath(req.params.projectId));
    if (!project) return reply.code(404).send({ detail: "Project not found" });

    const baseSlug = storage.slugify(req.body.name);
    if (!baseSlug) return reply.code(400).send({ detail: "Task name produces an empty slug" });
    const taskId = await storage.uniqueTaskSlug(req.params.projectId, baseSlug);

    const task = {
      id: taskId,
      project_id: req.params.projectId,
      name: req.body.name,
      title: req.body.name,
      description: req.body.description ?? "",
      priority: req.body.priority ?? "medium",
      status: "pending",
      pipeline_id: req.body.pipeline_id ?? null,
      branch_name: "task/" + taskId,
      current_agent: null,
      current_step: null,
      paused: false,
      created_at: storage.nowIso(),
      updated_at: storage.nowIso(),
    };

    const taskDir = path.join(storage.projectTasksDir(req.params.projectId), taskId);
    const { mkdir } = await import("fs/promises");
    await mkdir(taskDir, { recursive: true });
    await storage.writeJson(taskPath(req.params.projectId, taskId), task);

    reply.code(201);
    return task;
  });

  // GET /projects/:projectId/tasks
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/tasks", async (req, reply) => {
    const project = await storage.readJson(storage.projectJsonPath(req.params.projectId));
    if (!project) return reply.code(404).send({ detail: "Project not found" });

    const { readdir } = await import("fs/promises");
    const tasksDir = storage.projectTasksDir(req.params.projectId);
    try {
      const entries = await readdir(tasksDir, { withFileTypes: true });
      const tasks: Record<string, unknown>[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const task = await storage.readJson<Record<string, unknown>>(
          path.join(tasksDir, entry.name, "task.json"),
        );
        if (task) tasks.push(task);
      }
      return tasks.sort((a, b) =>
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
      );
    } catch {
      return [];
    }
  });

  // GET /projects/:projectId/tasks/:taskId
  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId",
    async (req, reply) => {
      const task = await getTask(req.params.projectId, req.params.taskId);
      if (!task) return reply.code(404).send({ detail: "Task not found" });
      return task;
    },
  );

  // PUT /projects/:projectId/tasks/:taskId
  app.put<{
    Params: { projectId: string; taskId: string };
    Body: Record<string, unknown>;
  }>("/projects/:projectId/tasks/:taskId", async (req, reply) => {
    const task = await getTask(req.params.projectId, req.params.taskId);
    if (!task) return reply.code(404).send({ detail: "Task not found" });

    const allowed = ["title", "description", "priority", "status"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) task[key] = req.body[key];
    }
    task.updated_at = storage.nowIso();
    await storage.writeJson(taskPath(req.params.projectId, req.params.taskId), task);
    return task;
  });

  // DELETE /projects/:projectId/tasks/:taskId
  app.delete<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId",
    async (req, reply) => {
      const taskDir = path.join(
        storage.projectTasksDir(req.params.projectId),
        req.params.taskId,
      );
      const { existsSync } = await import("fs");
      if (!existsSync(taskDir)) return reply.code(404).send({ detail: "Task not found" });

      // Clean up git worktree if one was created for this task
      const task = await storage.readJson<Record<string, unknown>>(
        path.join(taskDir, "task.json"),
      );
      if (task?.worktree_path) {
        const repoPath = storage.getRepoPath(req.params.projectId);
        if (repoPath) {
          await wt.removeWorktree(repoPath, req.params.taskId);
        }
      }

      await storage.deletePath(taskDir);
      return { deleted: true };
    },
  );

  // GET /projects/:projectId/pipelines
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/pipelines", async (req) => {
    return listPipelines(req.params.projectId);
  });

  // POST /projects/:projectId/tasks/:taskId/run
  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { pipeline_id: string };
  }>("/projects/:projectId/tasks/:taskId/run", async (req, reply) => {
    const task = await getTask(req.params.projectId, req.params.taskId);
    if (!task) return reply.code(404).send({ detail: "Task not found" });

    const pipeline = await getPipeline(req.params.projectId, req.body.pipeline_id);
    if (!pipeline) return reply.code(404).send({ detail: "Pipeline not found" });

    const { projectId, taskId } = req.params;
    const pipelineId = req.body.pipeline_id;

    // Run in background — don't await
    setImmediate(() => {
      engine
        .startPipeline(projectId, taskId, pipelineId, (event) => broadcast(projectId, event))
        .catch(console.error);
    });

    return { status: "started", pipeline: pipeline.name };
  });

  // POST /projects/:projectId/tasks/:taskId/pause
  app.post<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId/pause",
    async (req, reply) => {
      const taskExists = await getTask(req.params.projectId, req.params.taskId);
      if (!taskExists) return reply.code(404).send({ detail: "Task not found" });
      if (!engine.pauseTask(req.params.taskId)) {
        return reply.code(400).send({ detail: "Task not running" });
      }
      await broadcast(req.params.projectId, {
        type: "task_paused",
        task_id: req.params.taskId,
      });
      return { status: "paused" };
    },
  );

  // POST /projects/:projectId/tasks/:taskId/resume
  app.post<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId/resume",
    async (req, reply) => {
      const task = await getTask(req.params.projectId, req.params.taskId);
      if (!task) return reply.code(404).send({ detail: "Task not found" });
      if (!engine.resumeTask(req.params.taskId)) {
        // Task not in memory (e.g. after server restart) — update status on disk
        task.status = "choosing_agent";
        task.paused = false;
        task.updated_at = storage.nowIso();
        await storage.writeJson(taskPath(req.params.projectId, req.params.taskId), task);
      }
      await broadcast(req.params.projectId, {
        type: "task_resumed",
        task_id: req.params.taskId,
      });
      return { status: "running" };
    },
  );

  // POST /projects/:projectId/tasks/:taskId/cancel
  app.post<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId/cancel",
    async (req, reply) => {
      const task = await getTask(req.params.projectId, req.params.taskId);
      if (!task) return reply.code(404).send({ detail: "Task not found" });

      const terminalStates = ["cancelled", "completed", "failed"];
      if (terminalStates.includes(String(task.status ?? ""))) {
        return reply.code(400).send({ detail: "Task is already in terminal state" });
      }

      engine.cancelTask(req.params.taskId);

      task.status = "cancelled";
      task.paused = false;
      task.updated_at = storage.nowIso();
      await storage.writeJson(taskPath(req.params.projectId, req.params.taskId), task);

      await broadcast(req.params.projectId, {
        type: "task_cancelled",
        task_id: req.params.taskId,
      });
      return { status: "cancelled" };
    },
  );

  // POST /projects/:projectId/tasks/:taskId/next-agent
  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { agent?: string | null };
  }>("/projects/:projectId/tasks/:taskId/next-agent", async (req, reply) => {
    const task = await getTask(req.params.projectId, req.params.taskId);
    if (!task) return reply.code(404).send({ detail: "Task not found" });

    const { projectId, taskId } = req.params;
    const agent = req.body.agent ?? null;

    if (engine.setNextAgent(taskId, agent)) {
      // Task was in memory — pipeline loop continues
      await broadcast(projectId, { type: "next_agent_chosen", task_id: taskId, agent });
      return { status: "ok", next_agent: agent };
    }

    // Task not in memory (e.g. after server restart) — handle gracefully
    if (agent === null) {
      // User chose "Finish" — mark as completed
      task.status = "completed";
      task.paused = false;
      task.updated_at = storage.nowIso();
      await storage.writeJson(taskPath(projectId, taskId), task);
      await broadcast(projectId, { type: "task_completed", task_id: taskId });
      return { status: "ok", next_agent: null };
    }

    // User chose an agent — start a fresh single-agent run
    setImmediate(() => {
      engine
        .runSingleAgent(projectId, taskId, agent, null, (event) => broadcast(projectId, event))
        .catch(console.error);
    });
    await broadcast(projectId, { type: "next_agent_chosen", task_id: taskId, agent });
    return { status: "ok", next_agent: agent };
  });

  // POST /projects/:projectId/tasks/:taskId/run-agent
  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { agent: string; context?: string };
  }>("/projects/:projectId/tasks/:taskId/run-agent", async (req, reply) => {
    const task = await getTask(req.params.projectId, req.params.taskId);
    if (!task) return reply.code(404).send({ detail: "Task not found" });

    const { projectId, taskId } = req.params;
    const { agent, context } = req.body;

    if (!VALID_AGENT_NAMES.includes(agent)) {
      return reply.code(400).send({
        detail: `Invalid agent name. Must be one of: ${VALID_AGENT_NAMES.join(", ")}`,
      });
    }

    setImmediate(() => {
      engine
        .runSingleAgent(projectId, taskId, agent, context ?? null, (event) =>
          broadcast(projectId, event),
        )
        .catch(console.error);
    });

    return { status: "started", agent };
  });

  // POST /projects/:projectId/tasks/:taskId/ask-agent
  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { agent: string; message: string };
  }>("/projects/:projectId/tasks/:taskId/ask-agent", async (req, reply) => {
    const task = await getTask(req.params.projectId, req.params.taskId);
    if (!task) return reply.code(404).send({ detail: "Task not found" });

    const { projectId, taskId } = req.params;
    const { agent, message } = req.body;

    if (!VALID_AGENT_NAMES.includes(agent)) {
      return reply.code(400).send({
        detail: `Invalid agent name. Must be one of: ${VALID_AGENT_NAMES.join(", ")}`,
      });
    }

    setImmediate(() => {
      engine
        .askAgent(projectId, taskId, agent, message, (event) => broadcast(projectId, event))
        .catch(console.error);
    });

    return { status: "asking", agent };
  });

  // POST /projects/:projectId/tasks/:taskId/permission-response
  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { permission_id: string; behavior: "allow" | "deny"; message?: string };
  }>("/projects/:projectId/tasks/:taskId/permission-response", async (req, reply) => {
    const { permission_id, behavior, message } = req.body;
    if (!engine.resolvePermission(req.params.taskId, permission_id, behavior, message)) {
      return reply.code(404).send({ detail: "No pending permission with that ID" });
    }
    await broadcast(req.params.projectId, {
      type: "permission_resolved",
      task_id: req.params.taskId,
      permission_id,
      behavior,
    });
    return { status: "resolved", behavior };
  });

  // POST /projects/:projectId/tasks/:taskId/inject
  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { context: string };
  }>("/projects/:projectId/tasks/:taskId/inject", async (req, reply) => {
    const taskExists = await getTask(req.params.projectId, req.params.taskId);
    if (!taskExists) return reply.code(404).send({ detail: "Task not found" });
    if (!engine.injectContext(req.params.taskId, req.body.context)) {
      return reply.code(400).send({ detail: "Task not running" });
    }
    return { status: "injected" };
  });

  // GET /projects/:projectId/tasks/:taskId/status
  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId/status",
    async (req, reply) => {
      const status = engine.getExecutionStatus(req.params.taskId);
      if (!status) {
        const task = await getTask(req.params.projectId, req.params.taskId);
        if (!task) return reply.code(404).send({ detail: "Task not found" });
        return { task_id: req.params.taskId, status: task.status ?? "unknown", running: false };
      }
      return { ...status, running: true };
    },
  );

  // GET /projects/:projectId/tasks/:taskId/history
  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId/history",
    async (req) => {
      return getHistory(req.params.projectId, req.params.taskId);
    },
  );

  // GET /projects/:projectId/tasks/:taskId/artifacts
  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId/artifacts",
    async (req) => {
      return listArtifacts(req.params.projectId, req.params.taskId);
    },
  );

  // PUT /projects/:projectId/tasks/:taskId/artifacts/:artifactType
  app.put<{
    Params: { projectId: string; taskId: string; artifactType: string };
    Body: { content: string };
  }>("/projects/:projectId/tasks/:taskId/artifacts/:artifactType", async (req, reply) => {
    const result = await updateArtifactContent(
      req.params.projectId,
      req.params.taskId,
      req.params.artifactType,
      req.body.content,
    );
    if (!result) return reply.code(404).send({ detail: "Artifact not found" });
    return result;
  });

  // GET /projects/:projectId/tasks/:taskId/terminals
  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/projects/:projectId/tasks/:taskId/terminals",
    async (req) => {
      return loadTerminals(req.params.projectId, req.params.taskId);
    },
  );
}
