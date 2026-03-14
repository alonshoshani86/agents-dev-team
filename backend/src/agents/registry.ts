/**
 * Agent registry: loads agent configs and creates runners.
 */

import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as storage from "../storage.js";
import { AgentRunner } from "./runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", ".next",
  "dist", "build", ".cache", ".mypy_cache", ".pytest_cache",
  "coverage", ".tox", "egg-info",
]);

const MAX_FILE_SIZE = 8000;
const MAX_TOTAL_CONTEXT = 50000;

export const AGENT_NAMES = ["product", "architect", "dev", "test", "uxui"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

const DEFAULTS_DIR = path.join(__dirname, "..", "..", "agents", "defaults");

// --- Directory tree scanner (synchronous) ---

function scanDirTree(root: string, prefix = "", depth = 0, maxDepth = 4): string[] {
  if (depth > maxDepth || !existsSync(root) || !statSync(root).isDirectory()) return [];
  const lines: string[] = [];
  try {
    const names = readdirSync(root);
    const sorted = names.sort((a, b) => {
      const aIsDir = statSync(path.join(root, a)).isDirectory();
      const bIsDir = statSync(path.join(root, b)).isDirectory();
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    });
    for (const name of sorted) {
      if (name.startsWith(".") && name !== ".env.example") continue;
      const fullPath = path.join(root, name);
      const isDir = statSync(fullPath).isDirectory();
      if (isDir && IGNORE_DIRS.has(name)) continue;
      if (isDir) {
        lines.push(`${prefix}${name}/`);
        lines.push(...scanDirTree(fullPath, prefix + "  ", depth + 1, maxDepth));
      } else {
        lines.push(`${prefix}${name}`);
      }
    }
  } catch {
    // permission denied or other error
  }
  return lines;
}

function readKeyFiles(root: string): Array<{ path: string; content: string }> {
  const keyPatterns = [
    "README.md", "SPEC.md", "SPECS.md", "package.json", "requirements.txt",
    "pyproject.toml", "tsconfig.json", "vite.config.ts", "vite.config.js",
  ];
  const results: Array<{ path: string; content: string }> = [];
  for (const pattern of keyPatterns) {
    const filePath = path.join(root, pattern);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
    try {
      let content = readFileSync(filePath, "utf-8");
      if (content.length > MAX_FILE_SIZE) {
        content = content.slice(0, MAX_FILE_SIZE) + "\n... (truncated)";
      }
      results.push({ path: path.relative(root, filePath), content });
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

function buildFilesContext(projectData: Record<string, unknown>): string {
  let projPaths = (projectData.paths as Array<{ label?: string; path?: string }>) ?? [];
  if (projPaths.length === 0 && projectData.repo_path) {
    projPaths = [{ label: "repo", path: String(projectData.repo_path) }];
  }

  const parts: string[] = [];
  let totalChars = 0;

  for (const pp of projPaths) {
    const dirPath = pp.path ?? "";
    if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue;
    const label = pp.label ?? "repo";

    const tree = scanDirTree(dirPath);
    if (tree.length > 0) {
      parts.push(
        `<directory-tree label="${label}" path="${dirPath}">\n${tree.join("\n")}\n</directory-tree>`,
      );
    }

    const keyFiles = readKeyFiles(dirPath);
    for (const kf of keyFiles) {
      if (totalChars + kf.content.length > MAX_TOTAL_CONTEXT) break;
      parts.push(`<file path="${label}/${kf.path}">\n${kf.content}\n</file>`);
      totalChars += kf.content.length;
    }
  }

  return parts.join("\n\n");
}

// --- Agent config ---

async function loadDefaultConfig(agentName: string): Promise<Record<string, unknown>> {
  const filePath = path.join(DEFAULTS_DIR, `${agentName}.json`);
  const data = await storage.readJson<Record<string, unknown>>(filePath);
  return data ?? { name: agentName, display_name: agentName, system_prompt: "", model: null };
}

async function loadProjectConfig(
  projectId: string,
  agentName: string,
): Promise<Record<string, unknown> | null> {
  const filePath = path.join(storage.projectAgentsDir(projectId), `${agentName}.json`);
  return storage.readJson<Record<string, unknown>>(filePath);
}

export async function getAgentConfig(
  projectId: string,
  agentName: string,
): Promise<Record<string, unknown>> {
  const config = await loadDefaultConfig(agentName);

  const projectConfig = await loadProjectConfig(projectId, agentName);
  if (projectConfig) {
    if (projectConfig.system_prompt) config.system_prompt = projectConfig.system_prompt;
    if (projectConfig.model) config.model = projectConfig.model;
    if (projectConfig.display_name) config.display_name = projectConfig.display_name;
  }

  return config;
}

export async function saveAgentConfig(
  projectId: string,
  agentName: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const filePath = path.join(storage.projectAgentsDir(projectId), `${agentName}.json`);
  await storage.writeJson(filePath, overrides);
}

export async function createRunner(projectId: string, agentName: string): Promise<AgentRunner> {
  const config = await getAgentConfig(projectId, agentName);

  const projectData = await storage.readJson<Record<string, unknown>>(
    storage.projectJsonPath(projectId),
  );
  const projectContext = await storage.readJson<Record<string, unknown>>(
    storage.projectContextPath(projectId),
  );

  let systemPrompt = String(config.system_prompt ?? "");

  // Inject project context
  if (projectData || projectContext) {
    const contextParts: string[] = [];
    if (projectData) {
      contextParts.push(`Project: ${projectData.name ?? "Unknown"}`);
      if (projectData.description) contextParts.push(`Description: ${projectData.description}`);
      if (Array.isArray(projectData.tech_stack) && projectData.tech_stack.length > 0) {
        contextParts.push(`Tech Stack: ${(projectData.tech_stack as string[]).join(", ")}`);
      }
      let paths = (projectData.paths as Array<{ label?: string; path?: string }>) ?? [];
      if (paths.length === 0 && projectData.repo_path) {
        paths = [{ label: "repo", path: String(projectData.repo_path) }];
      }
      const pathLines = paths.filter((p) => p.path).map((p) => `  - ${p.label ?? "repo"}: ${p.path}`);
      if (pathLines.length > 0) {
        contextParts.push("Project paths:\n" + pathLines.join("\n"));
      }
    }
    if (projectContext) {
      const ctx = projectContext as Record<string, unknown[]>;
      if (Array.isArray(ctx.conventions) && ctx.conventions.length > 0) {
        contextParts.push(`Conventions: ${(ctx.conventions as string[]).join(", ")}`);
      }
      if (Array.isArray(ctx.architecture_decisions) && ctx.architecture_decisions.length > 0) {
        contextParts.push(`Architecture Decisions: ${(ctx.architecture_decisions as string[]).join(", ")}`);
      }
      if (Array.isArray(ctx.tech_constraints) && ctx.tech_constraints.length > 0) {
        contextParts.push(`Tech Constraints: ${(ctx.tech_constraints as string[]).join(", ")}`);
      }
    }

    if (contextParts.length > 0) {
      systemPrompt += `\n\n<project-info>\n${contextParts.join("\n")}\n</project-info>`;
    }
  }

  // Inject file context
  if (projectData) {
    const filesContext = buildFilesContext(projectData);
    if (filesContext) {
      systemPrompt += `\n\n<project-files>\n${filesContext}\n</project-files>`;
    }
  }

  // Determine working directory
  let cwd: string | null = null;
  if (projectData) {
    let paths = (projectData.paths as Array<{ path?: string }>) ?? [];
    if (paths.length === 0 && projectData.repo_path) {
      paths = [{ path: String(projectData.repo_path) }];
    }
    for (const pp of paths) {
      if (pp.path && existsSync(pp.path) && statSync(pp.path).isDirectory()) {
        cwd = pp.path;
        break;
      }
    }
  }

  return new AgentRunner({
    name: agentName,
    systemPrompt,
    model: (config.model as string | null) ?? null,
    cwd,
  });
}

export async function listAgents(projectId: string): Promise<unknown[]> {
  const agents = [];
  for (const name of AGENT_NAMES) {
    const config = await getAgentConfig(projectId, name);
    agents.push({
      name,
      display_name: config.display_name ?? name,
      status: "idle",
      current_task_id: null,
    });
  }
  return agents;
}
