/**
 * Config routes: read/write global config, validate API keys, auth-cli.
 */

import { readFileSync, accessSync, constants as fsConstants } from "fs";
import { execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import { dirname } from "path";
import * as storage from "../storage.js";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

const DEFAULT_CONFIG: Record<string, string> = {
  anthropic_api_key: "",
  default_model: "claude-sonnet-4-6",
  complex_model: "claude-opus-4-6",
  auth_mode: "",
};

/** Synchronous config read — used by AgentRunner at startup. */
export function getConfig(): Record<string, unknown> {
  try {
    const content = readFileSync(storage.configPath(), "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    const env = process.env.ANTHROPIC_API_KEY ?? "";
    return {
      ...DEFAULT_CONFIG,
      ...(env ? { anthropic_api_key: env, auth_mode: "api_key" } : {}),
    };
  }
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length > 12) return key.slice(0, 8) + "..." + key.slice(-4);
  return "***";
}

export function findNpx(): string | null {
  // Use accessSync(X_OK) — checks existence AND executability without reading the binary.
  for (const p of ["/usr/local/bin/npx", "/opt/homebrew/bin/npx"]) {
    try {
      accessSync(p, fsConstants.X_OK);
      return p;
    } catch { /* not found or not executable */ }
  }
  // Fallback: resolve via PATH using `which npx`
  try {
    const result = execFileSync("which", ["npx"], { encoding: "utf-8" }).trim();
    if (result) return result;
    return null;
  } catch {
    return null;
  }
}

function checkCliAvailable(): boolean {
  return findNpx() !== null;
}

function maskedConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...config,
    anthropic_api_key: maskKey(String(config.anthropic_api_key ?? "")),
    has_api_key: Boolean(config.anthropic_api_key),
    cli_available: checkCliAvailable(),
    authenticated: Boolean(config.auth_mode),
  };
}

async function ensureConfig(): Promise<Record<string, unknown>> {
  let config = await storage.readJson<Record<string, unknown>>(storage.configPath());
  if (!config) {
    config = { ...DEFAULT_CONFIG };
    const env = process.env.ANTHROPIC_API_KEY ?? "";
    if (env) {
      config.anthropic_api_key = env;
      config.auth_mode = "api_key";
    }
    await storage.writeJson(storage.configPath(), config);
  }
  return config;
}

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  // GET /config
  app.get("/config", async () => {
    const config = await ensureConfig();
    return maskedConfig(config);
  });

  // PUT /config
  app.put<{ Body: Record<string, unknown> }>("/config", async (req) => {
    const config = await ensureConfig();
    const allowed = ["anthropic_api_key", "default_model", "complex_model", "auth_mode"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        config[key] = req.body[key];
      }
    }
    await storage.writeJson(storage.configPath(), config);
    return maskedConfig(config);
  });

  // POST /config/validate-key
  app.post<{ Body: { anthropic_api_key?: string; api_key?: string } }>("/config/validate-key", async (req) => {
    const key = req.body.anthropic_api_key ?? req.body.api_key;
    if (!key) return { valid: false, error: "No API key provided" };

    try {
      // Dynamically import Anthropic SDK for validation
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: key });
      await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });

      const config = await ensureConfig();
      config.anthropic_api_key = key;
      config.auth_mode = "api_key";
      await storage.writeJson(storage.configPath(), config);
      return { valid: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("authentication") || msg.includes("API key") || msg.includes("401")) {
        return { valid: false, error: "Invalid API key" };
      }
      return { valid: false, error: msg };
    }
  });

  // POST /config/auth-cli
  app.post("/config/auth-cli", async () => {
    // Use findNpx() which checks hardcoded paths first, then falls back to PATH via `which npx`
    const npx = findNpx() ?? "npx";

    // Prepend the current node binary's directory so the child process uses the same
    // Node version as the backend (not an older system node like /usr/local/bin/node v18.)
    const nodeBinDir = dirname(process.execPath);
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${nodeBinDir}:/opt/homebrew/bin:/bin:/usr/bin:${process.env.PATH ?? ""}`,
    };
    // Remove SDK env vars that interfere with fresh claude-code invocations
    delete env["CLAUDECODE"];
    delete env["CLAUDE_CODE_ENTRYPOINT"];
    delete env["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"];
    delete env["CLAUDE_AGENT_SDK_VERSION"];
    // Remove OAuth/JWT tokens that cause JWT algorithm errors in child claude-code process
    delete env["ANTHROPIC_ACCESS_TOKEN"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    delete env["ANTHROPIC_TOKEN"];

    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(npx, ["-y", "@anthropic-ai/claude-code", "--print", "say hi in 3 words"], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("timeout"));
        }, 30_000);

        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(stderr.slice(0, 200) || `Exit code ${code}`));
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const config = await ensureConfig();
      config.auth_mode = "cli";
      await storage.writeJson(storage.configPath(), config);
      return { valid: true, output: result.stdout.trim().slice(0, 100) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "timeout") {
        return { valid: false, error: "Timed out. Make sure you're logged into Claude Code." };
      }
      return { valid: false, error: msg.slice(0, 200) || "Claude Code CLI failed" };
    }
  });

  // POST /config/logout
  app.post("/config/logout", async () => {
    const config = await ensureConfig();
    config.auth_mode = "";
    config.anthropic_api_key = "";
    await storage.writeJson(storage.configPath(), config);
    // Clear env var so the server doesn't auto-re-auth
    delete process.env.ANTHROPIC_API_KEY;
    return { ok: true };
  });
}
