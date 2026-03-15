/**
 * Project CRUD routes.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, statSync } from "fs";
import * as storage from "../storage.js";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  // POST /projects
  app.post<{
    Body: {
      name?: string;
      description?: string;
      tech_stack?: string[];
      paths?: Array<{ label?: string; path?: string }>;
    };
  }>("/projects", async (req, reply) => {
    const { name, description = "", tech_stack = [], paths = [] } = req.body ?? {};

    if (!name || typeof name !== "string" || name.trim() === "") {
      return reply.code(400).send({ detail: "name is required" });
    }

    const validPaths = (paths ?? []).filter(
      (p) => p.path && typeof p.path === "string" && p.path.trim() !== "",
    );
    if (validPaths.length === 0) {
      return reply.code(400).send({ detail: "at least one repo path is required" });
    }

    const projectId = storage.generateId();
    const project = {
      id: projectId,
      name,
      description,
      tech_stack,
      paths: validPaths,
      status: "active",
      created_at: storage.nowIso(),
    };

    await storage.initProjectDirs(projectId);
    await storage.writeJson(storage.projectJsonPath(projectId), project);

    const context = {
      conventions: [],
      architecture_decisions: [],
      known_patterns: [],
      tech_constraints: [],
    };
    await storage.writeJson(storage.projectContextPath(projectId), context);

    reply.code(201);
    return project;
  });

  // GET /projects
  app.get("/projects", async () => {
    const dirs = await storage.listDirs(storage.projectsDir());
    const projects = [];
    for (const dir of dirs) {
      const data = await storage.readJson(storage.projectJsonPath(dir));
      if (data) projects.push(data);
    }
    return projects;
  });

  // GET /projects/:projectId
  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (req, reply) => {
    const data = await storage.readJson(storage.projectJsonPath(req.params.projectId));
    if (!data) return reply.code(404).send({ detail: "Project not found" });
    return data;
  });

  // PUT /projects/:projectId
  app.put<{
    Params: { projectId: string };
    Body: Record<string, unknown>;
  }>("/projects/:projectId", async (req, reply) => {
    const data = await storage.readJson<Record<string, unknown>>(
      storage.projectJsonPath(req.params.projectId),
    );
    if (!data) return reply.code(404).send({ detail: "Project not found" });

    const allowed = ["name", "description", "tech_stack", "paths", "status"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    await storage.writeJson(storage.projectJsonPath(req.params.projectId), data);
    return data;
  });

  // DELETE /projects/:projectId
  app.delete<{ Params: { projectId: string } }>("/projects/:projectId", async (req, reply) => {
    const dir = storage.projectDir(req.params.projectId);
    if (!existsSync(dir)) return reply.code(404).send({ detail: "Project not found" });
    await storage.deletePath(dir);
    return { deleted: true };
  });

  // GET /projects/:projectId/git-branch
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/git-branch",
    async (req, reply) => {
      const data = await storage.readJson<Record<string, unknown>>(
        storage.projectJsonPath(req.params.projectId),
      );
      if (!data) return reply.code(404).send({ detail: "Project not found" });

      const paths = (data.paths as Array<{ path?: string }>) ?? [];
      if (paths.length === 0) return { branch: null };

      const cwd = paths[0].path ?? "";
      if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return { branch: null };
      }

      try {
        // execFile avoids shell injection: cwd is a validated directory, no shell is spawned
        const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
        return { branch: stdout.trim() };
      } catch {
        return { branch: null };
      }
    },
  );
}
