/**
 * Pipeline definitions: load, list, and manage pipeline templates.
 */

import path from "path";
import * as storage from "../storage.js";

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  start_agent: string;
}

const DEFAULT_PIPELINES: Record<string, Pipeline> = {
  "full-feature": {
    id: "full-feature",
    name: "Full Feature",
    description:
      "Start with Product spec — agents route dynamically through architect, dev, test, uxui as needed",
    start_agent: "product",
  },
  "quick-fix": {
    id: "quick-fix",
    name: "Quick Fix",
    description: "Start with Dev — goes straight to implementation, then test verifies",
    start_agent: "dev",
  },
  "spec-only": {
    id: "spec-only",
    name: "Spec Only",
    description: "Start with Product spec — agent decides if architect is needed",
    start_agent: "product",
  },
  "dev-test": {
    id: "dev-test",
    name: "Dev + Test",
    description: "Start with Dev — implementation then testing",
    start_agent: "dev",
  },
};

export async function getPipeline(projectId: string, pipelineId: string): Promise<Pipeline | null> {
  // Check project-specific first
  const projectPath = path.join(storage.projectPipelinesDir(projectId), `${pipelineId}.json`);
  const projectPipeline = await storage.readJson<Pipeline>(projectPath);
  if (projectPipeline) return projectPipeline;

  // Fall back to defaults
  return DEFAULT_PIPELINES[pipelineId] ?? null;
}

export async function listPipelines(projectId: string): Promise<Pipeline[]> {
  const pipelines: Pipeline[] = [...Object.values(DEFAULT_PIPELINES)];

  const pipelinesDir = storage.projectPipelinesDir(projectId);
  try {
    const { readdir } = await import("fs/promises");
    const files = await readdir(pipelinesDir);
    const seenIds = new Set(pipelines.map((p) => p.id));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const p = await storage.readJson<Pipeline>(path.join(pipelinesDir, file));
      if (p?.id && !seenIds.has(p.id)) {
        pipelines.push(p);
      }
    }
  } catch {
    // directory doesn't exist
  }

  return pipelines;
}

export async function savePipeline(projectId: string, pipeline: Pipeline): Promise<Pipeline> {
  if (!pipeline.id) pipeline.id = storage.generateId();
  const filePath = path.join(storage.projectPipelinesDir(projectId), `${pipeline.id}.json`);
  await storage.writeJson(filePath, pipeline);
  return pipeline;
}
