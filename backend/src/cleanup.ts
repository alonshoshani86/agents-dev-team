/**
 * CleanupScanner — finds orphaned files in a project's data directory.
 * Read-only by design; deletion is handled by the route layer.
 */

import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import * as storage from "./storage.js";

export type FileCategory = "tasks" | "artifacts" | "pipelines" | "files";
export type FileCertainty = "safe" | "uncertain";

export interface UnusedFile {
  path: string;          // Relative to project data root
  abs_path: string;      // Absolute filesystem path
  size_bytes: number;
  last_modified: string; // ISO 8601
  reason: string;
  category: FileCategory;
  certainty: FileCertainty;
}

export interface CleanupScanResult {
  scan_id: string;
  scanned_at: string;
  categories: {
    tasks: UnusedFile[];
    artifacts: UnusedFile[];
    pipelines: UnusedFile[];
    files: UnusedFile[];
  };
  summary: {
    total_files: number;
    total_size_bytes: number;
  };
}

/** Statuses that mean a task is actively being worked on (protected). */
const ACTIVE_TASK_STATUSES = new Set([
  "pending",
  "choosing_agent",
  "running",
  "paused",
  "waiting_input",
]);

/** Statuses where a task is considered completed work (deletable). */
const DONE_TASK_STATUSES = new Set(["completed", "cancelled", "failed", "interrupted"]);

