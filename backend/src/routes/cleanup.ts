/**
 * Cleanup routes — scan and delete unused project files.
 *
 * GET  /projects/:projectId/cleanup/scan
 * POST /projects/:projectId/cleanup/delete
 */

import path from "path";
import * as storage from "../storage.js";
import * as scanner from "../cleanup.js";
import type { FastifyInstance } from "fastify";

export async function registerCleanupRoutes(app: FastifyInstance): Promise<void> {
  // GET /projects/:projectId/cleanup/scan
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/cleanup/scan",
    async (req, reply) => {
      const { projectId } = req.params;
      const projectData = await storage.readJson(storage.projectJsonPath(projectId));
      if (!projectData) return reply.code(404).send({ detail: "Project not found" });

      try {
        const result = await scanner.scanProject(projectId);
        return result;
      } catch (err) {
        app.log.error(err, "cleanup scan failed");
        return reply.code(500).send({ detail: "Failed to scan project files" });
      }
    },
  );

  // POST /projects/:projectId/cleanup/delete
  app.post<{
    Params: { projectId: string };
    Body: { scan_id: string; paths: string[] };
  }>("/projects/:projectId/cleanup/delete", async (req, reply) => {
    const { projectId } = req.params;
    const { scan_id, paths: requestedPaths } = req.body ?? {};

    if (!scan_id || !Array.isArray(requestedPaths) || requestedPaths.length === 0) {
      return reply.code(400).send({ detail: "scan_id and non-empty paths array are required" });
    }

    const projectData = await storage.readJson(storage.projectJsonPath(projectId));
    if (!projectData) return reply.code(404).send({ detail: "Project not found" });

    // Reject stale scans
    if (scanner.isScanExpired(scan_id)) {
      return reply.code(409).send({ error: "scan_expired", detail: "Scan is older than 5 minutes — please re-scan before deleting" });
    }

    const projectRoot = storage.projectDir(projectId);

    // Validate no protected paths are included
    for (const relPath of requestedPaths) {
      if (scanner.isProtectedPath(relPath)) {
        return reply.code(400).send({ detail: `Path is protected and cannot be deleted: ${relPath}` });
      }
    }

    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    let bytesFreed = 0;

    for (const relPath of requestedPaths) {
      // Normalise and resolve — guard against path traversal
      const normalised = path.normalize(relPath).replace(/\\/g, "/");
      if (normalised.startsWith("..") || path.isAbsolute(normalised)) {
        failed.push({ path: relPath, error: "Invalid path" });
        continue;
      }

      // Re-check protection at delete time (agent may have created new files)
      if (scanner.isProtectedPath(normalised)) {
        failed.push({ path: relPath, error: "Path became protected after scan" });
        continue;
      }

      const absPath = path.join(projectRoot, normalised);

      // Ensure path is inside the project root
      if (!absPath.startsWith(projectRoot + path.sep) && absPath !== projectRoot) {
        failed.push({ path: relPath, error: "Path is outside project root" });
        continue;
      }

      try {
        const sizeBeforeDelete = await scanner.getSize(absPath);
        const ok = await storage.deletePath(absPath);
        if (ok) {
          deleted.push(relPath);
          bytesFreed += sizeBeforeDelete;
        } else {
          failed.push({ path: relPath, error: "File not found or already deleted" });
        }
      } catch (err) {
        failed.push({ path: relPath, error: String(err) });
      }
    }

    // Prune empty directories left behind
    const emptyDirsRemoved = await scanner.pruneEmptyDirs(projectRoot);

    return { deleted, failed, bytes_freed: bytesFreed, empty_dirs_removed: emptyDirsRemoved };
  });
}

