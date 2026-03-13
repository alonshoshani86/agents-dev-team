/**
 * File browsing routes for the folder picker UI.
 */

import { existsSync, statSync, readdirSync } from "fs";
import os from "os";
import type { FastifyInstance } from "fastify";

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // GET /browse?path=...
  app.get<{ Querystring: { path?: string } }>("/browse", async (req) => {
    const dirPath = req.query.path ?? os.homedir();
    const p = dirPath;

    if (!existsSync(p) || !statSync(p).isDirectory()) {
      return { path: p, dirs: [], error: "Not a directory" };
    }

    const dirs: Array<{ name: string; path: string }> = [];
    try {
      const entries = readdirSync(p, { withFileTypes: true });
      const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          const fullPath = `${p}/${entry.name}`;
          dirs.push({ name: entry.name, path: fullPath });
        }
      }
    } catch {
      return { path: p, dirs: [], error: "Permission denied" };
    }

    // Get parent (don't go above /)
    const parent = p === "/" ? null : p.split("/").slice(0, -1).join("/") || "/";

    return { path: p, parent, dirs };
  });
}
