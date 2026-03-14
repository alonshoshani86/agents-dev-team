/**
 * File browsing routes for the folder picker UI.
 */

import { existsSync, statSync, readdirSync } from "fs";
import path from "path";
import os from "os";
import * as storage from "../storage.js";
import type { FastifyInstance } from "fastify";

async function getAllowedRoots(): Promise<string[]> {
  // Always allow the data/ directory and the user's home directory
  const roots: string[] = [path.resolve(storage.DATA_DIR), os.homedir()];

  try {
    const projectDirs = await storage.listDirs(storage.projectsDir());
    for (const projectId of projectDirs) {
      try {
        const projectData = await storage.readJson<Record<string, unknown>>(
          storage.projectJsonPath(projectId),
        );
        if (!projectData) continue;
        // project.json stores a single string at repo_path (not an array)
        const repoPath = projectData.repo_path as string | undefined;
        if (repoPath && existsSync(repoPath) && statSync(repoPath).isDirectory()) {
          roots.push(path.resolve(repoPath));
        }
      } catch {
        // Skip any project whose metadata can't be read
      }
    }
  } catch {
    // projects/ dir doesn't exist yet (fresh install) — that's fine, defaults above suffice
  }

  return roots;
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // GET /browse?path=...
  app.get<{ Querystring: { path?: string } }>("/browse", async (req, reply) => {
    const dirPath = req.query.path ?? os.homedir();
    const resolvedPath = path.resolve(dirPath);

    // Security: check if the resolved path is within an allowed root
    const allowedRoots = await getAllowedRoots();
    const isAllowed = allowedRoots.some(
      (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
    );

    if (!isAllowed) {
      return reply.code(403).send({ detail: "Access denied" });
    }

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      return { path: resolvedPath, dirs: [], error: "Not a directory" };
    }

    const dirs: Array<{ name: string; path: string }> = [];
    try {
      const entries = readdirSync(resolvedPath, { withFileTypes: true });
      const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          const fullPath = path.join(resolvedPath, entry.name);
          dirs.push({ name: entry.name, path: fullPath });
        }
      }
    } catch {
      return { path: resolvedPath, dirs: [], error: "Permission denied" };
    }

    // Get parent (don't go above /)
    const parent =
      resolvedPath === "/" ? null : resolvedPath.split("/").slice(0, -1).join("/") || "/";

    return { path: resolvedPath, parent, dirs };
  });
}
