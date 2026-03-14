/**
 * Data models for tasks, artifacts, history, and terminal logs.
 */

import fs from "fs/promises";
import path from "path";
import * as storage from "../storage.js";

// --- Artifacts ---

export async function createArtifact(
  projectId: string,
  taskId: string,
  artifactType: string,
  content: string,
  agent: string,
): Promise<Record<string, unknown>> {
  const artifactsDir = path.join(storage.projectTasksDir(projectId), taskId, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });

  const contentPath = path.join(artifactsDir, `${artifactType}.md`);
  const metaPath = path.join(artifactsDir, `${artifactType}.json`);

  const existingMeta = await storage.readJson<Record<string, unknown>>(metaPath);
  const artifactId = (existingMeta?.id as string | undefined) ?? storage.generateId();

  const artifact: Record<string, unknown> = {
    id: artifactId,
    type: artifactType,
    agent,
    updated_at: storage.nowIso(),
  };

  artifact.created_at =
    (existingMeta?.created_at as string | undefined) ?? artifact.updated_at;

  await storage.writeTextFile(contentPath, content);
  await storage.writeJson(metaPath, artifact);

  return { ...artifact, content };
}

export async function getArtifact(
  projectId: string,
  taskId: string,
  artifactType: string,
): Promise<Record<string, unknown> | null> {
  const artifactsDir = path.join(storage.projectTasksDir(projectId), taskId, "artifacts");
  const contentPath = path.join(artifactsDir, `${artifactType}.md`);

  const content = await storage.readTextFile(contentPath);
  if (content === null) return null;

  const metaPath = path.join(artifactsDir, `${artifactType}.json`);
  const meta = (await storage.readJson<Record<string, unknown>>(metaPath)) ?? {};

  return { ...meta, content };
}

export async function listArtifacts(
  projectId: string,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const artifactsDir = path.join(storage.projectTasksDir(projectId), taskId, "artifacts");
  try {
    const entries = await fs.readdir(artifactsDir);
    const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();

    const artifacts: Record<string, unknown>[] = [];
    for (const jsonFile of jsonFiles) {
      const metaPath = path.join(artifactsDir, jsonFile);
      const meta = await storage.readJson<Record<string, unknown>>(metaPath);
      if (!meta) continue;
      const mdFile = jsonFile.replace(".json", ".md");
      const content = await storage.readTextFile(path.join(artifactsDir, mdFile));
      if (content !== null) {
        artifacts.push({ ...meta, content });
      }
    }
    return artifacts;
  } catch {
    return [];
  }
}

export async function updateArtifactContent(
  projectId: string,
  taskId: string,
  artifactType: string,
  content: string,
): Promise<Record<string, unknown> | null> {
  const artifactsDir = path.join(storage.projectTasksDir(projectId), taskId, "artifacts");
  const contentPath = path.join(artifactsDir, `${artifactType}.md`);

  const existing = await storage.readTextFile(contentPath);
  if (existing === null) return null;

  await storage.writeTextFile(contentPath, content);

  const metaPath = path.join(artifactsDir, `${artifactType}.json`);
  const meta = (await storage.readJson<Record<string, unknown>>(metaPath)) ?? {};
  meta.updated_at = storage.nowIso();
  await storage.writeJson(metaPath, meta);

  return { ...meta, content };
}

// --- Task History ---

export async function appendHistory(
  projectId: string,
  taskId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const taskDir = path.join(storage.projectTasksDir(projectId), taskId);
  await fs.mkdir(taskDir, { recursive: true });
  const historyPath = path.join(taskDir, "history.json");

  const history = (await storage.readJson<Record<string, unknown>[]>(historyPath)) ?? [];
  history.push({ ...entry, timestamp: storage.nowIso() });
  await storage.writeJson(historyPath, history);
}

export async function getHistory(
  projectId: string,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const historyPath = path.join(storage.projectTasksDir(projectId), taskId, "history.json");
  return (await storage.readJson<Record<string, unknown>[]>(historyPath)) ?? [];
}

// --- Terminal Log ---

function terminalsPath(projectId: string, taskId: string): string {
  return path.join(storage.projectTasksDir(projectId), taskId, "terminals.json");
}

export async function saveTerminals(
  projectId: string,
  taskId: string,
  terminals: Record<string, Array<{ role: string; content: string }>>,
): Promise<void> {
  await storage.writeJson(terminalsPath(projectId, taskId), terminals);
}

export async function loadTerminals(
  projectId: string,
  taskId: string,
): Promise<Record<string, Array<{ role: string; content: string }>>> {
  return (
    (await storage.readJson<Record<string, Array<{ role: string; content: string }>>>(
      terminalsPath(projectId, taskId),
    )) ?? {}
  );
}

export async function appendTerminalMessage(
  projectId: string,
  taskId: string,
  agent: string,
  role: string,
  content: string,
): Promise<void> {
  const terminals = await loadTerminals(projectId, taskId);
  if (!terminals[agent]) terminals[agent] = [];
  terminals[agent].push({ role, content });
  await saveTerminals(projectId, taskId, terminals);
}

export async function updateLastTerminalMessage(
  projectId: string,
  taskId: string,
  agent: string,
  content: string,
): Promise<void> {
  const terminals = await loadTerminals(projectId, taskId);
  if (!terminals[agent]) terminals[agent] = [];
  const msgs = terminals[agent];
  if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
    msgs[msgs.length - 1].content = content;
  } else {
    msgs.push({ role: "assistant", content });
  }
  await saveTerminals(projectId, taskId, terminals);
}
