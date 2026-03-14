/**
 * DevTeam Agent Platform — Node.js/TypeScript backend
 * Replaces main.py (FastAPI) with Fastify.
 */

// Ensure /usr/local/bin and /opt/homebrew/bin are in PATH for child processes (npx, node, claude)
const extraPaths = ["/usr/local/bin", "/opt/homebrew/bin"];
const currentPath = process.env.PATH ?? "";
const missingPaths = extraPaths.filter((p) => !currentPath.includes(p));
if (missingPaths.length > 0) {
  process.env.PATH = [...missingPaths, currentPath].join(":");
}

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebSocket from "@fastify/websocket";
import path from "path";

import { registerProjectRoutes } from "./routes/projects.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerWebSocketRoutes, broadcast } from "./routes/websocket.js";
import * as storage from "./storage.js";

const PORT = parseInt(process.env.PORT ?? "8001", 10);

/**
 * On startup, mark any tasks that were left in "running" state as "interrupted".
 * This handles the case where the server was restarted while tasks were running.
 */
async function recoverInterruptedTasks(): Promise<void> {
  try {
    const projectIds = await storage.listDirs(storage.projectsDir());
    for (const projectId of projectIds) {
      const tasksDir = storage.projectTasksDir(projectId);
      const taskIds = await storage.listDirs(tasksDir);
      for (const taskId of taskIds) {
        const taskPath = path.join(tasksDir, taskId, "task.json");
        const task = await storage.readJson<Record<string, unknown>>(taskPath);
        const interruptibleStates = ["running", "choosing_agent", "waiting_input"];
        const prevStatus = String(task?.status ?? "");
        if (task && interruptibleStates.includes(prevStatus)) {
          task.status = "error";
          task.paused = false;
          task.error_message = `Task was interrupted (server restarted while status was '${prevStatus}'). You can re-run an agent to continue.`;
          task.updated_at = storage.nowIso();
          await storage.writeJson(taskPath, task);
          console.log(`[startup] Marked task ${taskId} as error/interrupted (was '${prevStatus}' at last shutdown)`);
        }
      }
    }
  } catch (err) {
    console.error("[startup] Failed to recover interrupted tasks:", err);
  }
}

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport: process.stdout.isTTY
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    },
  });

  // --- Startup recovery: mark interrupted tasks ---
  await recoverInterruptedTasks();

  // --- CORS ---
  await app.register(fastifyCors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  // --- WebSocket plugin (must be registered before WS routes) ---
  await app.register(fastifyWebSocket);

  // --- Health ---
  app.get("/health", async () => ({ status: "ok" }));

  // --- Routes ---
  await registerProjectRoutes(app);
  await registerConfigRoutes(app);
  await registerAgentRoutes(app);
  await registerTaskRoutes(app, broadcast);
  await app.register(
    async (instance) => {
      await registerFileRoutes(instance);
    },
    { prefix: "/files" },
  );
  await registerWebSocketRoutes(app);

  // --- Start ---
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`\n🚀 DevTeam backend running on http://localhost:${PORT}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