/** Recursively compute total size in bytes of a path (file or directory). */
export async function getSize(fsPath: string): Promise<number> {
  try {
    const stat = await fs.stat(fsPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(fsPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await getSize(path.join(fsPath, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/** Collect pipeline IDs referenced by any task in the project. */
async function collectReferencedPipelineIds(projectId: string): Promise<Set<string>> {
  const tasksDir = storage.projectTasksDir(projectId);
  const taskIds = await storage.listDirs(tasksDir);
  const referenced = new Set<string>();

  for (const taskId of taskIds) {
    const taskPath = path.join(tasksDir, taskId, "task.json");
    const task = await storage.readJson<Record<string, unknown>>(taskPath);
    if (task?.pipeline_id && typeof task.pipeline_id === "string") {
      referenced.add(task.pipeline_id);
    }
  }
  return referenced;
}

/**
 * Build a reference set from task history and artifacts — used when scanning
 * the files/ directory for unreferenced working files.
 */
async function buildFileReferenceSet(projectId: string): Promise<Set<string>> {
  const tasksDir = storage.projectTasksDir(projectId);
  const taskIds = await storage.listDirs(tasksDir);
  const refs = new Set<string>();

  for (const taskId of taskIds) {
    const taskDir = path.join(tasksDir, taskId);

    // Check history.json for any path-like strings
    const historyPath = path.join(taskDir, "history.json");
    const history = await storage.readTextFile(historyPath);
    if (history) extractPaths(history, refs);

    // Check artifact markdown files
    const artifactsDir = path.join(taskDir, "artifacts");
    try {
      const artifactFiles = await fs.readdir(artifactsDir);
      for (const f of artifactFiles) {
        if (f.endsWith(".md")) {
          const content = await storage.readTextFile(path.join(artifactsDir, f));
          if (content) extractPaths(content, refs);
        }
      }
    } catch {
      // artifacts dir may not exist
    }
  }
  return refs;
}

/** Extract relative path mentions (e.g. "files/foo.png") from a text blob. */
function extractPaths(text: string, out: Set<string>): void {
  // Match simple relative paths that look like files/... or src/... etc.
  const re = /\bfiles\/[^\s"'`)\]>]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[0]);
  }
}

/** Recursively list all files under a directory, returning relative paths. */
async function listAllFilesRelative(dirPath: string, base: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        result.push(...(await listAllFilesRelative(full, base)));
      } else {
        result.push(path.relative(base, full));
      }
    }
  } catch {
    // dir may not exist
  }
  return result;
}

/**
 * Check whether any task OTHER than the given one references it — used to
 * determine if a completed task's artifacts are still needed downstream.
 */
async function hasSuccessorReferences(taskId: string, tasksDir: string): Promise<boolean> {
  const allTaskIds = await storage.listDirs(tasksDir);
  for (const otherId of allTaskIds) {
    if (otherId === taskId) continue;
    // Search task.json and history.json for any mention of the task ID
    const taskJsonContent = await storage.readTextFile(path.join(tasksDir, otherId, "task.json"));
    if (taskJsonContent?.includes(taskId)) return true;
    const historyContent = await storage.readTextFile(path.join(tasksDir, otherId, "history.json"));
    if (historyContent?.includes(taskId)) return true;
  }
  return false;
}

/**
 * Scan artifacts directories of ACTIVE tasks for superseded old artifact
 * versions (e.g. prd-v1.md when prd-v2.md also exists).
 */
async function scanArtifacts(
  tasksDir: string,
  projectRoot: string,
  scannedAt: string,
): Promise<UnusedFile[]> {
  const unusedArtifacts: UnusedFile[] = [];
  const taskIds = await storage.listDirs(tasksDir);

  for (const taskId of taskIds) {
    const taskDir = path.join(tasksDir, taskId);
    const task = await storage.readJson<Record<string, unknown>>(path.join(taskDir, "task.json"));
    if (!task) continue;

    const status = String(task.status ?? "");
    // Only inspect artifacts inside active tasks; done-task dirs are flagged wholesale
    if (!ACTIVE_TASK_STATUSES.has(status)) continue;

    const artifactsDir = path.join(taskDir, "artifacts");
    let artifactFiles: string[];
    try {
      artifactFiles = await fs.readdir(artifactsDir);
    } catch {
      continue;
    }

    // Group files by base name, stripping trailing version suffixes like -v1, -run2
    const groups = new Map<string, string[]>();
    for (const fname of artifactFiles) {
      if (!fname.endsWith(".md")) continue;
      const base = fname.replace(/-v\d+\.md$/, "").replace(/-run\d+\.md$/, "");
      const group = groups.get(base) ?? [];
      group.push(fname);
      groups.set(base, group);
    }

    // Flag all but the latest (alphabetically highest) version in each group
    for (const [, files] of groups) {
      if (files.length <= 1) continue;
      const sorted = [...files].sort();
      const oldVersions = sorted.slice(0, -1);
      for (const fname of oldVersions) {
        const absPath = path.join(artifactsDir, fname);
        const stat = await fs.stat(absPath).catch(() => null);
        unusedArtifacts.push({
          path: path.relative(projectRoot, absPath),
          abs_path: absPath,
          size_bytes: stat?.size ?? 0,
          last_modified: stat ? stat.mtime.toISOString() : scannedAt,
          reason: "Older artifact version superseded by a newer version in the same task",
          category: "artifacts",
          certainty: "uncertain",
        });
      }
    }
  }

  return unusedArtifacts;
}

export async function scanProject(projectId: string): Promise<CleanupScanResult> {
  const scanId = `scan-${Date.now()}`;
  const scannedAt = new Date().toISOString();
  const projectRoot = storage.projectDir(projectId);

  const tasksDir = storage.projectTasksDir(projectId);
  const pipelinesDir = storage.projectPipelinesDir(projectId);
  const filesDir = path.join(projectRoot, "files");

  const unusedTasks: UnusedFile[] = [];
  const unusedArtifacts: UnusedFile[] = [];
  const unusedPipelines: UnusedFile[] = [];
  const unusedFiles: UnusedFile[] = [];

  // ── 1. Scan tasks/ ─────────────────────────────────────────────────────────
  const taskIds = await storage.listDirs(tasksDir);
  for (const taskId of taskIds) {
    const taskDir = path.join(tasksDir, taskId);
    const taskPath = path.join(taskDir, "task.json");
    const task = await storage.readJson<Record<string, unknown>>(taskPath);
    if (!task) continue;

    const status = String(task.status ?? "");

    // Skip active / in-progress tasks
    if (ACTIVE_TASK_STATUSES.has(status)) continue;

    if (DONE_TASK_STATUSES.has(status)) {
      const stat = await fs.stat(taskDir).catch(() => null);
      const sizeBytes = await getSize(taskDir);
      const lastModified = stat ? stat.mtime.toISOString() : scannedAt;

      let reason: string;
      if (status === "cancelled") {
        reason = "Task was cancelled";
      } else if (status === "failed") {
        reason = "Task failed — no active references remain";
      } else if (status === "interrupted") {
        reason = "Task was interrupted and never resumed";
      } else {
        reason = "Task completed — artifacts can be archived or removed";
      }

      // For completed tasks, check if any other task references this one downstream.
      // If so, mark uncertain; if not, it is safe to delete.
      let certainty: FileCertainty = "safe";
      if (status === "completed") {
        const referencedBySuccessor = await hasSuccessorReferences(taskId, tasksDir);
        certainty = referencedBySuccessor ? "uncertain" : "safe";
      }

      unusedTasks.push({
        path: path.relative(projectRoot, taskDir),
        abs_path: taskDir,
        size_bytes: sizeBytes,
        last_modified: lastModified,
        reason,
        category: "tasks",
        certainty,
      });
    }
  }

  // ── 2. Scan artifacts inside active tasks ─────────────────────────────────
  unusedArtifacts.push(...(await scanArtifacts(tasksDir, projectRoot, scannedAt)));

  // ── 3. Scan pipelines/ ─────────────────────────────────────────────────────
  const referencedPipelineIds = await collectReferencedPipelineIds(projectId);
  try {
    const pipelineFiles = await fs.readdir(pipelinesDir);
    for (const fname of pipelineFiles) {
      if (!fname.endsWith(".json")) continue;
      const fullPath = path.join(pipelinesDir, fname);
      const pipeline = await storage.readJson<Record<string, unknown>>(fullPath);
      const pipelineId = (pipeline?.id as string | undefined) ?? fname.replace(".json", "");

      if (!referencedPipelineIds.has(pipelineId)) {
        const stat = await fs.stat(fullPath).catch(() => null);
        unusedPipelines.push({
          path: path.relative(projectRoot, fullPath),
          abs_path: fullPath,
          size_bytes: stat?.size ?? 0,
          last_modified: stat ? stat.mtime.toISOString() : scannedAt,
          reason: "Pipeline is not referenced by any task",
          category: "pipelines",
          certainty: "safe",
        });
      }
    }
  } catch {
    // pipelines dir may not exist
  }

  // ── 4. Scan files/ (opt-in, uncertain) ────────────────────────────────────
  if (existsSync(filesDir)) {
    const fileRefs = await buildFileReferenceSet(projectId);
    const allFiles = await listAllFilesRelative(filesDir, projectRoot);

    for (const relPath of allFiles) {
      // relPath is like "files/docs/foo.md"
      if (!fileRefs.has(relPath)) {
        const absPath = path.join(projectRoot, relPath);
        const stat = await fs.stat(absPath).catch(() => null);
        unusedFiles.push({
          path: relPath,
          abs_path: absPath,
          size_bytes: stat?.size ?? 0,
          last_modified: stat ? stat.mtime.toISOString() : scannedAt,
          reason: "No active task or artifact references this file (heuristic — verify before deleting)",
          category: "files",
          certainty: "uncertain",
        });
      }
    }
  }

  const allUnused = [...unusedTasks, ...unusedArtifacts, ...unusedPipelines, ...unusedFiles];
  return {
    scan_id: scanId,
    scanned_at: scannedAt,
    categories: {
      tasks: unusedTasks,
      artifacts: unusedArtifacts,
      pipelines: unusedPipelines,
      files: unusedFiles,
    },
    summary: {
      total_files: allUnused.length,
      total_size_bytes: allUnused.reduce((sum, f) => sum + f.size_bytes, 0),
    },
  };
}

/** Protected relative paths that must never be deleted. */
const ALWAYS_PROTECTED = new Set([
  "project.json",
  "context.json",
  "agents",
]);

/**
 * Root directories that must never be removed even when empty — deleting them
 * breaks project structure (future task creation, file writes, etc.).
 */
const PROTECTED_ROOT_DIRS = new Set([
  "agents",
  "tasks",
  "pipelines",
  "files",
]);

export function isProtectedPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/\/$/, "");
  // Top-level protected files/dirs
  if (ALWAYS_PROTECTED.has(norm)) return true;
  // agents/ directory and everything inside it
  if (norm === "agents" || norm.startsWith("agents/")) return true;
  return false;
}

/** Parse the timestamp out of a scan_id and check if it's older than 5 minutes. */
export function isScanExpired(scanId: string): boolean {
  const match = /^scan-(\d+)$/.exec(scanId);
  if (!match) return true;
  const ts = parseInt(match[1], 10);
  return Date.now() - ts > 5 * 60 * 1000;
}

/**
 * Remove empty directories bottom-up within rootPath.
 * Skips rootPath itself and any known protected root dirs.
 */
export async function pruneEmptyDirs(rootPath: string): Promise<number> {
  let removed = 0;

  async function prune(dir: string): Promise<boolean> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return false;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          const isEmpty = await prune(full);
          if (isEmpty) {
            await fs.rmdir(full);
            removed++;
          }
        }
      } catch {
        // ignore
      }
    }

    try {
      const remaining = await fs.readdir(dir);
      return remaining.length === 0;
    } catch {
      return false;
    }
  }

  // Only prune children, not rootPath itself
  try {
    const topLevel = await fs.readdir(rootPath);
    for (const entry of topLevel) {
      const full = path.join(rootPath, entry);
      const stat = await fs.stat(full).catch(() => null);
      if (stat?.isDirectory()) {
        const isEmpty = await prune(full);
        if (isEmpty && !PROTECTED_ROOT_DIRS.has(entry)) {
          await fs.rmdir(full);
          removed++;
        }
      }
    }
  } catch {
    // ignore
  }

  return removed;
}
