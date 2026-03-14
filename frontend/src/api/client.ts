const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    // Include the machine-readable `error` code (if present) in the thrown message
    // so callers can detect specific error types like "scan_expired" reliably.
    const message = err.error ? `${err.error}: ${err.detail || res.statusText}` : (err.detail || res.statusText);
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  // Projects
  listProjects: () => request<any[]>("/projects"),
  getProject: (id: string) => request<any>(`/projects/${id}`),
  createProject: (data: any) =>
    request<any>("/projects", { method: "POST", body: JSON.stringify(data) }),
  updateProject: (id: string, data: any) =>
    request<any>(`/projects/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    request<any>(`/projects/${id}`, { method: "DELETE" }),

  // Config
  getConfig: () => request<any>("/config"),
  updateConfig: (data: any) =>
    request<any>("/config", { method: "PUT", body: JSON.stringify(data) }),
  validateKey: (apiKey: string) =>
    request<{ valid: boolean; error?: string }>("/config/validate-key", {
      method: "POST",
      body: JSON.stringify({ anthropic_api_key: apiKey }),
    }),
  authCli: () =>
    request<{ valid: boolean; error?: string; output?: string }>("/config/auth-cli", {
      method: "POST",
    }),

  // Tasks
  listTasks: (projectId: string) => request<any[]>(`/projects/${projectId}/tasks`),
  getTask: (projectId: string, taskId: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}`),
  createTask: (projectId: string, data: any) =>
    request<any>(`/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(data) }),
  updateTask: (projectId: string, taskId: string, data: any) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTask: (projectId: string, taskId: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}`, { method: "DELETE" }),

  // Pipeline execution
  listPipelines: (projectId: string) => request<any[]>(`/projects/${projectId}/pipelines`),
  runTaskPipeline: (projectId: string, taskId: string, pipelineId: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/run`, {
      method: "POST",
      body: JSON.stringify({ pipeline_id: pipelineId }),
    }),
  pauseTask: (projectId: string, taskId: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/pause`, { method: "POST" }),
  resumeTask: (projectId: string, taskId: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/resume`, { method: "POST" }),
  cancelTask: (projectId: string, taskId: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/cancel`, { method: "POST" }),
  setNextAgent: (projectId: string, taskId: string, agent: string | null) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/next-agent`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    }),
  injectContext: (projectId: string, taskId: string, context: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/inject`, {
      method: "POST",
      body: JSON.stringify({ context }),
    }),
  runAgent: (projectId: string, taskId: string, agent: string, context?: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/run-agent`, {
      method: "POST",
      body: JSON.stringify({ agent, context: context || null }),
    }),
  askAgent: (projectId: string, taskId: string, agent: string, message: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/ask-agent`, {
      method: "POST",
      body: JSON.stringify({ agent, message }),
    }),
  taskStatus: (projectId: string, taskId: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/status`),
  taskHistory: (projectId: string, taskId: string) =>
    request<any[]>(`/projects/${projectId}/tasks/${taskId}/history`),
  taskArtifacts: (projectId: string, taskId: string) =>
    request<any[]>(`/projects/${projectId}/tasks/${taskId}/artifacts`),
  artifactContent: (projectId: string, taskId: string, artifactType: string, run?: string | number) =>
    request<{ artifact_type: string; run: string | null; content: string }>(
      `/projects/${projectId}/tasks/${taskId}/artifacts/${artifactType}/content${run !== undefined ? `?run=${run}` : ""}`
    ),
  artifactRuns: (projectId: string, taskId: string, artifactType: string) =>
    request<{ artifact_type: string; run_count: number; runs: { run: number; agent: string; timestamp: string }[] }>(
      `/projects/${projectId}/tasks/${taskId}/artifacts/${artifactType}/runs`
    ),
  updateArtifact: (projectId: string, taskId: string, artifactType: string, content: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/artifacts/${artifactType}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  artifactContent: (projectId: string, taskId: string, artifactType: string, run?: number | "latest") => {
    const runParam = run !== undefined ? `?run=${run}` : "";
    return request<{ artifact_type: string; run: string | null; content: string }>(
      `/projects/${projectId}/tasks/${taskId}/artifacts/${artifactType}/content${runParam}`
    );
  },
  artifactRuns: (projectId: string, taskId: string, artifactType: string) =>
    request<{ artifact_type: string; run_count: number; runs: { run: number; agent: string; timestamp: string }[] }>(
      `/projects/${projectId}/tasks/${taskId}/artifacts/${artifactType}/runs`
    ),
  taskTerminals: (projectId: string, taskId: string) =>
    request<Record<string, { role: string; content: string }[]>>(`/projects/${projectId}/tasks/${taskId}/terminals`),
  respondPermission: (projectId: string, taskId: string, permissionId: string, behavior: "allow" | "deny", message?: string) =>
    request<any>(`/projects/${projectId}/tasks/${taskId}/permission-response`, {
      method: "POST",
      body: JSON.stringify({ permission_id: permissionId, behavior, message }),
    }),

  // Git
  getGitBranch: (projectId: string) =>
    request<{ branch: string | null }>(`/projects/${projectId}/git-branch`),

  // Agents
  listAgents: (projectId: string) => request<any[]>(`/projects/${projectId}/agents`),

  // Files / Browse
  browseDirs: (path?: string) =>
    request<{ path: string; parent: string | null; dirs: { name: string; path: string }[]; error?: string }>(
      `/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`
    ),

  // Cleanup
  scanUnusedFiles: (projectId: string) =>
    request<import("../types").CleanupScanResult>(`/projects/${projectId}/cleanup/scan`),
  deleteUnusedFiles: (projectId: string, scanId: string, paths: string[]) =>
    request<import("../types").CleanupDeleteResult>(`/projects/${projectId}/cleanup/delete`, {
      method: "POST",
      body: JSON.stringify({ scan_id: scanId, paths }),
    }),
};
