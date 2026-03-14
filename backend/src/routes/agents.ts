/**
 * Agent routes: list agents, get/update config, ad-hoc streaming chat.
 */

import * as storage from "../storage.js";
import { listAgents, getAgentConfig, saveAgentConfig, createRunner, AGENT_NAMES } from "../agents/registry.js";
import type { FastifyInstance } from "fastify";

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  // GET /projects/:projectId/agents
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/agents", async (req, reply) => {
    const project = await storage.readJson(storage.projectJsonPath(req.params.projectId));
    if (!project) return reply.code(404).send({ detail: "Project not found" });
    return listAgents(req.params.projectId);
  });

  // GET /projects/:projectId/agents/:agentName
  app.get<{ Params: { projectId: string; agentName: string } }>(
    "/projects/:projectId/agents/:agentName",
    async (req, reply) => {
      if (!(AGENT_NAMES as readonly string[]).includes(req.params.agentName)) {
        return reply.code(404).send({ detail: `Unknown agent: ${req.params.agentName}` });
      }
      const project = await storage.readJson(storage.projectJsonPath(req.params.projectId));
      if (!project) return reply.code(404).send({ detail: "Project not found" });
      return getAgentConfig(req.params.projectId, req.params.agentName);
    },
  );

  // PUT /projects/:projectId/agents/:agentName
  app.put<{
    Params: { projectId: string; agentName: string };
    Body: { system_prompt?: string; model?: string; display_name?: string };
  }>("/projects/:projectId/agents/:agentName", async (req, reply) => {
    if (!(AGENT_NAMES as readonly string[]).includes(req.params.agentName)) {
      return reply.code(404).send({ detail: `Unknown agent: ${req.params.agentName}` });
    }
    const project = await storage.readJson(storage.projectJsonPath(req.params.projectId));
    if (!project) return reply.code(404).send({ detail: "Project not found" });

    const overrides: Record<string, unknown> = {};
    if (req.body.system_prompt !== undefined) overrides.system_prompt = req.body.system_prompt;
    if (req.body.model !== undefined) overrides.model = req.body.model;
    if (req.body.display_name !== undefined) overrides.display_name = req.body.display_name;

    await saveAgentConfig(req.params.projectId, req.params.agentName, overrides);
    return getAgentConfig(req.params.projectId, req.params.agentName);
  });

  // POST /projects/:projectId/agents/:agentName/chat — streaming text/plain
  app.post<{
    Params: { projectId: string; agentName: string };
    Body: { message: string; context?: string };
  }>("/projects/:projectId/agents/:agentName/chat", async (req, reply) => {
    if (!(AGENT_NAMES as readonly string[]).includes(req.params.agentName)) {
      return reply.code(404).send({ detail: `Unknown agent: ${req.params.agentName}` });
    }
    const project = await storage.readJson(storage.projectJsonPath(req.params.projectId));
    if (!project) return reply.code(404).send({ detail: "Project not found" });

    const runner = await createRunner(req.params.projectId, req.params.agentName);

    reply.raw.writeHead(200, {
      "Content-Type": "text/plain",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });

    try {
      for await (const chunk of runner.stream(req.body.message, req.body.context)) {
        reply.raw.write(chunk);
      }
    } finally {
      reply.raw.end();
    }

    return reply;
  });
}
