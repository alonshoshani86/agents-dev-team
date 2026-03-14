/**
 * File-based JSON storage layer. All file I/O goes through this module.
 */

import fs from "fs/promises";
import { existsSync, statSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "..", "data");

export function generateId(): string {
  return randomBytes(6).toString("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

// --- JSON file operations ---

export async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function deletePath(targetPath: string): Promise<boolean> {
  try {
    const stat = statSync(targetPath);
    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
    } else {
      await fs.unlink(targetPath);
    }
    return true;
  } catch {
    return false;
  }
}

// --- Directory operations ---

export async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileTreeNode[];
}

export async function listFilesRecursive(
  dirPath: string,
  basePath?: string,
): Promise<FileTreeNode[]> {
  const base = basePath ?? dirPath;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => {
      // dirs first, then files
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const result: FileTreeNode[] = [];
    for (const entry of sorted) {
      const fullPath = path.join(dirPath, entry.name);
      const rel = path.relative(base, fullPath);
      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: rel,
          type: "directory",
          children: await listFilesRecursive(fullPath, base),
        });
      } else {
        const stat = await fs.stat(fullPath);
        result.push({
          name: entry.name,
          path: rel,
          type: "file",
          size: stat.size,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

// --- Project-specific helpers ---

export function projectsDir(): string {
  return path.join(DATA_DIR, "projects");
}

export function projectDir(projectId: string): string {
  return path.join(projectsDir(), projectId);
}

export function projectJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), "project.json");
}

export function projectContextPath(projectId: string): string {
  return path.join(projectDir(projectId), "context.json");
}

export function projectTasksDir(projectId: string): string {
  return path.join(projectDir(projectId), "tasks");
}

export function projectAgentsDir(projectId: string): string {
  return path.join(projectDir(projectId), "agents");
}

export function projectPipelinesDir(projectId: string): string {
  return path.join(projectDir(projectId), "pipelines");
}

export async function projectFilesDir(projectId: string): Promise<string> {
  const projectData = await readJson<Record<string, unknown>>(projectJsonPath(projectId));
  if (projectData) {
    const paths = (projectData.paths as Array<{ path?: string }>) ?? [];
    if (paths.length > 0 && paths[0].path) {
      const p = paths[0].path;
      if (existsSync(p) && statSync(p).isDirectory()) {
        return p;
      }
    }
  }
  return path.join(projectDir(projectId), "files");
}

export async function projectAllPaths(
  projectId: string,
): Promise<Array<{ label: string; path: string }>> {
  const projectData = await readJson<Record<string, unknown>>(projectJsonPath(projectId));
  if (!projectData) return [];
  const paths = (projectData.paths as Array<{ label?: string; path?: string }>) ?? [];
  return paths.filter(
    (p): p is { label: string; path: string } =>
      !!p.path && existsSync(p.path) && statSync(p.path).isDirectory(),
  );
}

export function configPath(): string {
  return path.join(DATA_DIR, "config.json");
}

export async function initProjectDirs(projectId: string): Promise<void> {
  await fs.mkdir(projectTasksDir(projectId), { recursive: true });
  await fs.mkdir(projectAgentsDir(projectId), { recursive: true });
  await fs.mkdir(projectPipelinesDir(projectId), { recursive: true });
  await fs.mkdir(path.join(projectDir(projectId), "files"), { recursive: true });
}

// --- Slug helpers ---

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export async function uniqueTaskSlug(projectId: string, baseSlug: string): Promise<string> {
  let slug = baseSlug;
  let counter = 2;
  const tasksDir = projectTasksDir(projectId);
  while (await fs.access(path.join(tasksDir, slug)).then(() => true).catch(() => false)) {
    slug = `${baseSlug.slice(0, 47)}-${counter++}`;
  }
  return slug;
}
