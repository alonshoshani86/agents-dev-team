/**
 * DevTeam Agent Platform — Node.js/TypeScript backend
 * Replaces main.py (FastAPI) with Fastify.
 */

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebSocket from "@fastify/websocket";

import { registerProjectRoutes } from "./routes/projects.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerWebSocketRoutes, broadcast } from "./routes/websocket.js";

const PORT = parseInt(process.env.PORT ?? "8000", 10);

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport: process.stdout.isTTY
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    },
  });

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
